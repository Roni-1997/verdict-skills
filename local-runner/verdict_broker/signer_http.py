"""Fixed authenticated serverless boundary over the existing provisioner and Broker."""
from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler
import json
import logging
import os
import re
import time

from .core import Broker, BrokerError, json_load
from .diagnostics import log_failure_location
from .private_vault import PostgresVault, ServiceRequests, canonical_uuid, subject_value
from .provisioner import Provisioner, TestnetVenue
from .workers import start_private_worker, stop_private_worker

AUDIENCE = "verdict-private-signer"
MAX_BODY = 65_536


def key_from_base64(value):
    try:
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
            raise ValueError
        raw = base64.urlsafe_b64decode(value + "=")
        if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode().rstrip("=") != value:
            raise ValueError
        return raw
    except Exception:
        raise BrokerError("Private service credential is unavailable") from None


def authentication_frame(claims):
    return "\n".join(("verdict-signer/1", claims["deploymentId"], claims["audience"], claims["requestId"],
                       str(claims["issuedAt"]), str(claims["expiresAt"]), claims["bodyHash"])).encode()


def authenticate(body, header, *, deployment, key, now=None):
    if not isinstance(body, bytes) or len(body) > MAX_BODY or not isinstance(header, str) or not 1 <= len(header) <= 2048 or not re.fullmatch(r"[A-Za-z0-9_-]+", header):
        raise BrokerError("Invalid private service authentication")
    try:
        raw = base64.urlsafe_b64decode(header + "=" * (-len(header) % 4))
        if base64.urlsafe_b64encode(raw).decode().rstrip("=") != header:
            raise ValueError
        claims = json_load(raw.decode("utf-8"))
        fields = {"version", "deploymentId", "audience", "requestId", "issuedAt", "expiresAt", "bodyHash", "signature"}
        if not isinstance(claims, dict) or set(claims) != fields or type(claims["version"]) is not int or claims["version"] != 1:
            raise ValueError
        if canonical_uuid(claims["deploymentId"]) != deployment or claims["audience"] != AUDIENCE:
            raise ValueError
        canonical_uuid(claims["requestId"])
        issued, expiry = claims["issuedAt"], claims["expiresAt"]
        timestamp = int(time.time() * 1000) if now is None else now
        if (type(issued) is not int or type(expiry) is not int or not 0 <= issued <= 9_007_199_254_740_991
                or not issued < expiry <= 9_007_199_254_740_991 or expiry - issued > 30_000 or issued > timestamp + 5_000 or expiry <= timestamp):
            raise ValueError
        for field in ("bodyHash", "signature"):
            if not isinstance(claims[field], str) or not re.fullmatch(r"[a-f0-9]{64}", claims[field]):
                raise ValueError
        if not hmac.compare_digest(hashlib.sha256(body).hexdigest(), claims["bodyHash"]):
            raise ValueError
        signature = hmac.new(key, authentication_frame(claims), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, claims["signature"]):
            raise ValueError
        return claims
    except Exception:
        raise BrokerError("Invalid private service authentication") from None


def _clean_child_environment():
    # Called only inside a fresh native child, never on the shared function process.
    allowed = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "VERDICT_NODE_BINARY") if name in os.environ}
    os.environ.clear()
    os.environ.update(allowed)


def _broker_child(pipe, config, record, request):
    _clean_child_environment()
    logging.disable(logging.DEBUG)
    try:
        from .adapters import Lighter
        from .authority import PolicyAuthority
        from .postgres_store import PostgresStore
        from .rpc import _dispatch
        target = record["binding"]["accounts"][0]
        def factory(leg):
            if any(leg.get(k) != target[k] for k in ("venue", "network", "account", "apiKeyIndex")):
                raise BrokerError("Private native worker target mismatch")
            return Lighter(leg, api_private_key=record["privateKey"])
        store = PostgresStore(config["dsn"], deployment=config["deploymentId"], namespace=record["id"], database_id=config["databaseId"])
        try:
            authority = PolicyAuthority(store, record["binding"]["grantId"])
            broker = Broker(store, factory, authority=authority)
            result = _dispatch(broker, request)
            pipe.send({"ok": True, "result": result})
        finally:
            store.close()
    except BrokerError as error:
        pipe.send({"ok": False, "error": {"code": "broker_blocked", "message": str(error)[:1000]}})
    except Exception:
        pipe.send({"ok": False, "error": {"code": "broker_unknown", "message": "Private execution unavailable; reconcile the original proposal, never retry automatically."}})
    finally:
        pipe.close()


def isolated_broker(config, record, request):
    private_config = {name: config[name] for name in ("dsn", "deploymentId", "databaseId")}
    parent, process = start_private_worker({"kind": "broker", "config": private_config, "record": record, "request": request})
    try:
        if not parent.poll(90):
            raise BrokerError("Private execution timed out; reconcile the original proposal")
        response = parent.recv()
        if not response.get("ok"):
            raise BrokerError(response.get("error", {}).get("message", "Private execution unavailable"))
        return response["result"]
    finally:
        parent.close()
        stop_private_worker(process)


class PostgresSigner:
    """One request owns these connections; no ambient or warm-instance transaction."""
    def __init__(self, config, *, venue=None, broker=isolated_broker):
        from .postgres_store import PostgresStore
        self.config, self.broker = config, broker
        self.vault = PostgresVault(config["dsn"], deployment=config["deploymentId"], database_id=config["databaseId"], wrapping_key=config["wrappingKey"])
        def store_factory(record, *, create=False):
            method = PostgresStore.provision if create else PostgresStore
            return method(config["dsn"], deployment=config["deploymentId"], namespace=record["id"], database_id=config["databaseId"])
        try:
            self.provisioner = Provisioner(config["provisioning"], vault=self.vault, store_factory=store_factory,
                                           venue=venue or TestnetVenue(transport_guard=self.vault.check_identity),
                                           reconcile_status=lambda record, proposal: self.broker(config, record, {
                                               "operation": "status", "expectedMode": "policy",
                                               "expectedGrantId": record["binding"]["grantId"], "proposal": proposal}))
        except Exception:
            self.vault.close()
            raise
        self.requests = ServiceRequests(self.vault)

    def _record(self, subject, profile_id):
        subject_value(subject)
        canonical_uuid(profile_id)
        with self.vault.locked(subject):
            record = self.vault.read(subject)
            binding = record.get("binding") if record else None
            if not binding or binding["id"] != profile_id or binding.get("execution") != {"kind": "hosted_signer", "profileId": profile_id} or binding.get("subject") != subject:
                raise BrokerError("Private profile is unavailable for this identity")
            return record

    def operation(self, request):
        if not isinstance(request, dict):
            raise BrokerError("Private request must be an object")
        if request.get("operation") != "broker":
            return self.provisioner.dispatch(request)
        if set(request) != {"operation", "subject", "profileId", "request"} or not isinstance(request["request"], dict):
            raise BrokerError("Invalid finite private broker request")
        record = self._record(request["subject"], request["profileId"])
        operation = request["request"].get("operation")
        if operation not in {"capabilities", "inspectConnection", "preflight", "submit", "status", "cancel"}:
            raise BrokerError("Unsupported private broker operation")
        if record.get("revoked") and operation in {"preflight", "submit"}:
            raise BrokerError("Private profile is revoked")
        # Enrollment lock is intentionally RELEASED before long native/account operations.
        return self.broker(self.config, record, request["request"])

    def observe_claim(self, request):
        operation = request.get("operation")
        if operation == "broker":
            original = request["request"]
            if original.get("operation") not in {"submit", "cancel"}:
                raise BrokerError("Unexpected private request fence")
            status = {k: v for k, v in original.items() if k != "leg"}
            return self.operation({**request, "request": {**status, "operation": "status"}})
        if operation in {"register", "faucet"}:
            return self.provisioner.dispatch({"operation": "status", "subject": request["subject"], "enrollmentId": request["enrollmentId"]})
        if operation == "activate":
            return self.provisioner.dispatch({"operation": "binding", "subject": request["subject"]})
        if operation == "revoke":
            record = self._record(request["subject"], request["profileId"])
            if record.get("revoked"):
                return {"revoked": True}
            with self.provisioner._store(record) as store:
                marker = store.read_private("revoked-" + record["grant"]["grantId"] + ".json", missing_ok=True)
                if marker is not None:
                    return {"revoked": True}
            raise BrokerError("Original revocation outcome is unresolved")
        raise BrokerError("Unknown private request fence")

    def close(self):
        self.provisioner.close()


def mutating_request(request):
    return request.get("operation") in {"faucet", "register", "activate", "revoke"} or (
        request.get("operation") == "broker" and isinstance(request.get("request"), dict) and request["request"].get("operation") in {"submit", "cancel"})


class SignerHTTP:
    def __init__(self, *, deployment, service_key, factory, clock=time.time):
        self.deployment, self.service_key, self.factory, self.clock = canonical_uuid(deployment), service_key, factory, clock
        if not isinstance(service_key, bytes) or len(service_key) != 32:
            raise BrokerError("Private service key must be 32 bytes")

    def handle(self, body, header):
        try:
            claims = authenticate(body, header, deployment=self.deployment, key=self.service_key, now=int(self.clock() * 1000))
        except BrokerError:
            return 401, {"ok": False, "error": {"code": "invalid_service_auth", "message": "Private service authentication failed."}}
        try:
            request = json_load(body.decode("utf-8"))
            if not isinstance(request, dict):
                raise BrokerError("Invalid private request")
        except Exception:
            return 400, {"ok": False, "error": {"code": "invalid_request", "message": "Expected bounded UTF-8 JSON object."}}
        runtime = None
        try:
            runtime = self.factory()
            mutation = mutating_request(request)
            fence = runtime.requests.claim(claims["requestId"], claims["bodyHash"]) if mutation else {"kind": "readonly"}
            if fence["kind"] == "complete":
                return 200, fence["result"]
            if fence["kind"] == "claimed" and "result" in fence:
                result = runtime.observe_claim(request)
            else:
                result = runtime.operation(request)
            envelope = {"ok": True, "result": result}
            if mutation and fence == {"kind": "claimed"}:
                runtime.requests.complete(claims["requestId"], claims["bodyHash"], envelope)
            return 200, envelope
        except BrokerError as error:
            log_failure_location(error)
            return 409, {"ok": False, "error": {"code": "signer_blocked", "message": "Private operation blocked or unresolved. Preserve its original enrollment/proposal and inspect status."}}
        except Exception as error:
            log_failure_location(error)
            return 503, {"ok": False, "error": {"code": "signer_unavailable", "message": "Private signer unavailable. Preserve the original operation; never retry a send automatically."}}
        finally:
            if runtime is not None:
                with contextlib.suppress(Exception):
                    runtime.close()


def config_from_env(env=None):
    env = os.environ if env is None else env
    try:
        config = {"dsn": env["VERDICT_SIGNER_DATABASE_URL"], "deploymentId": canonical_uuid(env["VERDICT_SIGNER_DEPLOYMENT_ID"]),
                  "databaseId": canonical_uuid(env["VERDICT_SIGNER_DATABASE_ID"]), "wrappingKey": key_from_base64(env["VERDICT_SIGNER_WRAPPING_KEY"]),
                  "serviceKey": key_from_base64(env["VERDICT_SIGNER_SERVICE_KEY"]),
                  "provisioning": {"runtime": "hosted_signer", "origin": env["VERDICT_SIGNER_PUBLIC_ORIGIN"], "mode": env["VERDICT_SIGNER_MODE"],
                                   "creators": [int(value) for value in env["VERDICT_SIGNER_CREATORS"].split(",")],
                                   "maxOrderDebitUSDC": env["VERDICT_SIGNER_MAX_ORDER_USDC"], "maxDebitUSDC": env["VERDICT_SIGNER_MAX_TOTAL_USDC"],
                                   "maxOrders": int(env["VERDICT_SIGNER_MAX_ORDERS"]), "grantTtlSeconds": int(env["VERDICT_SIGNER_GRANT_TTL_SECONDS"])}}
        from urllib.parse import urlsplit
        if "-pooler" in (urlsplit(config["dsn"]).hostname or ""):
            raise ValueError
        if hmac.compare_digest(config["wrappingKey"], config["serviceKey"]):
            raise ValueError
        return config
    except Exception:
        raise BrokerError("Private signer deployment configuration unavailable") from None


class VercelHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def service(self):
        config = config_from_env()
        return SignerHTTP(deployment=config["deploymentId"], service_key=config["serviceKey"], factory=lambda: PostgresSigner(config))

    def do_POST(self):
        if self.path != "/internal/operation" or self.headers.get_all("transfer-encoding") is not None:
            self._reply(404, {"ok": False, "error": {"code": "not_found", "message": "Unknown private endpoint."}})
            return
        headers = self.headers.get_all("x-verdict-service-auth", [])
        try:
            lengths = self.headers.get_all("content-length", [])
            types = self.headers.get_all("content-type", [])
            if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,6}", lengths[0]) or len(types) != 1:
                raise ValueError
            length = int(lengths[0])
            if not 0 < length <= MAX_BODY or len(headers) != 1 or types[0].split(";", 1)[0].strip().lower() != "application/json":
                raise ValueError
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError
        except Exception:
            self._reply(400, {"ok": False, "error": {"code": "invalid_request", "message": "Expected one bounded JSON request."}})
            return
        try:
            service = self.service()
            status, result = service.handle(body, headers[0])
        except Exception:
            status, result = 503, {"ok": False, "error": {"code": "not_configured", "message": "Private signer deployment unavailable."}}
        self._reply(status, result)

    def do_GET(self):
        self._reply(405, {"ok": False, "error": {"code": "method_not_allowed", "message": "Private operations require authenticated POST."}})

    def _reply(self, status, result):
        raw = json.dumps(result, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
