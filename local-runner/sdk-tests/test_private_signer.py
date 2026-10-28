"""Finite authenticated boundary: synthetic credentials and inert operations only."""
import base64
import hashlib
import hmac
import json
import os
import unittest
from unittest.mock import Mock, patch
import uuid

from verdict_broker.core import BrokerError
from verdict_broker.signer_http import AUDIENCE, SignerHTTP, authenticate, authentication_frame, config_from_env, key_from_base64
from verdict_broker.provisioner import TestnetVenue, _native_process
from verdict_broker.private_vault import connection_options

DEPLOYMENT = "237cd183-c389-456f-9437-824b2bfc0050"
KEY = bytes(range(32))
NOW = 1_800_000_000_000


def header(body, request_id=None, **changes):
    claims = {"version": 1, "deploymentId": DEPLOYMENT, "audience": AUDIENCE,
              "requestId": request_id or str(uuid.uuid4()), "issuedAt": NOW, "expiresAt": NOW + 30_000,
              "bodyHash": hashlib.sha256(body).hexdigest()}
    claims.update(changes)
    claims["signature"] = hmac.new(KEY, authentication_frame(claims), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).decode().rstrip("=")


class Ledger:
    def __init__(self):
        self.rows = {}

    def claim(self, identity, digest):
        if identity in self.rows:
            old, result = self.rows[identity]
            if old != digest:
                raise BrokerError("changed body")
            return {"kind": "claimed" if result is None else "complete", "result": result}
        self.rows[identity] = (digest, None)
        return {"kind": "claimed"}

    def complete(self, identity, digest, result):
        self.rows[identity] = (digest, result)


class PrivateSignerHTTPTest(unittest.TestCase):
    def setUp(self):
        self.runtime = Mock(requests=Ledger())
        self.runtime.operation.return_value = {"state": "ready"}
        self.runtime.observe_claim.return_value = {"state": "observed"}
        self.factory = Mock(return_value=self.runtime)
        self.service = SignerHTTP(deployment=DEPLOYMENT, service_key=KEY, factory=self.factory, clock=lambda: NOW / 1000)

    def call(self, body, identity=None, **changes):
        raw = json.dumps(body, separators=(",", ":")).encode()
        return self.service.handle(raw, header(raw, identity, **changes))

    def test_exact_authenticated_body_and_frame_fixture(self):
        body = b'{"operation":"binding","subject":"did:privy:synthetic"}'
        encoded = header(body)
        claims = authenticate(body, encoded, deployment=DEPLOYMENT, key=KEY, now=NOW)
        self.assertTrue(authentication_frame(claims).startswith(b"verdict-signer/1\n"))
        self.assertFalse(authentication_frame(claims).endswith(b"\n"))
        self.assertEqual(key_from_base64(base64.urlsafe_b64encode(KEY).decode().rstrip("=")), KEY)
        for changed in (body + b" ", b"{}", body.replace(b"binding", b"prepare")):
            with self.assertRaises(BrokerError):
                authenticate(changed, encoded, deployment=DEPLOYMENT, key=KEY, now=NOW)

    def test_invalid_auth_never_opens_private_state(self):
        body = b"{}"
        cases = [{"deploymentId": str(uuid.uuid4())}, {"audience": "wrong"}, {"version": True},
                 {"expiresAt": NOW}, {"expiresAt": NOW + 30_001}, {"issuedAt": NOW + 5001, "expiresAt": NOW + 10_000},
                 {"issuedAt": True}, {"bodyHash": "A" * 64}, {"unexpected": "field"}]
        for changed in cases:
            with self.subTest(changed=changed):
                status, _ = self.service.handle(body, header(body, **changed))
                self.assertEqual(status, 401)
        for value in ("", "a" * 2049, header(body) + "=", "%%%"):
            self.assertEqual(self.service.handle(body, value)[0], 401)
        self.factory.assert_not_called()

    def test_duplicate_json_fields_are_rejected(self):
        encoded = header(b"{}")
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        raw = raw[:-1] + b',"version":1}'
        changed = base64.urlsafe_b64encode(raw).decode().rstrip("=")
        self.assertEqual(self.service.handle(b"{}", changed)[0], 401)
        duplicate = b'{"operation":"prepare","operation":"binding"}'
        self.assertEqual(self.service.handle(duplicate, header(duplicate))[0], 400)
        self.factory.assert_not_called()

    def test_mutating_replay_caches_original_result_and_changed_body_conflicts(self):
        identity = str(uuid.uuid4())
        request = {"operation": "register", "subject": "did:privy:synthetic"}
        self.assertEqual(self.call(request, identity), self.call(request, identity))
        self.runtime.operation.assert_called_once_with(request)
        self.runtime.observe_claim.assert_not_called()
        self.assertEqual(self.call({**request, "subject": "did:privy:other"}, identity)[0], 409)

    def test_uncertain_claim_only_observes_and_never_reexecutes(self):
        identity = str(uuid.uuid4())
        request = {"operation": "broker", "subject": "did:privy:synthetic", "request": {"operation": "submit"}}
        self.runtime.operation.side_effect = OSError("synthetic lost response")
        self.assertEqual(self.call(request, identity)[0], 503)
        self.assertEqual(self.call(request, identity), (200, {"ok": True, "result": {"state": "observed"}}))
        self.assertEqual(self.runtime.operation.call_count, 1)
        self.runtime.observe_claim.assert_called_once_with(request)

    def test_reads_do_not_grow_mutation_journal(self):
        for operation in ("prepare", "status", "binding", "preview"):
            self.assertEqual(self.call({"operation": operation})[0], 200)
        self.assertEqual(self.runtime.requests.rows, {})

    def test_boundary_errors_do_not_expose_exception_or_credentials(self):
        self.runtime.operation.side_effect = BrokerError("secret-api-key private database password")
        status, result = self.call({"operation": "revoke"})
        self.assertEqual(status, 409)
        self.assertNotIn("secret-api-key", json.dumps(result))
        self.runtime.close.assert_called_once()

    def test_faucet_rechecks_transport_before_each_external_mutation(self):
        venue = object.__new__(TestnetVenue)
        venue.transport_guard = Mock(side_effect=[None, BrokerError("lost session")])
        venue.get = Mock(return_value={"code": 200})
        with self.assertRaises(BrokerError):
            venue.faucet("0x" + "1" * 40)
        self.assertEqual(venue.get.call_count, 1)

    def test_native_send_waits_for_parent_permission_and_does_not_send_after_denial(self):
        import lighter
        signer = Mock()
        signer.close = unittest.mock.AsyncMock()
        signer.send_tx = unittest.mock.AsyncMock()
        pipe = Mock()
        pipe.poll.return_value = True
        pipe.recv.return_value = False
        with patch.object(lighter, "SignerClient", return_value=signer):
            _native_process(pipe, "send", {"account": 42, "apiKeyIndex": 5, "privateKey": "synthetic", "txInfo": "{}", "txType": 8}, True)
        signer.send_tx.assert_not_called()
        self.assertEqual(pipe.send.call_args_list[0].args[0], {"transport_check": True})

    def test_gateway_service_key_cannot_also_be_the_private_wrapping_key(self):
        encoded = base64.urlsafe_b64encode(KEY).decode().rstrip("=")
        env = {"VERDICT_SIGNER_DATABASE_URL": "postgresql://localhost/inert", "VERDICT_SIGNER_DEPLOYMENT_ID": DEPLOYMENT,
               "VERDICT_SIGNER_DATABASE_ID": str(uuid.uuid4()), "VERDICT_SIGNER_WRAPPING_KEY": encoded, "VERDICT_SIGNER_SERVICE_KEY": encoded,
               "VERDICT_SIGNER_PUBLIC_ORIGIN": "https://mcp.staging.example", "VERDICT_SIGNER_MODE": "per_order", "VERDICT_SIGNER_CREATORS": "7",
               "VERDICT_SIGNER_MAX_ORDER_USDC": "10", "VERDICT_SIGNER_MAX_TOTAL_USDC": "100", "VERDICT_SIGNER_MAX_ORDERS": "20", "VERDICT_SIGNER_GRANT_TTL_SECONDS": "3600"}
        with self.assertRaises(BrokerError):
            config_from_env(env)
        env["VERDICT_SIGNER_WRAPPING_KEY"] = base64.urlsafe_b64encode(b"x" * 32).decode().rstrip("=")
        self.assertEqual(config_from_env(env)["provisioning"]["runtime"], "hosted_signer")
        env["VERDICT_SIGNER_DATABASE_URL"] = "postgresql://ep-fixture-pooler.localhost/inert"
        with self.assertRaises(BrokerError):
            config_from_env(env)

    def test_private_tcp_database_requires_hostname_verified_tls_with_bundled_ca(self):
        import certifi
        secure = connection_options("postgresql://database.example/inert?sslmode=disable")
        self.assertEqual(secure["sslmode"], "verify-full")
        self.assertEqual(secure["sslrootcert"], certifi.where())
        local = connection_options("postgresql:///inert?host=/tmp/inert-postgres")
        self.assertNotIn("sslmode", local)


if __name__ == "__main__":
    unittest.main()
