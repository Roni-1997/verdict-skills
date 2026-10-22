"""Durable, non-retrying order execution; SDK implementations live at the boundary."""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import time
from dataclasses import asdict, dataclass, replace
from decimal import Decimal
from typing import Callable, Protocol

D = Decimal
REPO = Path(__file__).resolve().parents[2]
TERMINAL = {"filled", "canceled", "expired", "rejected"}


class BrokerError(Exception):
    """A deliberately public error; never include transport exceptions or credentials."""


def json_load(raw: str):
    def unique(pairs):
        result = {}
        for k, v in pairs:
            if k in result:
                raise BrokerError("Duplicate JSON key")
            result[k] = v
        return result
    if len(raw.encode()) > 1_048_576:
        raise BrokerError("JSON exceeds 1 MiB")
    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(BrokerError("Non-finite JSON number")))
    except (ValueError, TypeError) as e:
        raise BrokerError("Invalid JSON") from e


def node_call(args: list[str], env: dict[str, str] | None = None):
    # Explicit allowlist: the validation/public-data child never inherits SDK secrets.
    node = os.environ.get("VERDICT_NODE_BINARY") or shutil.which("node")
    if not node:
        raise BrokerError("Node 22 required; set VERDICT_NODE_BINARY")
    child_env = {"PATH": os.defpath, **(env or {})}
    try:
        result = subprocess.run([node, str(REPO / "packages/cli/dist/bin.js"), *args], env=child_env,
                                capture_output=True, text=True, timeout=40, check=False)
        if result.returncode:
            raise BrokerError("Proposal/public-data check failed; rebuild the kit and verify market inputs")
        return json_load(result.stdout)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise BrokerError("Kit subprocess unavailable or timed out") from e


def load_proposal(path: Path):
    if not path.is_file() or path.stat().st_size > 1_048_576:
        raise BrokerError("Expected proposal JSON file of at most 1 MiB")
    parsed = json_load(path.read_text())
    return node_call(["execution", "validate", "--input", json.dumps(parsed, ensure_ascii=False)])


def identity(proposal, index: int) -> str:
    return hashlib.sha256(f"{proposal['digest']}:{index}".encode()).hexdigest()


def account_key(leg) -> str:
    return hashlib.sha256(f"{leg['venue']}:{leg['network']}:{leg['account']}".encode()).hexdigest()


@dataclass(frozen=True)
class Preflight:
    inventory: str
    available_usdc: str
    required_fee: str
    native: dict
    checked_at: float
    valid_until: float | None = None


@dataclass(frozen=True)
class Receipt:
    # Only public identifiers, never native signed payloads, signatures or auth.
    order_id: str | None = None
    transaction_id: str | None = None
    rejected: bool = False


@dataclass(frozen=True)
class Observation:
    state: str  # unfamiliar statuses normalize to unknown
    filled: str
    inventory: str
    settled: bool


class Adapter(Protocol):
    def preflight(self, leg, client_id: str) -> Preflight: ...
    def submit(self, leg, client_id: str, preflight: Preflight) -> Receipt: ...
    def observe(self, leg, client_id: str, receipt: Receipt) -> Observation: ...
    def cancel(self, leg, client_id: str, receipt: Receipt) -> None: ...
    def close(self) -> None: ...


class Store:
    def __init__(self, root: Path):
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        s = root.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
            raise BrokerError("Broker state directory must be owned by you, mode 0700, and not a symlink")
        self.root = root

    def _open(self, name, flags):
        fd = os.open(self.root / name, flags | os.O_NOFOLLOW, 0o600)
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
            os.close(fd)
            raise BrokerError("Unsafe broker state file permissions")
        return fd

    @contextlib.contextmanager
    def locked(self, legs):
        held = []
        try:
            for key in sorted({account_key(l) for l in legs}):
                fd = self._open(f"account-{key}.lock", os.O_CREAT | os.O_RDWR)
                held.append(fd)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as e:
                    raise BrokerError("Account is busy in another local broker process") from e
            yield
        finally:
            for fd in reversed(held):
                os.close(fd)

    def read(self, digest):
        name = f"{digest}.jsonl"
        try:
            fd = self._open(name, os.O_RDONLY)
        except FileNotFoundError:
            return []
        with os.fdopen(fd) as f:
            raw = f.read(16_777_217)
        if len(raw) > 16_777_216 or (raw and not raw.endswith("\n")):
            raise BrokerError("Journal truncated or oversized; resolve manually, never resubmit")
        events = []
        for line in raw.splitlines():
            event = json_load(line)
            if not isinstance(event, dict) or event.get("sequence") != len(events) or event.get("digest") != digest:
                raise BrokerError("Journal corrupt; never resubmit")
            events.append(event)
        return events

    def append(self, digest, event):
        events = self.read(digest)
        row = {**event, "sequence": len(events), "digest": digest, "at": time.time()}
        encoded = (json.dumps(row, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
        fd = self._open(f"{digest}.jsonl", os.O_CREAT | os.O_APPEND | os.O_WRONLY)
        with os.fdopen(fd, "ab", buffering=0) as f:
            offset = 0
            while offset < len(encoded):
                count = f.write(encoded[offset:])
                if not count:
                    raise BrokerError("Journal write failed")
                offset += count
            os.fsync(f.fileno())
        directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


class Broker:
    def __init__(self, store: Store, factory: Callable[[dict], Adapter], *, clock=time.time,
                 sleep=time.sleep, poll_seconds=15):
        self.store, self.factory, self.clock, self.sleep = store, factory, clock, sleep
        self.poll_seconds = poll_seconds

    def _valid_now(self, proposal):
        p = proposal["payload"]
        now = self.clock() * 1000
        if p["createdAt"] > now + 5000 or p["expiresAt"] <= now:
            raise BrokerError("Proposal expired or created in the future; prepare and confirm a new proposal")

    def _preflight(self, proposal, index, adapter):
        self._valid_now(proposal)
        leg = proposal["payload"]["legs"][index]
        result = adapter.preflight(leg, identity(proposal, index))
        self._valid_now(proposal)
        if self.clock() - result.checked_at > 5 or result.checked_at > self.clock() + 1:
            raise BrokerError("Preflight is stale; no order sent")
        if D(result.required_fee) > D(leg["feeReserveUSDC"]):
            raise BrokerError("Fresh fee bound exceeds approved fee reserve")
        required = (D(leg["shares"]) * D(leg["limitPrice"]) if leg["action"] == "buy" else D(0)) + D(leg["feeReserveUSDC"])
        if D(result.available_usdc) < required:
            raise BrokerError("Insufficient available collateral including reserved fees")
        if leg["action"] == "sell" and D(result.inventory) < D(leg["shares"]):
            raise BrokerError("Sell exceeds available holdings; naked sells are disabled")
        return replace(result, valid_until=min(proposal["payload"]["expiresAt"] / 1000, result.checked_at + 5))

    def _status(self, proposal, adapters):
        events = self.store.read(proposal["digest"])
        legs = []
        for i, (leg, adapter) in enumerate(zip(proposal["payload"]["legs"], adapters)):
            attempt = next((e for e in events if e.get("type") == "attempt_started" and e.get("leg") == i), None)
            if attempt is None:
                legs.append({"leg": i, "state": "not_attempted", "filled": "0", "netInventoryChange": "0", "settled": False})
                continue
            item = next((e for e in reversed(events) if e.get("type") == "receipt" and e.get("leg") == i), None)
            receipt = Receipt(**item["receipt"]) if item else Receipt()
            try:
                observation = adapter.observe(leg, identity(proposal, i), receipt)
                if observation.state not in TERMINAL | {"open", "pending", "unknown"}:
                    raise BrokerError("Unrecognized normalized order state")
                change = D(observation.inventory) - D(attempt["inventory_before"])
                delta = change if leg["action"] == "buy" else -change
                row = {"leg": i, "state": observation.state, "filled": observation.filled,
                       "netInventoryChange": str(delta), "settled": observation.settled}
            except Exception:
                row = {"leg": i, "state": "unknown", "filled": None, "netInventoryChange": None, "settled": False}
            legs.append(row)
        full = lambda row, leg: row["state"] in TERMINAL and row["settled"] and row["filled"] is not None and D(row["filled"]) == D(leg["shares"]) and row["netInventoryChange"] is not None and D(row["netInventoryChange"]) == D(leg["shares"])
        complete = all(full(r, l) for r, l in zip(legs, proposal["payload"]["legs"]))
        return {"digest": proposal["digest"], "state": "complete" if complete else "needs_reconciliation",
                "legs": legs, "automaticRetry": False,
                "note": "Non-atomic. Inventory changes assume dedicated accounts with no external writers. Missing orders are unknown, never proof of rejection. No realized P&L claim."}

    @contextlib.contextmanager
    def _session(self, proposal):
        # Revalidate even for trusted API callers; a forged digest cannot bypass the CLI schema.
        proposal = node_call(["execution", "validate", "--input", json.dumps(proposal, ensure_ascii=False)])
        with self.store.locked(proposal["payload"]["legs"]):
            adapters = []
            try:
                for leg in proposal["payload"]["legs"]:
                    adapters.append(self.factory(leg))
                yield proposal, adapters
            finally:
                for adapter in adapters:
                    with contextlib.suppress(Exception):
                        adapter.close()

    def status(self, proposal):
        with self._session(proposal) as (p, adapters):
            return self._status(p, adapters)

    def submit(self, proposal, approve: Callable[[dict], bool]):
        with self._session(proposal) as (p, adapters):
            events = self.store.read(p["digest"])
            if any(e.get("type") == "attempt_started" for e in events):
                return self._status(p, adapters)
            self._valid_now(p)
            review = node_call(["execution", "review", "--input", json.dumps(p, ensure_ascii=False)])
            if not approve(review):
                raise BrokerError("Operator did not approve; no order sent")
            # Detect known second-leg failure before acquiring exposed first-leg inventory.
            # Discard these snapshots and refresh each leg again immediately before its send.
            try:
                for i, adapter in enumerate(adapters):
                    self._preflight(p, i, adapter)
            except Exception:
                raise BrokerError("Initial preflight blocked; every leg must be viable before any order is sent") from None
            self.store.append(p["digest"], {"type": "approved", "proposal": p})
            for i, (leg, adapter) in enumerate(zip(p["payload"]["legs"], adapters)):
                try:
                    preflight = self._preflight(p, i, adapter)
                except Exception:
                    if i == 0:
                        raise BrokerError("Preflight blocked before submission; check account, market, fees, balance and fresh depth") from None
                    return {**self._status(p, adapters), "blocked": "Second-leg preflight changed; exposed inventory requires a new separately confirmed recovery proposal"}
                # Fence BEFORE signing or transport. A crash after this point is an unknown send.
                self.store.append(p["digest"], {"type": "attempt_started", "leg": i,
                                               "client_id": identity(p, i), "inventory_before": preflight.inventory})
                try:
                    self._valid_now(p)
                    if self.clock() - preflight.checked_at > 5:
                        raise BrokerError("Preflight expired before send")
                    receipt = adapter.submit(leg, identity(p, i), preflight)
                    self.store.append(p["digest"], {"type": "receipt", "leg": i, "receipt": asdict(receipt)})
                except Exception:
                    # Never expose SDK errors: they may include authentication or signed payloads.
                    return self._status(p, adapters)
                deadline = self.clock() + self.poll_seconds
                while True:
                    status = self._status(p, adapters)
                    row = status["legs"][i]
                    complete = (row["state"] in TERMINAL and row["settled"] and row["filled"] is not None
                                and D(row["filled"]) == D(leg["shares"])
                                and row["netInventoryChange"] is not None and D(row["netInventoryChange"]) == D(leg["shares"]))
                    if complete:
                        break
                    if row["state"] in TERMINAL or self.clock() >= deadline:
                        return status
                    self.sleep(0.5)
            return self._status(p, adapters)

    def cancel(self, proposal, index, approve: Callable[[dict], bool]):
        with self._session(proposal) as (p, adapters):
            if type(index) is not int or not 0 <= index < len(adapters):
                raise BrokerError("Invalid leg index")
            events = self.store.read(p["digest"])
            if not any(e.get("type") == "attempt_started" and e.get("leg") == index for e in events):
                raise BrokerError("Cannot cancel a leg that was never attempted")
            item = next((e for e in reversed(events) if e.get("type") == "receipt" and e.get("leg") == index), None)
            receipt = Receipt(**item["receipt"]) if item else Receipt()
            leg = p["payload"]["legs"][index]
            if not approve({"digest": p["digest"], "confirmation": [f"Cancel ONLY leg {index}: {leg['venue']} {leg['network']} account {leg['account']}, client identity {identity(p, index)}. Cancellation can race fills; check status afterward."]}):
                raise BrokerError("Cancellation not approved")
            self.store.append(p["digest"], {"type": "cancel_started", "leg": index})
            try:
                adapters[index].cancel(leg, identity(p, index), receipt)
            except Exception as e:
                raise BrokerError("Cancellation outcome unknown; reconcile before taking further action") from e
            return self._status(p, adapters)
