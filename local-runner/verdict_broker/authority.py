"""Operator-issued authority. Agent proposals can tighten an envelope, never grant it."""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from decimal import Decimal
from urllib.parse import urlsplit

from .core import BrokerError, D, account_key, node_call


_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_DECIMAL = re.compile(r"^(?:0|[1-9]\d{0,18})(?:\.\d{1,12})?$")
_MUTABLE = {"shares", "limitPrice", "feeReserveUSDC"}


def _money(value, *, positive=False):
    if not isinstance(value, str) or not _DECIMAL.fullmatch(value):
        raise BrokerError("Invalid authority decimal")
    result = D(value)
    if result < 0 or (positive and result <= 0):
        raise BrokerError("Invalid authority amount")
    return result


def _id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise BrokerError("Invalid grant id")
    return value


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def _units(value):
    whole, _, fractional = value.partition(".")
    return int(whole) * 10**12 + int(fractional.ljust(12, "0") or "0")


def _amount(value):
    whole, fractional = divmod(value, 10**12)
    return f"{whole}.{fractional:012d}"


def _debit(proposal):
    return sum((((_units(l["shares"]) * _units(l["limitPrice"]) + 10**12 - 1) // 10**12)
                if l["action"] == "buy" else 0) + _units(l["feeReserveUSDC"]) for l in proposal["payload"]["legs"])


def _reservation_debit(grant, proposal):
    if grant.get("kind") != "consumer_lighter":
        return _debit(proposal)
    # USDC charged units: round notional AND fee up independently, never use floats.
    return sum((((_units(l["shares"]) * _units(l["limitPrice"]) + 10**18 - 1) // 10**18)
                + (_units(l["feeReserveUSDC"]) + 10**6 - 1) // 10**6) * 10**6 for l in proposal["payload"]["legs"])


def _matches(proposal, template):
    p, t = proposal["payload"], template["payload"]
    if len(p["legs"]) != len(t["legs"]) or p["pairMode"] != t["pairMode"] or p["settlementReview"] != t["settlementReview"]:
        return False
    for leg, ceiling in zip(p["legs"], t["legs"]):
        if {k: v for k, v in leg.items() if k not in _MUTABLE} != {k: v for k, v in ceiling.items() if k not in _MUTABLE}:
            return False
        if D(leg["shares"]) > D(ceiling["shares"]) or D(leg["feeReserveUSDC"]) > D(ceiling["feeReserveUSDC"]):
            return False
        if (D(leg["limitPrice"]) > D(ceiling["limitPrice"]) if leg["action"] == "buy" else D(leg["limitPrice"]) < D(ceiling["limitPrice"])):
            return False
    return (D(p["policy"]["maxTotalDebitUSDC"]) <= D(t["policy"]["maxTotalDebitUSDC"])
            and D(p["policy"]["maxLegDebitUSDC"]) <= D(t["policy"]["maxLegDebitUSDC"])
            and D(p["policy"]["minConditionalProfitUSDC"]) >= D(t["policy"]["minConditionalProfitUSDC"]))


def consumer_scope(value):
    keys = {"kind", "version", "ownerWallet", "network", "account", "apiKeyIndex", "creators", "mode",
            "maxOrderDebitUSDC", "origin", "enrollmentId", "epoch"}
    if not isinstance(value, dict) or set(value) != keys:
        raise BrokerError("Invalid consumer scope")
    address = value["ownerWallet"]
    if (value["kind"] != "consumer_lighter" or type(value["version"]) is not int or value["version"] != 1
            or not isinstance(address, str) or not re.fullmatch(r"0x[0-9a-f]{40}", address) or address == "0x" + "0" * 40
            or value["network"] != "testnet" or type(value["account"]) is not int or not 0 <= value["account"] <= 9_007_199_254_740_991
            or type(value["apiKeyIndex"]) is not int or not 5 <= value["apiKeyIndex"] <= 254
            or value["mode"] not in {"per_order", "policy"} or type(value["epoch"]) is not int or not 0 <= value["epoch"] <= 9_007_199_254_740_991):
        raise BrokerError("Invalid consumer target")
    creators = value["creators"]
    if (not isinstance(creators, list) or not 1 <= len(creators) <= 64
            or any(type(c) is not int or not 0 <= c <= 9_007_199_254_740_991 for c in creators)
            or len(set(creators)) != len(creators)):
        raise BrokerError("Consumer creators must be explicit unique account indices")
    _id(value["enrollmentId"])
    origin = urlsplit(value["origin"])
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        raise BrokerError("Consumer origin must be a fixed HTTPS origin")
    _money(value["maxOrderDebitUSDC"], positive=True)
    return value


def consumer_message(grant, subject, plan_id):
    limits = {k: grant[k] for k in ("maxDebitUSDC", "maxOrders", "expiresAt", "cancelOwnOrders")}
    return ("Authorize Verdict hosted trading\nPlan: " + _id(plan_id) + "\nRevision: " + grant["grantHash"]
            + "\nScope: " + json.dumps(grant["scope"], sort_keys=True, separators=(",", ":"), ensure_ascii=True)
            + "\nLimits: " + json.dumps(limits, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
            + "\nThis authorizes the displayed hosted custody, execution mode and finite trading limits. No withdrawal or transfer API is exposed.")


def recover_owner(message, signature):
    from eth_account import Account
    from eth_account.messages import encode_defunct
    if not isinstance(signature, str) or not re.fullmatch(r"0x[0-9a-fA-F]{130}", signature):
        raise BrokerError("Invalid owner signature")
    try:
        return Account.recover_message(encode_defunct(text=message), signature=signature).lower()
    except Exception:
        raise BrokerError("Owner signature could not be verified") from None


def issue_consumer_grant(store, grant, *, subject, plan_id, signature):
    """Only a privately persisted exact plan can call this; no approving callback."""
    _manifest(grant)
    if grant.get("kind") != "consumer_lighter" or recover_owner(consumer_message(grant, subject, plan_id), signature) != grant["scope"]["ownerWallet"]:
        raise BrokerError("Owner did not authorize the exact consumer scope")
    with store.authority_locked():
        grants, _ = _ledger(store)
        if grant["grantId"] in grants:
            if grants[grant["grantId"]] != grant:
                raise BrokerError("Consumer grant changed")
            return grant
        store.write_once(f"scope-proof-{grant['grantId']}.json", {"subject": subject, "planId": plan_id, "signature": signature})
        store.write_once(f"grant-{grant['grantId']}.json", {"grantId": grant["grantId"], "grantHash": grant["grantHash"]})
        store.append("authority", {"type": "grant_issued", "grant": grant})
    return grant


def _manifest(value):
    keys = {"grantId", "grantHash", "issuedAt", "expiresAt", "templates", "maxDebitUSDC", "maxOrders", "cancelOwnOrders"}
    consumer = isinstance(value, dict) and value.get("kind") == "consumer_lighter"
    if consumer:
        keys = (keys - {"templates"}) | {"kind", "scope"}
    if not isinstance(value, dict) or set(value) != keys:
        raise BrokerError("Grant registry corrupt")
    _id(value["grantId"])
    if not isinstance(value["grantHash"], str) or not _HASH.fullmatch(value["grantHash"]) or _hash({k: v for k, v in value.items() if k != "grantHash"}) != value["grantHash"]:
        raise BrokerError("Grant content changed or corrupt")
    if (type(value["issuedAt"]) is not int or type(value["expiresAt"]) is not int
            or value["issuedAt"] < 0 or not value["issuedAt"] < value["expiresAt"] <= 8_640_000_000_000_000
            or type(value["maxOrders"]) is not int or not 1 <= value["maxOrders"] <= 1_000_000
            or type(value["cancelOwnOrders"]) is not bool):
        raise BrokerError("Grant registry corrupt")
    if consumer:
        consumer_scope(value["scope"])
        if _money(value["scope"]["maxOrderDebitUSDC"], positive=True) > _money(value["maxDebitUSDC"], positive=True):
            raise BrokerError("Consumer per-order cap exceeds total")
    elif not isinstance(value["templates"], list) or not 1 <= len(value["templates"]) <= 32:
        raise BrokerError("Grant registry corrupt")
    _money(value["maxDebitUSDC"], positive=True)
    return value


def _ledger(store):
    grants, reservations = {}, {}
    for row in store.read("authority"):
        metadata = {"sequence", "digest", "at", "type"}
        if row.get("type") == "grant_issued" and set(row) == metadata | {"grant"}:
            grant = _manifest(row["grant"])
            if grant["grantId"] in grants:
                raise BrokerError("Duplicate grant issuance; registry corrupt")
            marker = store.read_private(f"grant-{grant['grantId']}.json")
            if marker != {"grantId": grant["grantId"], "grantHash": grant["grantHash"]}:
                raise BrokerError("Grant issuance marker missing or changed")
            grants[grant["grantId"]] = grant
        elif row.get("type") == "reserved" and set(row) == metadata | {"grantId", "grantHash", "proposalDigest", "debitUSDC", "orders"}:
            grant = grants.get(row["grantId"])
            if grant is None or row["grantHash"] != grant["grantHash"] or not isinstance(row["proposalDigest"], str) or not _HASH.fullmatch(row["proposalDigest"]):
                raise BrokerError("Reservation registry corrupt")
            _money(row["debitUSDC"])
            if type(row["orders"]) is not int or not 1 <= row["orders"] <= 2 or row["proposalDigest"] in reservations:
                raise BrokerError("Reservation registry corrupt")
            reservations[row["proposalDigest"]] = row
        else:
            raise BrokerError("Authority registry corrupt")
    for name in store.private_names("grant-", ".json"):
        marker = store.read_private(name)
        if not isinstance(marker, dict) or marker.get("grantId") not in grants or marker != {"grantId": marker.get("grantId"), "grantHash": grants[marker["grantId"]]["grantHash"]}:
            raise BrokerError("Grant registry missing or truncated")
    # The proposal-side witness detects a cleanly truncated reservation tail.
    for _, rows in store.proposal_journals():
        for row in rows:
            if row.get("type") == "policy_reserved":
                reservation = reservations.get(row["digest"])
                if reservation is None or row.get("grantId") != reservation["grantId"] or row.get("grantHash") != reservation["grantHash"]:
                    raise BrokerError("Reservation ledger missing or truncated")
    for grant_id, grant in grants.items():
        usage = [r for r in reservations.values() if r["grantId"] == grant_id]
        if sum(_units(r["debitUSDC"]) for r in usage) > _units(grant["maxDebitUSDC"]) or sum(r["orders"] for r in usage) > grant["maxOrders"]:
            raise BrokerError("Authority budget registry corrupt")
    return grants, reservations


def issue_grant(store, templates: list[dict], *, max_debit_usdc: str, max_orders: int,
                expires_at_ms: int, cancel_own_orders: bool, confirm, clock=time.time) -> dict:
    _money(max_debit_usdc, positive=True)
    if (not isinstance(templates, list) or not 1 <= len(templates) <= 32 or type(max_orders) is not int
            or not 1 <= max_orders <= 1_000_000 or type(expires_at_ms) is not int
            or not int(clock() * 1000) < expires_at_ms <= 8_640_000_000_000_000 or type(cancel_own_orders) is not bool):
        raise BrokerError("Invalid bounded grant parameters")
    validated = [node_call(["execution", "validate", "--input", json.dumps(p, ensure_ascii=False)]) for p in templates]
    grant = {"grantId": str(uuid.uuid4()), "issuedAt": int(clock() * 1000), "expiresAt": expires_at_ms,
             "templates": validated, "maxDebitUSDC": max_debit_usdc, "maxOrders": max_orders, "cancelOwnOrders": cancel_own_orders}
    grant["grantHash"] = _hash(grant)
    if len(json.dumps(grant, ensure_ascii=False).encode()) > 900_000:
        raise BrokerError("Grant templates exceed registry size limit")
    review = {"digest": grant["grantHash"], "grant": grant, "confirmation": [
        "Issue bounded autonomous trading authority for these exact ordered templates:",
        json.dumps(grant, ensure_ascii=True, sort_keys=True),
        "Whole-proposal debit and order reservations are never automatically refunded. Pairs remain non-atomic.",
        "Revocation blocks future posts checked after signing; it cannot recall an already authorized or in-flight post.",
        f"Grant {grant['grantId']}; immutable hash {grant['grantHash']}. A fresh grant cannot clear unknown or partial account exposure."]}
    if confirm(review) is not True:
        raise BrokerError("Operator did not approve grant issuance")
    with store.authority_locked():
        _ledger(store)
        # Marker first: a crash before the issuance row makes the registry fail
        # closed, rather than letting an incomplete issuance become usable.
        store.write_once(f"grant-{grant['grantId']}.json", {"grantId": grant["grantId"], "grantHash": grant["grantHash"]})
        store.append("authority", {"type": "grant_issued", "grant": grant})
    return grant


def revoke_grant(store, grant_id) -> dict:
    _id(grant_id)
    marker = store.read_private(f"grant-{grant_id}.json")
    if not isinstance(marker, dict) or marker.get("grantId") != grant_id or not isinstance(marker.get("grantHash"), str) or not _HASH.fullmatch(marker["grantHash"]):
        raise BrokerError("Unknown or corrupt grant")
    # No authority/account lock: a long signing operation must observe this.
    store.write_once(f"revoked-{grant_id}.json", marker, allow_existing=True)
    return {"grantId": grant_id, "revoked": True}


def inspect_grant(store, grant_id, *, clock=time.time) -> dict:
    with store.authority_locked():
        authority = PolicyAuthority(store, grant_id, clock=clock)
        grants, _ = _ledger(store)
        return {**grants[grant_id], **authority.describe()}


class HumanAuthority:
    mode = "per_order"

    def __init__(self, confirm):
        if not callable(confirm):
            raise BrokerError("Operator approval callback required")
        self.confirm = confirm

    def bind(self, store):
        self.store = store

    def describe(self):
        return {"mode": "per_order", "approval": "operator_terminal"}

    def check(self, proposal):
        pass

    def reserve(self, proposal):
        pass

    def reserved(self, proposal):
        _, reservations = _ledger(self.store)
        return proposal["digest"] in reservations

    def approve(self, proposal, review):
        return self.confirm(review) is True

    def before_transport(self, proposal):
        pass

    def approve_cancel(self, proposal, index, attempt, review):
        return self.confirm(review) is True

    def origin(self):
        return {"mode": "per_order"}

    def expiry(self):
        return None


class PolicyAuthority:
    mode = "policy"

    def __init__(self, store, grant_id, *, clock=time.time):
        self.store, self.grant_id, self.clock = store, _id(grant_id), clock
        self.grant_hash = self._load()[0]["grantHash"]

    def bind(self, store):
        if store.identity != self.store.identity:
            raise BrokerError("Authority and broker must use the same state directory")

    def _load(self):
        grants, reservations = _ledger(self.store)
        grant = grants.get(self.grant_id)
        if grant is None or (hasattr(self, "grant_hash") and grant["grantHash"] != self.grant_hash):
            raise BrokerError("Grant missing or changed; no authority")
        return grant, reservations

    def _revoked(self, grant):
        marker = self.store.read_private(f"revoked-{self.grant_id}.json", missing_ok=True)
        if marker is not None and marker != {"grantId": self.grant_id, "grantHash": grant["grantHash"]}:
            raise BrokerError("Revocation marker corrupt")
        return marker is not None

    def describe(self):
        grant, reservations = self._load()
        usage = [r for r in reservations.values() if r["grantId"] == self.grant_id]
        accounts = self._accounts(grant)
        risk = "revoked" if self._revoked(grant) else "expired" if self.clock() * 1000 >= grant["expiresAt"] else "unresolved" if self.store.unresolved_accounts() & accounts else "active"
        return {"mode": "policy", "grantId": self.grant_id, "grantHash": grant["grantHash"], "expiresAt": grant["expiresAt"], "newRisk": risk,
                "remainingDebitUSDC": _amount(_units(grant["maxDebitUSDC"]) - sum(_units(r["debitUSDC"]) for r in usage)),
                "remainingOrders": grant["maxOrders"] - sum(r["orders"] for r in usage), "cancelOwnOrders": grant["cancelOwnOrders"]}

    def inspection_manifest(self):
        """Saved public scope only; callers hold the authority lock."""
        grant, _ = self._load()
        if grant.get("kind") == "consumer_lighter":
            return {"maxDebitUSDC": grant["maxDebitUSDC"], "maxOrders": grant["maxOrders"], "templates": [], "scope": grant["scope"]}
        templates = [node_call(["execution", "validate", "--input", json.dumps(p, ensure_ascii=False)]) for p in grant["templates"]]
        if templates != grant["templates"]:
            raise BrokerError("Saved grant templates are not canonical")
        return {"maxDebitUSDC": grant["maxDebitUSDC"], "maxOrders": grant["maxOrders"], "templates": templates}

    def check(self, proposal):
        grant, reservations = self._load()
        if self._revoked(grant) or self.clock() * 1000 >= grant["expiresAt"]:
            raise BrokerError("Grant expired or revoked; no new risk authorized")
        if grant.get("kind") == "consumer_lighter":
            scope = grant["scope"]
            legs = proposal["payload"]["legs"]
            if (len(legs) != 1 or any(legs[0].get(k) != v for k, v in {
                    "venue": "lighter", "network": scope["network"], "account": scope["account"], "apiKeyIndex": scope["apiKeyIndex"],
                    "action": "buy", "tif": "ioc"}.items()) or legs[0].get("creator") not in scope["creators"]
                    or _reservation_debit(grant, proposal) > _units(scope["maxOrderDebitUSDC"])):
                raise BrokerError("Proposal exceeds owner-reviewed consumer scope")
        elif not any(_matches(proposal, template) for template in grant["templates"]):
            raise BrokerError("Proposal exceeds the operator-reviewed template scope")
        accounts = {account_key(l) for l in proposal["payload"]["legs"]}
        if accounts & self.store.unresolved_accounts(exclude_digest=proposal["digest"]):
            raise BrokerError("Account has unresolved prior execution across grants or modes; reconcile before new autonomous risk")
        existing = reservations.get(proposal["digest"])
        if existing is not None:
            if existing["grantId"] != self.grant_id or existing["grantHash"] != self.grant_hash:
                raise BrokerError("Proposal reservation belongs to another grant")
        else:
            usage = [r for r in reservations.values() if r["grantId"] == self.grant_id]
            if (sum(_units(r["debitUSDC"]) for r in usage) + _reservation_debit(grant, proposal) > _units(grant["maxDebitUSDC"])
                    or sum(r["orders"] for r in usage) + len(proposal["payload"]["legs"]) > grant["maxOrders"]):
                raise BrokerError("Cumulative operator debit/order budget exceeded")

    def _accounts(self, grant):
        if grant.get("kind") == "consumer_lighter":
            return {account_key({"venue": "lighter", **grant["scope"]})}
        return {account_key(l) for t in grant["templates"] for l in t["payload"]["legs"]}

    def verify_connection(self, leg, inspection):
        grant, _ = self._load()
        if grant.get("kind") == "consumer_lighter" and (inspection.get("ownerWallet") != grant["scope"]["ownerWallet"]
                or inspection.get("checks", {}).get("registration") != "ready"):
            raise BrokerError("Consumer account owner or key registration changed")

    def expected_owner(self):
        grant, _ = self._load()
        return grant["scope"]["ownerWallet"] if grant.get("kind") == "consumer_lighter" else None

    def reserved(self, proposal):
        _, reservations = self._load()
        return proposal["digest"] in reservations

    def reserve(self, proposal):
        self.check(proposal)
        grant, reservations = self._load()
        if proposal["digest"] in reservations:
            raise BrokerError("Existing reservation without an attempt; reconcile manually, never resume")
        debit, orders = _reservation_debit(grant, proposal), len(proposal["payload"]["legs"])
        self.store.append("authority", {"type": "reserved", "grantId": self.grant_id, "grantHash": grant["grantHash"],
                                      "proposalDigest": proposal["digest"], "debitUSDC": _amount(debit), "orders": orders})
        self.store.append(proposal["digest"], {"type": "policy_reserved", "grantId": self.grant_id, "grantHash": grant["grantHash"]})

    def approve(self, proposal, review):
        self.check(proposal)
        return True

    def before_transport(self, proposal):
        self.check(proposal)
        _, reservations = self._load()
        row = reservations.get(proposal["digest"])
        if row is None or row["grantId"] != self.grant_id or row["grantHash"] != self.grant_hash:
            raise BrokerError("No durable reservation for this grant and proposal")

    def approve_cancel(self, proposal, index, attempt, review):
        grant, _ = self._load()
        if not grant["cancelOwnOrders"] or attempt.get("authority") != self.origin():
            raise BrokerError("Grant permits only explicitly approved cleanup of its own attempted orders")
        return True

    def origin(self):
        return {"mode": "policy", "grantId": self.grant_id, "grantHash": self.grant_hash}

    def expiry(self):
        return self._load()[0]["expiresAt"] / 1000
