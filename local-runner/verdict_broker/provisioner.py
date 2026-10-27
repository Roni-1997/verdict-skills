"""Private testnet enrollment through finite local or authenticated hosted ports.

The public runtime receives account/profile references, never wrapping credentials,
native account keys, private database access or selectable signer methods.
"""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import socket
import sqlite3
import stat
import sys
import time
import uuid

from .authority import (_hash, _id, _money, consumer_message, consumer_scope,
                        inspect_grant, issue_consumer_grant, recover_owner, revoke_grant)
from .core import Broker, BrokerError, Store, json_load
from .diagnostics import log_failure_location
from .workers import start_private_worker, stop_private_worker

HOST = "https://testnet.zklighter.elliot.ai"
MAX_SAFE = 9_007_199_254_740_991


def address(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", value) or value.lower() == "0x" + "0" * 40:
        raise BrokerError("Expected a nonzero EVM owner")
    return value.lower()


def integer(value, lower=0, upper=MAX_SAFE):
    if type(value) is not int or not lower <= value <= upper:
        raise BrokerError("Invalid private provisioning integer")
    return value


def key_hex(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:0x)?[0-9a-fA-F]{80}", value):
        raise BrokerError("Invalid native Lighter public key")
    return "0x" + value.removeprefix("0x").lower()


def empty_key(value):
    return key_hex(value) == "0x" + "0" * 80


def funding_message(record):
    return ("Request Verdict Lighter testnet funds\nEnrollment: " + record["id"] + "\nOwner: " + record["owner"]
            + "\nRevision: " + record["revision"] + "\nExpires: " + str(record["expiresAt"])
            + "\nThis requests test funds only.")


class Vault:
    """One encrypted row per owner. AAD binds ciphertext to its immutable subject."""
    def __init__(self, root, wrapping_key_file):
        from Crypto.Cipher import AES
        self.root = Store(Path(root)).root
        fd = os.open(wrapping_key_file, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            mode = os.fstat(fd)
            if not stat.S_ISREG(mode.st_mode) or mode.st_uid != os.getuid() or mode.st_mode & 0o077:
                raise BrokerError("Wrapping credential must be private owner-only regular file")
            key = os.read(fd, 33)
        finally:
            os.close(fd)
        if len(key) != 32:
            raise BrokerError("Wrapping credential must be exactly 32 bytes")
        self.key, self.AES = key, AES
        path = self.root / "enrollments.sqlite"
        if path.exists() and (path.is_symlink() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077):
            raise BrokerError("Unsafe enrollment database")
        self.db = sqlite3.connect(path, timeout=3)
        os.chmod(path, 0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS enrollments(subject TEXT PRIMARY KEY, owner TEXT UNIQUE NOT NULL, id TEXT UNIQUE NOT NULL, body BLOB NOT NULL)")
        self.db.commit()

    def read(self, subject):
        row = self.db.execute("SELECT id,body FROM enrollments WHERE subject=?", (subject,)).fetchone()
        if row is None:
            return None
        try:
            raw = bytes(row[1])
            cipher = self.AES.new(self.key, self.AES.MODE_GCM, nonce=raw[:12])
            cipher.update((subject + "\0" + row[0]).encode())
            result = json_load(cipher.decrypt_and_verify(raw[12:-16], raw[-16:]).decode())
            if result["subject"] != subject or result["id"] != row[0]:
                raise ValueError
            return result
        except Exception:
            raise BrokerError("Enrollment vault authentication failed; no authority restored") from None

    def save(self, record, *, expected_version=None):
        if expected_version is not None:
            raise BrokerError("Local vault is owned by its single supervisor, not a PostgreSQL version")
        nonce = os.urandom(12)
        raw = json.dumps(record, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode()
        cipher = self.AES.new(self.key, self.AES.MODE_GCM, nonce=nonce)
        cipher.update((record["subject"] + "\0" + record["id"]).encode())
        encrypted, tag = cipher.encrypt_and_digest(raw)
        sealed = nonce + encrypted + tag
        try:
            with self.db:
                self.db.execute("INSERT INTO enrollments(subject,owner,id,body) VALUES(?,?,?,?) ON CONFLICT(subject) DO UPDATE SET body=excluded.body",
                                (record["subject"], record["owner"], record["id"], sealed))
        except sqlite3.IntegrityError:
            raise BrokerError("This venue owner already belongs to a different identity") from None
        return record

    @contextlib.contextmanager
    def locked(self, subject):
        # Local service owns a lifetime exclusive supervisor lock and serial control loop.
        yield

    def count(self):
        return self.db.execute("SELECT count(*) FROM enrollments").fetchone()[0]

    def close(self):
        self.db.close()


def _native_process(pipe, operation, data, transport_check=False):
    """One key/account per process; no shared native client map or env mutation."""
    logging.disable(logging.DEBUG)
    try:
        import lighter
        from lighter.signer_client import decode_and_free
        if operation == "generate":
            private, public, error = lighter.create_api_key()
            if error:
                raise BrokerError("Native key generation failed")
            pipe.send({"privateKey": private, "publicKey": key_hex(public)})
            return
        async def run():
            client = lighter.SignerClient(url=HOST, account_index=data["account"], api_private_keys={data["apiKeyIndex"]: data["privateKey"]}, chain_id=300)
            try:
                if operation == "registration":
                    result = client.signer.SignChangePubKey(key_hex(data["publicKey"]).encode(), 0,
                                                            data["nonce"], data["apiKeyIndex"], data["account"])
                    decoded = {name: decode_and_free(getattr(result, name)) for name in ("err", "txInfo", "txHash", "messageToSign")}
                    if decoded["err"] or not decoded["messageToSign"] or not decoded["txInfo"]:
                        raise BrokerError("Native registration preparation failed")
                    return {"txType": result.txType, "txInfo": decoded["txInfo"], "txHash": decoded["txHash"], "message": decoded["messageToSign"]}
                if operation == "check":
                    return {"ready": client.check_client() is None}
                if operation == "send":
                    if transport_check:
                        pipe.send({"transport_check": True})
                        if not pipe.poll(5) or pipe.recv() is not True:
                            raise BrokerError("Private enrollment lock was lost before transport")
                    result = await client.send_tx(tx_type=data["txType"], tx_info=data["txInfo"])
                    return {"accepted": result.code == 200}
                raise BrokerError("Unknown private native operation")
            finally:
                await client.close()
        pipe.send(asyncio.run(run()))
    except Exception as error:
        log_failure_location(error)
        pipe.send({"error": "Private native operation unavailable"})
    finally:
        pipe.close()


def _native_child(pipe, operation, data, transport_check):
    # This runs only in the new process. Provider credentials and other accounts
    # must never become native-client ambient authority.
    allowed = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "VERDICT_NODE_BINARY") if k in os.environ}
    os.environ.clear()
    os.environ.update(allowed)
    _native_process(pipe, operation, data, transport_check)


def native_call(operation, data, *, before_transport=None):
    parent, process = start_private_worker({"kind": "native", "operation": operation, "data": data,
                                            "transport_check": before_transport is not None})
    try:
        if not parent.poll(25):
            raise BrokerError("Native operation timed out; reconcile original enrollment")
        result = parent.recv()
        if result == {"transport_check": True}:
            if before_transport is None or operation != "send":
                raise BrokerError("Unexpected private native transport request")
            before_transport()
            parent.send(True)
            if not parent.poll(25):
                raise BrokerError("Native send unresolved; reconcile original enrollment")
            result = parent.recv()
        if "error" in result:
            raise BrokerError(result["error"])
        return result
    finally:
        parent.close()
        stop_private_worker(process)


class TestnetVenue:
    def __init__(self, native=native_call, *, transport_guard=None):
        import requests
        self.http = requests.Session()
        self.http.trust_env = False
        self.native = native
        self.transport_guard = transport_guard

    def get(self, path, **params):
        result = self.http.get(HOST + "/api/v1/" + path, params=params, timeout=15, allow_redirects=False)
        body = result.json()
        if not isinstance(body, dict) or type(body.get("code")) is not int:
            raise BrokerError("Venue returned an invalid response")
        return body

    def account(self, owner):
        result = self.get("accountsByL1Address", l1_address=owner)
        if result["code"] == 21100:
            return None
        if result["code"] != 200:
            raise BrokerError("Venue account lookup unavailable")
        accounts = [a for a in result.get("sub_accounts", []) if type(a.get("account_type")) is int and a["account_type"] == 0]
        if len(accounts) != 1:
            raise BrokerError("Expected one venue master account")
        index = integer(accounts[0].get("index"))
        self.verify_owner(index, owner)
        return index

    def verify_owner(self, index, owner):
        self._owned_account(index, owner)

    def _owned_account(self, index, owner):
        result = self.get("account", by="index", value=str(index))
        accounts = result.get("accounts", [])
        if result["code"] != 200 or len(accounts) != 1 or type(accounts[0].get("index")) is not int or accounts[0]["index"] != index or address(accounts[0].get("l1_address")) != owner:
            raise BrokerError("Fresh venue account ownership mismatch")
        return accounts[0]

    def funding_required(self, index, owner):
        # A previously created account may have no collateral for ChangePubKey.
        # This read offers a signature review only; it never calls the faucet.
        row = self._owned_account(index, owner)
        balances = []
        for field in ("available_balance", "collateral"):
            value = row.get(field)
            if not isinstance(value, str) or len(value) > 80 or not re.fullmatch(r"-?\d+(?:\.\d+)?", value):
                raise BrokerError("Fresh venue collateral is unavailable")
            balances.append(_money(value) if not value.startswith("-") else -_money(value[1:]))
        return any(balance <= 0 for balance in balances)

    def keys(self, index):
        result = self.get("apikeys", account_index=index, api_key_index=255)
        if result["code"] != 200 or not isinstance(result.get("api_keys"), list):
            raise BrokerError("Venue API keys unavailable")
        keys = {}
        for row in result["api_keys"]:
            slot = integer(row.get("api_key_index"), 0, 254)
            if slot in keys or integer(row.get("account_index")) != index:
                raise BrokerError("Malformed venue key identity")
            keys[slot] = key_hex(row.get("public_key"))
        return keys

    def nonce(self, index, slot):
        result = self.get("nextNonce", account_index=index, api_key_index=slot)
        if result["code"] != 200:
            raise BrokerError("Venue nonce unavailable")
        return integer(result.get("nonce"))

    def faucet(self, owner):
        # Explicit owner-signed control command only; never callable from reads.
        for transfer in ("true", "false"):
            if self.transport_guard is not None:
                self.transport_guard()
            if self.get("faucet", l1_address=owner, do_l1_transfer=transfer)["code"] != 200:
                raise BrokerError("Testnet faucet unavailable; check original account")

    def generate(self):
        return self.native("generate", {})

    def registration(self, record):
        return self.native("registration", record)

    def send(self, record, signature):
        tx = json_load(record["txInfo"])
        tx["L1Sig"] = signature
        data = {**record, "txInfo": json.dumps(tx, separators=(",", ":"))}
        if self.transport_guard is not None:
            return self.native("send", data, before_transport=self.transport_guard)
        return self.native("send", data)

    def ready(self, record):
        return self.native("check", record)["ready"] is True

    def close(self):
        self.http.close()


def _broker_worker(socket_path, state_path, grant_id, target, private_key, ready_pipe):
    if sys.platform == "linux":
        import ctypes
        import signal
        original_parent = os.getppid()
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM) != 0 or os.getppid() != original_parent or original_parent == 1:
            raise BrokerError("Cannot bind private worker lifetime to supervisor")
    from .adapters import Lighter
    from .authority import PolicyAuthority
    from .rpc import serve_local
    def factory(leg):
        if any(leg.get(k) != target[k] for k in ("venue", "network", "account", "apiKeyIndex")):
            raise BrokerError("Private worker cannot select another account or key")
        return Lighter(leg, api_private_key=private_key)
    try:
        store = Store(Path(state_path))
        broker = Broker(store, factory, authority=PolicyAuthority(store, grant_id))
        # Readiness is only process startup, not funded venue acceptance.
        ready_pipe.send(True)
        ready_pipe.close()
        serve_local(Path(socket_path), broker)
    except Exception:
        with contextlib.suppress(Exception):
            ready_pipe.send(False)
        raise


class Workers:
    def __init__(self, root, socket_dir):
        self.root, self.socket_dir = Path(root), Store(Path(socket_dir)).root
        self.children = {}

    def ensure(self, record):
        binding = record["binding"]
        child = self.children.get(binding["id"])
        if child is not None and child.is_alive():
            return
        path = Path(binding["execution"]["socketPath"])
        # Only this private supervisor owns these UUID paths; public container cannot unlink directories.
        if path.exists():
            mode = path.lstat()
            if not stat.S_ISSOCK(mode.st_mode) or mode.st_uid != os.getuid():
                raise BrokerError("Unsafe private worker socket")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.2)
                try:
                    probe.connect(str(path))
                except ConnectionRefusedError:
                    pass
                else:
                    raise BrokerError("Original private worker is still running; no replacement started")
            path.unlink()
        parent, ready = multiprocessing.get_context("spawn").Pipe(duplex=False)
        context = multiprocessing.get_context("spawn")
        child = context.Process(target=_broker_worker, args=(str(path), str(self.root / record["id"]), binding["grantId"],
                                binding["accounts"][0], record["privateKey"], ready), daemon=True)
        child.start()
        ready.close()
        try:
            if not parent.poll(10) or parent.recv() is not True:
                raise BrokerError("Private broker worker unavailable")
            deadline = time.monotonic() + 5
            while not path.exists() and child.is_alive() and time.monotonic() < deadline:
                time.sleep(0.01)
            if not path.exists():
                raise BrokerError("Private broker socket unavailable")
            self.children[binding["id"]] = child
        finally:
            parent.close()

    def close(self):
        for child in self.children.values():
            if child.is_alive():
                child.terminate()
            child.join(timeout=3)


class Provisioner:
    def __init__(self, config, *, venue=None, workers=None, clock=time.time, vault=None, store_factory=None):
        common = {"origin", "mode", "creators", "maxOrderDebitUSDC", "maxDebitUSDC", "maxOrders", "grantTtlSeconds"}
        runtime = config.get("runtime", "local_socket") if isinstance(config, dict) else None
        if runtime not in {"local_socket", "hosted_signer"}:
            raise BrokerError("Private execution runtime must be explicit")
        expected = common | ({"stateDir", "socketDir", "wrappingKeyFile"} if runtime == "local_socket" else {"runtime"})
        if isinstance(config, dict) and "runtime" in config:
            expected.add("runtime")
        if not isinstance(config, dict) or set(config) != expected:
            raise BrokerError("Invalid private provisioner configuration")
        self.config, self.clock, self.runtime = config, clock, runtime
        # Reuse the independently strict scope parser for operator settings.
        consumer_scope({"kind": "consumer_lighter", "version": 1, "ownerWallet": "0x" + "1" * 40, "network": "testnet", "account": 1,
                        "apiKeyIndex": 5, "creators": config["creators"], "mode": config["mode"], "maxOrderDebitUSDC": config["maxOrderDebitUSDC"],
                        "origin": config["origin"], "enrollmentId": str(uuid.uuid4()), "epoch": 0})
        if _money(config["maxOrderDebitUSDC"], positive=True) > _money(config["maxDebitUSDC"], positive=True):
            raise BrokerError("Private per-order ceiling exceeds total")
        integer(config["maxOrders"], 1, 1_000_000)
        integer(config["grantTtlSeconds"], 60, 86400)
        self.lock_fd = None
        if runtime == "local_socket":
            if vault is not None or store_factory is not None:
                raise BrokerError("Local private runtime cannot mix PostgreSQL storage ports")
            for path in ("stateDir", "socketDir", "wrappingKeyFile"):
                if not Path(config[path]).is_absolute():
                    raise BrokerError("Private configuration requires absolute paths")
            self.vault = Vault(config["stateDir"], config["wrappingKeyFile"])
            self.lock_fd = os.open(Path(config["stateDir"]) / "supervisor.lock", os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600)
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(self.lock_fd)
                self.vault.close()
                raise BrokerError("Private supervisor already owns this vault") from None
        else:
            if vault is None or store_factory is None or workers is not None:
                raise BrokerError("Hosted private runtime requires explicit vault and broker-store ports")
            self.vault = vault
        self.store_factory = store_factory
        self.venue = venue or TestnetVenue()
        self.workers = (workers or Workers(config["stateDir"], config["socketDir"])) if runtime == "local_socket" else None

    def _save(self, record):
        return self.vault.save(record, expected_version=getattr(record, "version", None))

    @contextlib.contextmanager
    def _store(self, record, *, create=False):
        store = self.store_factory(record, create=create) if self.store_factory else Store(Path(self.config["stateDir"]) / record["id"])
        try:
            yield store
        finally:
            if hasattr(store, "close"):
                store.close()

    def _binding(self, record):
        plan, grant = record["plan"], record["grant"]
        execution = ({"kind": "local_socket", "socketPath": str(Path(self.config["socketDir"]) / (plan["planId"] + ".sock"))}
                     if self.runtime == "local_socket" else {"kind": "hosted_signer", "profileId": plan["planId"]})
        return {"id": plan["planId"], "subject": record["subject"], "enabled": True, "mode": grant["scope"]["mode"], "execution": execution,
                "grantId": grant["grantId"], "grantHash": grant["grantHash"],
                "accounts": [{"venue": "lighter", "network": "testnet", "account": record["account"], "apiKeyIndex": record["apiKeyIndex"]}]}

    def now(self):
        return int(self.clock() * 1000)

    def _unused_expired_grant(self, record):
        if "binding" not in record:
            return
        with self._store(record) as store:
            prior = inspect_grant(store, record["grant"]["grantId"], clock=self.clock)
            if prior["newRisk"] != "expired" or prior["remainingOrders"] != prior["maxOrders"] or _money(prior["remainingDebitUSDC"]) != _money(prior["maxDebitUSDC"]) or any(store.proposal_journals()):
                raise BrokerError("Renewal requires reconciliation of the original trading history")

    def _load(self, request):
        record = self.vault.read(request["subject"])
        if record is None or request.get("enrollmentId", record["id"]) != record["id"]:
            raise BrokerError("Unknown private enrollment")
        if record.get("revoked"):
            raise BrokerError("Private connection is revoked; no authority restored")
        return record

    def _view(self, record):
        result = {"enrollmentId": record["id"], "revision": record["revision"], "network": "testnet", "ownerWallet": record["owner"], "state": record["state"]}
        if record["state"] == "funding_required":
            result.update(message=record["message"], expiresAt=record["expiresAt"])
        elif record["state"] in {"signature_required", "registering", "ready"}:
            result.update({k: record[k] for k in ("account", "apiKeyIndex", "publicKey")})
            if record["state"] == "signature_required":
                result.update(message=record["message"], expiresAt=record["expiresAt"], nonce=record["nonce"], chainId=300)
        else:
            result["reason"] = "Enrollment is blocked; the original account/key must be reconciled."
        return result

    def _prepare_key(self, record):
        account = self.venue.account(record["owner"])
        if account is None or self.venue.funding_required(account, record["owner"]):
            return record
        if "privateKey" in record:
            if account != record["account"]:
                raise BrokerError("Venue account changed after hosted key allocation")
            return self._registration(record)
        keys = self.venue.keys(account)
        slot = next((s for s in range(5, 255) if s not in keys or empty_key(keys[s])), None)
        if slot is None:
            raise BrokerError("No free dedicated hosted key slot")
        # Save newly generated key BEFORE building a message; crash resumes this exact key.
        record.update(account=account, apiKeyIndex=slot, state="allocated", **self.venue.generate())
        record["publicKey"] = key_hex(record["publicKey"])
        record = self._save(record)
        return self._registration(record)

    def _registration(self, record):
        self.venue.verify_owner(record["account"], record["owner"])
        current = self.venue.keys(record["account"]).get(record["apiKeyIndex"])
        if current is not None and not empty_key(current) and current != record["publicKey"]:
            record["state"] = "blocked"
            record = self._save(record)
            return record
        if self.venue.funding_required(record["account"], record["owner"]):
            if record.get("faucetClaimed"):
                record["state"] = "blocked"
                record = self._save(record)
                return record
            return self._funding_review(record)
        record["nonce"] = self.venue.nonce(record["account"], record["apiKeyIndex"])
        record.update(self.venue.registration(record))
        record.update(state="signature_required", expiresAt=self.now() + 300_000)
        record["revision"] = _hash({k: record[k] for k in ("id", "owner", "account", "apiKeyIndex", "publicKey", "nonce", "message", "expiresAt")})
        record = self._save(record)
        return record

    def _funding_review(self, record):
        record.update(state="funding_required", expiresAt=self.now() + 300_000)
        fields = {k: record[k] for k in ("id", "subject", "owner", "expiresAt")}
        fields.update({k: record[k] for k in ("account", "apiKeyIndex", "publicKey") if k in record})
        record["revision"] = _hash(fields)
        record["message"] = funding_message(record)
        record = self._save(record)
        return record

    def _reconcile(self, record):
        if record["state"] == "funding_required" and record.get("faucetClaimed"):
            return self._prepare_key(record)
        if record["state"] == "funding_required" and record["expiresAt"] <= self.now():
            # Nothing was claimed or dispatched. Refresh only the same enrollment's review.
            return self._funding_review(record)
        if record["state"] == "signature_required" and record["expiresAt"] <= self.now():
            # Keep the privately saved key and slot. No registration claim exists yet.
            return self._registration(record)
        if record["state"] == "allocated":
            return self._registration(record)
        if record["state"] == "registering":
            self.venue.verify_owner(record["account"], record["owner"])
            key = self.venue.keys(record["account"]).get(record["apiKeyIndex"])
            if key == record["publicKey"] and self.venue.ready(record):
                record["state"] = "ready"
                record = self._save(record)
            elif key is not None and not empty_key(key):
                record["state"] = "blocked"
                record = self._save(record)
        return record

    def _proof(self, record, request):
        if request["revision"] != record["revision"] or record["expiresAt"] <= self.now() or recover_owner(record["message"], request["signature"]) != record["owner"]:
            raise BrokerError("Owner did not authorize the current private review")

    def dispatch(self, request):
        shapes = {"prepare": {"walletAddress"}, "resume": {"walletAddress"}, "status": {"enrollmentId"}, "faucet": {"enrollmentId", "revision", "signature"},
                  "register": {"enrollmentId", "revision", "signature"}, "preview": {"enrollmentId"},
                  "renew": {"enrollmentId"}, "activate": {"enrollmentId", "planId", "revision", "signature"}, "binding": set(), "revoke": {"profileId"}}
        if not isinstance(request, dict) or request.get("operation") not in shapes or set(request) != {"operation", "subject"} | shapes[request["operation"]]:
            raise BrokerError("Unknown or invalid private provisioner command")
        subject = request["subject"]
        if not isinstance(subject, str) or not re.fullmatch(r"did:privy:[A-Za-z0-9_-]{1,256}", subject):
            raise BrokerError("Invalid provisioning subject")
        with self.vault.locked(subject):
            return self._dispatch_locked(request)

    def _dispatch_locked(self, request):
        subject = request["subject"]
        operation = request["operation"]
        for field in ("enrollmentId", "planId", "profileId"):
            if field in request:
                _id(request[field])
        if operation in {"prepare", "resume"}:
            owner = address(request["walletAddress"])
            record = self.vault.read(subject)
            if record is not None:
                if record["owner"] != owner or record.get("revoked"):
                    raise BrokerError("Private identity owner changed or connection revoked")
                return self._view(self._reconcile(record))
            if operation == "resume":
                raise BrokerError("Original enrollment missing; resume cannot create an account or key")
            if self.vault.count() >= 1000:
                raise BrokerError("Private enrollment capacity reached")
            record = {"id": str(uuid.uuid4()), "subject": subject, "owner": owner, "state": "funding_required", "expiresAt": self.now() + 300_000}
            record["revision"] = _hash(record)
            record["message"] = funding_message(record)
            record = self._save(record)
            return self._view(self._prepare_key(record))
        if operation == "binding":
            record = self.vault.read(subject)
            if record is None or record.get("revoked") or "binding" not in record:
                return {"binding": None}
            if self.workers is not None:
                self.workers.ensure(record)
            return {"binding": record["binding"]}
        if operation == "revoke":
            prior = self.vault.read(subject)
            if prior is not None and prior.get("revoked") and prior.get("binding", {}).get("id") == request["profileId"]:
                return {"revoked": True}
        record = self._load(request)
        if operation == "status":
            return self._view(self._reconcile(record))
        if operation == "faucet":
            self._proof(record, request)
            if record["state"] != "funding_required" or record.get("faucetClaimed"):
                raise BrokerError("Faucet already requested or not required; inspect original account")
            record["faucetClaimed"] = True
            record = self._save(record)
            self.venue.faucet(record["owner"])
            return self._view(self._prepare_key(record))
        if operation == "register":
            if record["state"] in {"registering", "ready"}:
                if request["revision"] != record["revision"] or request["signature"] != record.get("registrationSignature"):
                    raise BrokerError("Registration replay differs from the accepted owner proof")
                return self._view(self._reconcile(record))
            self._proof(record, request)
            if record["state"] != "signature_required":
                raise BrokerError("Private registration is unavailable")
            self.venue.verify_owner(record["account"], record["owner"])
            current = self.venue.keys(record["account"]).get(record["apiKeyIndex"])
            if current is not None and not empty_key(current) and current != record["publicKey"]:
                raise BrokerError("Hosted key slot is occupied; nothing replaced")
            if self.venue.funding_required(record["account"], record["owner"]):
                if record.get("faucetClaimed"):
                    record["state"] = "blocked"
                    record = self._save(record)
                    return self._view(record)
                return self._view(self._funding_review(record))
            if self.venue.nonce(record["account"], record["apiKeyIndex"]) != record["nonce"]:
                raise BrokerError("Registration nonce changed; original review is no longer valid")
            record["state"] = "registering"
            record["registrationSignature"] = request["signature"]
            record = self._save(record)
            try:
                self.venue.send(record, request["signature"])
            except Exception:
                return self._view(record)  # claimed before transport; only status may resolve it
            return self._view(self._reconcile(record))
        if operation in {"preview", "renew"}:
            if record["state"] != "ready":
                raise BrokerError("Private venue registration is not ready")
            self.venue.verify_owner(record["account"], record["owner"])
            if self.venue.keys(record["account"]).get(record["apiKeyIndex"]) != record["publicKey"] or not self.venue.ready(record):
                raise BrokerError("Registered hosted key changed")
            if operation == "renew":
                if "plan" not in record or record["plan"]["expiresAt"] > self.now():
                    raise BrokerError("Only expired limits can be renewed")
                if "renewal" not in record:
                    self._unused_expired_grant(record)
                    grant = {**record["grant"], "grantId": str(uuid.uuid4()), "issuedAt": self.now(),
                             "expiresAt": self.now() + record["grant"]["expiresAt"] - record["grant"]["issuedAt"],
                             "scope": {**record["grant"]["scope"], "epoch": record["grant"]["scope"]["epoch"] + 1}}
                    del grant["grantHash"]
                    grant["grantHash"] = _hash(grant)
                    plan_id = str(uuid.uuid4())
                    record["renewal"] = {"grant": grant, "plan": {**record["plan"], "planId": plan_id, "revision": grant["grantHash"],
                        "message": consumer_message(grant, subject, plan_id), "expiresAt": grant["expiresAt"], "scope": grant["scope"],
                        "limits": {k: grant[k] for k in ("maxDebitUSDC", "maxOrders", "expiresAt", "cancelOwnOrders")}}}
                    record = self._save(record)
                if record["renewal"]["plan"]["expiresAt"] <= self.now():
                    raise BrokerError("The pending renewal expired; no authority was extended")
                return record["renewal"]["plan"]
            if "renewal" in record:
                return record["renewal"]["plan"]
            if "plan" not in record:
                grant = {"kind": "consumer_lighter", "grantId": str(uuid.uuid4()), "issuedAt": self.now(),
                         "expiresAt": self.now() + self.config["grantTtlSeconds"] * 1000,
                         **{k: self.config[k] for k in ("maxDebitUSDC", "maxOrders")}, "cancelOwnOrders": True,
                         "scope": {"kind": "consumer_lighter", "version": 1, "ownerWallet": record["owner"], "network": "testnet", "account": record["account"],
                                   "apiKeyIndex": record["apiKeyIndex"], "creators": self.config["creators"], "mode": self.config["mode"],
                                   "maxOrderDebitUSDC": self.config["maxOrderDebitUSDC"], "origin": self.config["origin"], "enrollmentId": record["id"], "epoch": 0}}
                grant["grantHash"] = _hash(grant)
                plan_id = str(uuid.uuid4())
                record["plan"] = {"planId": plan_id, "revision": grant["grantHash"], "enrollmentId": record["id"], "ownerWallet": record["owner"], "network": "testnet",
                                  "message": consumer_message(grant, subject, plan_id), "expiresAt": grant["expiresAt"], "scope": grant["scope"],
                                  "limits": {k: grant[k] for k in ("maxDebitUSDC", "maxOrders", "expiresAt", "cancelOwnOrders")}}
                record["grant"] = grant
                record = self._save(record)
            return record["plan"]
        if operation == "activate":
            candidate = record.get("renewal", {"plan": record.get("plan"), "grant": record.get("grant")})
            plan, grant = candidate["plan"], candidate["grant"]
            if plan is None or request["planId"] != plan["planId"] or request["revision"] != plan["revision"] or plan["expiresAt"] <= self.now():
                raise BrokerError("Unknown, changed or expired private scope plan")
            self.venue.verify_owner(record["account"], record["owner"])
            if self.venue.keys(record["account"]).get(record["apiKeyIndex"]) != record["publicKey"] or not self.venue.ready(record):
                raise BrokerError("Private hosted key registration changed")
            if plan["message"] != consumer_message(grant, subject, plan["planId"]) or recover_owner(plan["message"], request["signature"]) != record["owner"]:
                raise BrokerError("Owner did not authorize the exact immutable private scope")
            if "renewal" in record:
                self._unused_expired_grant(record)
            with self._store(record, create="binding" not in record) as store:
                issue_consumer_grant(store, grant, subject=subject, plan_id=plan["planId"], signature=request["signature"])
            if "binding" not in record or "renewal" in record:
                record.update(plan=plan, grant=grant)
                record.pop("renewal", None)
                record["binding"] = self._binding(record)
                record = self._save(record)
            if self.workers is not None:
                self.workers.ensure(record)
            return {"binding": record["binding"]}
        if operation == "revoke":
            if record.get("binding", {}).get("id") != request["profileId"]:
                raise BrokerError("Unknown private profile")
            with self._store(record) as store:
                revoke_grant(store, record["grant"]["grantId"])
            record["revoked"] = True
            record = self._save(record)
            return {"revoked": True}
        raise BrokerError("Unsupported private operation")

    def close(self):
        if self.workers is not None:
            self.workers.close()
        if hasattr(self.venue, "close"):
            self.venue.close()
        self.vault.close()
        if self.lock_fd is not None:
            os.close(self.lock_fd)


def serve_provisioner(socket_path, provisioner):
    """Finite framed protocol; no key export or arbitrary method dispatch."""
    from .rpc import _encode_response, _read_request, _require_same_user
    path = Path(socket_path)
    Store(path.parent)
    if not path.is_absolute() or path.exists() or path.is_symlink():
        raise BrokerError("Control socket must be a new fixed absolute path")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(str(path))
        os.chmod(path, 0o600)
        owned = path.lstat()
        try:
            listener.listen(8)
            while True:
                connection, _ = listener.accept()
                with connection:
                    try:
                        _require_same_user(connection)
                        result = provisioner.dispatch(_read_request(connection))
                        response = {"ok": True, "result": result}
                    except BrokerError as error:
                        response = {"ok": False, "error": {"code": "provisioning_blocked", "message": str(error)[:1000]}}
                    except Exception:
                        response = {"ok": False, "error": {"code": "provisioning_error", "message": "Private provisioning unavailable; inspect the original enrollment."}}
                    with contextlib.suppress(OSError):
                        connection.sendall(_encode_response(response))
        finally:
            if path.exists() and path.lstat().st_ino == owned.st_ino:
                path.unlink()
