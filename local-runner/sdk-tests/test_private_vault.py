"""Real PostgreSQL sessions, synthetic owners, no venue HTTP or transactions."""
import hashlib
import base64
import http.client
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

import psycopg

from verdict_broker.core import BrokerError
from verdict_broker.postgres_store import POSTGRES_STORE_DDL
from verdict_broker.private_vault import ENROLLMENTS_DDL, SIGNER_REQUESTS_DDL, PostgresVault, ServiceRequests
from verdict_broker.signer_http import PostgresSigner, SignerHTTP
import test_provisioner as enrollment_fixture
from test_private_signer import KEY, header

DSN = os.environ.get("VERDICT_TEST_POSTGRES_DSN")


@unittest.skipUnless(DSN, "Set VERDICT_TEST_POSTGRES_DSN to a disposable real PostgreSQL database")
class PostgresVaultTest(unittest.TestCase):
    def setUp(self):
        self.admin = psycopg.connect(DSN, autocommit=True)
        self.admin.execute(POSTGRES_STORE_DDL)
        self.admin.execute(ENROLLMENTS_DDL)
        self.admin.execute(SIGNER_REQUESTS_DDL)
        self.deployment, self.database = str(uuid.uuid4()), str(uuid.uuid4())
        self.admin.execute("INSERT INTO verdict_signer.runtime_metadata VALUES(%s,%s,1)", (self.deployment, self.database))
        self.admin.execute("INSERT INTO verdict_signer.vault_state VALUES(%s,0)", (self.deployment,))
        self.key = os.urandom(32)
        self.instances = []

    def tearDown(self):
        for vault in self.instances:
            vault.close()
        for table in ("private_events", "private_records", "private_namespaces", "service_requests", "private_enrollments", "vault_state", "runtime_metadata"):
            self.admin.execute("DELETE FROM verdict_signer." + table + " WHERE deployment_id=%s", (self.deployment,))
        self.admin.close()

    def vault(self, **changes):
        value = PostgresVault(DSN, deployment=self.deployment, database_id=self.database, wrapping_key=changes.get("key", self.key))
        self.instances.append(value)
        return value

    def record(self, **changes):
        return {"id": str(uuid.uuid4()), "subject": "did:privy:synthetic", "owner": enrollment_fixture.OWNER,
                "state": "funding_required", "privateKey": "synthetic-private-never-on-wire", **changes}

    def save(self, vault, record, version=None):
        with vault.locked(record["subject"]):
            return vault.save(record, expected_version=version)

    def test_ciphertext_survives_new_connection_without_exposing_secret(self):
        vault = self.vault()
        record = self.save(vault, self.record())
        record.update(account=42, apiKeyIndex=5)
        record = self.save(vault, record, record.version)
        vault.close()
        restored = self.vault().read(record["subject"])
        self.assertEqual(restored, record)
        self.assertEqual(restored.version, 2)
        rows = self.admin.execute("SELECT ciphertext FROM verdict_signer.private_enrollments WHERE deployment_id=%s", (self.deployment,)).fetchall()
        self.assertNotIn(b"synthetic-private", bytes(rows[0][0]))

    def test_save_requires_original_subject_lock_and_current_cas_version(self):
        vault = self.vault()
        with self.assertRaises(BrokerError):
            vault.save(self.record(), expected_version=None)
        record = self.save(vault, self.record())
        self.save(vault, {**record, "state": "allocated"}, record.version)
        with self.assertRaises(BrokerError):
            self.save(vault, record, record.version)
        self.assertEqual(vault.read(record["subject"])["state"], "allocated")

    def test_owner_account_and_slot_cannot_be_reassigned(self):
        vault = self.vault()
        record = self.save(vault, self.record(account=42, apiKeyIndex=5))
        for changed in ({"account": 43}, {"apiKeyIndex": 6}, {"apiKeyIndex": 4}, {"owner": enrollment_fixture.OTHER.address.lower()}, {"id": str(uuid.uuid4())}):
            with self.subTest(changed=changed), self.assertRaises(BrokerError):
                self.save(vault, {**record, **changed}, record.version)
        with self.assertRaises(BrokerError):
            self.save(vault, self.record(subject="did:privy:other"))
        other = self.record(subject="did:privy:other", owner=enrollment_fixture.OTHER.address.lower(), account=42, apiKeyIndex=5)
        with self.assertRaises(BrokerError):
            self.save(vault, other)
        self.assertEqual(vault.count(), 1)

    def test_wrong_key_and_modified_aad_or_ciphertext_fail_closed(self):
        record = self.save(self.vault(), self.record(account=42, apiKeyIndex=5))
        with self.assertRaises(BrokerError):
            self.vault(key=b"wrong-key".ljust(32, b"x")).read(record["subject"])
        self.admin.execute("UPDATE verdict_signer.private_enrollments SET account=43 WHERE deployment_id=%s", (self.deployment,))
        with self.assertRaises(BrokerError):
            self.vault().read(record["subject"])
        self.admin.execute("UPDATE verdict_signer.private_enrollments SET account=42,ciphertext=set_byte(ciphertext,0, get_byte(ciphertext,0) # 1) WHERE deployment_id=%s", (self.deployment,))
        with self.assertRaises(BrokerError):
            self.vault().read(record["subject"])

    def test_marker_or_deleted_enrollment_is_not_treated_as_new_budget(self):
        vault = self.vault()
        self.save(vault, self.record())
        self.admin.execute("DELETE FROM verdict_signer.private_enrollments WHERE deployment_id=%s", (self.deployment,))
        with self.assertRaises(BrokerError):
            vault.read("did:privy:synthetic")
        with self.assertRaises(BrokerError):
            self.vault()
        self.admin.execute("DELETE FROM verdict_signer.vault_state WHERE deployment_id=%s", (self.deployment,))
        with self.assertRaises(BrokerError):
            self.vault()

    def test_database_identity_is_bound_to_existing_marker(self):
        vault = self.vault()
        record = self.save(vault, self.record())
        self.admin.execute("UPDATE verdict_signer.runtime_metadata SET database_id=%s WHERE deployment_id=%s", (str(uuid.uuid4()), self.deployment))
        with self.assertRaises(BrokerError):
            vault.read(record["subject"])

    def test_subject_lock_contenders_and_lost_lock_never_resume(self):
        first, second = self.vault(), self.vault()
        with first.locked("did:privy:synthetic"):
            with self.assertRaises(BrokerError), second.locked("did:privy:synthetic"):
                self.fail("second direct session entered held subject")
            with second.locked("did:privy:different"):
                second.check_identity()
        with self.assertRaises(BrokerError), first.locked("did:privy:synthetic"):
            first.db.execute("SELECT pg_advisory_unlock_all()")
            first.check_identity()
        with self.assertRaises(BrokerError), second.locked("did:privy:synthetic"):
            second.db.close()
            second.check_identity()

    def test_service_fence_is_committed_before_mutation_and_survives_restart(self):
        first, second = self.vault(), self.vault()
        identity, digest = str(uuid.uuid4()), hashlib.sha256(b"one immutable request").hexdigest()
        one, two = ServiceRequests(first), ServiceRequests(second)
        self.assertEqual(one.claim(identity, digest), {"kind": "claimed"})
        self.assertEqual(two.claim(identity, digest), {"kind": "claimed", "result": None})
        with self.assertRaises(BrokerError):
            two.claim(identity, "f" * 64)
        one.complete(identity, digest, {"ok": True, "result": {"state": "ready"}})
        first.close()
        self.assertEqual(two.claim(identity, digest), {"kind": "complete", "result": {"ok": True, "result": {"state": "ready"}}})

    def config(self):
        return {"dsn": DSN, "deploymentId": self.deployment, "databaseId": self.database, "wrappingKey": self.key,
                "provisioning": {"runtime": "hosted_signer", "origin": "https://mcp.staging.example", "mode": "per_order", "creators": [7],
                                 "maxOrderDebitUSDC": "10", "maxDebitUSDC": "25", "maxOrders": 3, "grantTtlSeconds": 3600}}

    def test_hosted_enrollment_owner_approval_restart_binding_and_revoke(self):
        venue = enrollment_fixture.Venue()
        config = self.config()
        def call(operation, **fields):
            signer = PostgresSigner(config, venue=venue)
            try:
                return signer.operation({"operation": operation, "subject": "did:privy:synthetic", **fields})
            finally:
                signer.close()
        setup = call("prepare", walletAddress=venue.owner)
        self.assertEqual(setup, call("prepare", walletAddress=venue.owner))
        registration = {"enrollmentId": setup["enrollmentId"], "revision": setup["revision"], "signature": enrollment_fixture.sign(setup["message"])}
        self.assertEqual(call("register", **registration)["state"], "ready")
        self.assertEqual(call("register", **registration)["state"], "ready")
        self.assertEqual(venue.sends, 1)
        plan = call("preview", enrollmentId=setup["enrollmentId"])
        activation = {"enrollmentId": setup["enrollmentId"], "planId": plan["planId"], "revision": plan["revision"], "signature": enrollment_fixture.sign(plan["message"])}
        with self.assertRaises(BrokerError):
            call("activate", **{**activation, "signature": enrollment_fixture.sign(plan["message"], enrollment_fixture.OTHER)})
        count = self.admin.execute("SELECT count(*) FROM verdict_signer.private_namespaces WHERE deployment_id=%s", (self.deployment,)).fetchone()[0]
        self.assertEqual(count, 0, "unapproved owner proof must not initialize authority")
        binding = call("activate", **activation)["binding"]
        self.assertEqual(binding["execution"], {"kind": "hosted_signer", "profileId": plan["planId"]})
        self.assertNotIn("private", json.dumps(binding))
        self.assertEqual(call("binding")["binding"], binding)
        self.assertEqual(call("activate", **activation)["binding"], binding)
        self.assertEqual(call("revoke", profileId=binding["id"]), {"revoked": True})
        self.assertEqual(call("binding"), {"binding": None})

    def test_http_request_fence_survives_request_runtime_restart(self):
        venue = enrollment_fixture.Venue()
        config = self.config()
        service = SignerHTTP(deployment=self.deployment, service_key=KEY, factory=lambda: PostgresSigner(config, venue=venue))
        def call(body, identity=None):
            raw = json.dumps(body, separators=(",", ":")).encode()
            import time
            now = int(time.time() * 1000)
            return service.handle(raw, header(raw, identity, deploymentId=self.deployment, issuedAt=now, expiresAt=now + 30_000))
        setup = call({"operation": "prepare", "subject": "did:privy:synthetic", "walletAddress": venue.owner})[1]["result"]
        body = {"operation": "register", "subject": "did:privy:synthetic", "enrollmentId": setup["enrollmentId"], "revision": setup["revision"], "signature": enrollment_fixture.sign(setup["message"])}
        identity = str(uuid.uuid4())
        first = call(body, identity)
        self.assertEqual(first, call(body, identity))
        self.assertEqual(venue.sends, 1)

    def test_unused_limit_renewal_survives_cold_postgres_requests_without_reprovisioning(self):
        import time
        venue, old = self._active()
        config = self.config()
        now = time.time() + 3601
        def call(operation, **fields):
            signer = PostgresSigner(config, venue=venue)
            signer.provisioner.clock = lambda: now
            try:
                return signer.operation({"operation": operation, "subject": "did:privy:synthetic", **fields})
            finally:
                signer.close()
        ready = call("resume", walletAddress=venue.owner)
        plan = call("renew", enrollmentId=ready["enrollmentId"])
        self.assertEqual(call("preview", enrollmentId=ready["enrollmentId"]), plan)
        self.assertEqual(call("binding")["binding"], old)
        new = call("activate", enrollmentId=plan["enrollmentId"], planId=plan["planId"], revision=plan["revision"],
                   signature=enrollment_fixture.sign(plan["message"]))["binding"]
        self.assertNotEqual(new["id"], old["id"])
        self.assertEqual(new["accounts"], old["accounts"])
        self.assertEqual(call("binding")["binding"], new)
        self.assertEqual((venue.sends, venue.faucets), (1, 0))
        self.assertEqual(self.admin.execute("SELECT count(*) FROM verdict_signer.private_namespaces WHERE deployment_id=%s", (self.deployment,)).fetchone()[0], 1)

    def _active(self):
        venue = enrollment_fixture.Venue()
        signer = PostgresSigner(self.config(), venue=venue)
        def call(operation, **fields):
            return signer.operation({"operation": operation, "subject": "did:privy:synthetic", **fields})
        try:
            setup = call("prepare", walletAddress=venue.owner)
            call("register", enrollmentId=setup["enrollmentId"], revision=setup["revision"], signature=enrollment_fixture.sign(setup["message"]))
            plan = call("preview", enrollmentId=setup["enrollmentId"])
            binding = call("activate", enrollmentId=setup["enrollmentId"], planId=plan["planId"], revision=plan["revision"], signature=enrollment_fixture.sign(plan["message"]))["binding"]
            return venue, binding
        finally:
            signer.close()

    def test_isolated_broker_worker_restores_authority_without_venue_transport(self):
        venue, binding = self._active()
        signer = PostgresSigner(self.config(), venue=venue)
        try:
            result = signer.operation({"operation": "broker", "subject": "did:privy:synthetic", "profileId": binding["id"],
                "request": {"operation": "capabilities", "expectedMode": "policy", "expectedGrantId": binding["grantId"]}})
            self.assertEqual(result["authority"]["mode"], "policy")
            self.assertEqual(result["authority"]["grantId"], binding["grantId"])
            self.assertEqual(self.admin.execute("SELECT count(*) FROM verdict_signer.private_events WHERE deployment_id=%s AND body->>'type'='attempt_started'", (self.deployment,)).fetchone()[0], 0)
        finally:
            signer.close()

    def _signing_cutpoint(self, action):
        import test_consumer_authority as consumer_fixture
        from verdict_broker.authority import PolicyAuthority
        from verdict_broker.core import Broker
        from verdict_broker.postgres_store import PostgresStore
        venue, binding = self._active()
        adapter = consumer_fixture.FakeAdapter(filled="0", inventory="0", state="unknown", settled=False)
        adapter.inspect_connection = lambda _: {"ownerWallet": venue.owner, "checks": {"registration": "ready"}}
        def execute(config, record, request):
            store = PostgresStore(config["dsn"], deployment=config["deploymentId"], namespace=record["id"], database_id=config["databaseId"])
            try:
                adapter.on_submit = lambda: action(config, binding, venue, store)
                broker = Broker(store, lambda _: adapter, authority=PolicyAuthority(store, binding["grantId"]), poll_seconds=0)
                return broker.submit(request["proposal"])
            finally:
                store.close()
        signer = PostgresSigner(self.config(), venue=venue, broker=execute)
        try:
            proposal = consumer_fixture.proposal()
            return adapter, lambda: signer.operation({"operation": "broker", "subject": "did:privy:synthetic", "profileId": binding["id"],
                "request": {"operation": "submit", "expectedMode": "policy", "expectedGrantId": binding["grantId"], "proposal": proposal}}), signer
        except Exception:
            signer.close()
            raise

    def test_revoke_during_signing_uses_separate_connection_and_blocks_final_transport(self):
        def revoke(config, binding, venue, _):
            other = PostgresSigner(config, venue=venue)
            try:
                self.assertEqual(other.operation({"operation": "revoke", "subject": "did:privy:synthetic", "profileId": binding["id"]}), {"revoked": True})
            finally:
                other.close()
        adapter, submit, signer = self._signing_cutpoint(revoke)
        try:
            self.assertEqual(submit()["state"], "needs_reconciliation")
            self.assertEqual(adapter.sent, 0, "revocation committed while authority/account locks were held must prevent final transport")
        finally:
            signer.close()

    def test_lost_original_store_session_just_before_transport_never_sends(self):
        adapter, submit, signer = self._signing_cutpoint(lambda config, binding, venue, store: store.connection.close())
        try:
            with self.assertRaises(BrokerError):
                submit()
            self.assertEqual(adapter.sent, 0)
            attempts = self.admin.execute("SELECT count(*) FROM verdict_signer.private_events WHERE deployment_id=%s AND body->>'type'='attempt_started'", (self.deployment,)).fetchone()[0]
            self.assertEqual(attempts, 1, "session loss must retain the original durable attempt")
        finally:
            signer.close()

    def test_actual_http_fresh_broker_children_complete_once_across_cold_restart(self):
        import test_consumer_authority as consumer_fixture
        runner = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temporary:
            arguments = [sys.executable, str(runner / "tests/signer_http_fixture.py"), "--root", temporary, "--owner", enrollment_fixture.OWNER,
                         "--origin", "https://mcp.staging.example", "--mode", "per_order", "--deployment-id", self.deployment, "--database-id", self.database]
            environment = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "VERDICT_NODE_BINARY") if k in os.environ}
            environment.update(PYTHONPATH=str(runner), VERDICT_TEST_POSTGRES_DSN=DSN,
                               VERDICT_TEST_SIGNER_SERVICE_KEY=base64.urlsafe_b64encode(KEY).decode().rstrip("="))
            process = None
            def start():
                nonlocal process
                process = subprocess.Popen(arguments, env=environment, cwd=runner, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    if not selector.select(timeout=10):
                        self.fail("Inert private HTTP listener did not become ready")
                line = process.stdout.readline()
                if not line:
                    self.fail("Inert private HTTP listener exited: " + process.stderr.read()[-1000:])
                return json.loads(line)["port"]
            def stop():
                nonlocal process
                if process is not None:
                    process.terminate()
                    process.communicate(timeout=5)
                    process = None
            port = start()
            def call(body, identity=None):
                raw = json.dumps(body, separators=(",", ":")).encode()
                now = int(time.time() * 1000)
                auth = header(raw, identity, deploymentId=self.deployment, issuedAt=now, expiresAt=now + 30_000)
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
                try:
                    connection.request("POST", "/internal/operation", raw, {"content-type": "application/json", "x-verdict-service-auth": auth})
                    response = connection.getresponse()
                    value = json.loads(response.read())
                    self.assertEqual(response.status, 200, value)
                    return value["result"]
                finally:
                    connection.close()
            def command(operation, **fields):
                return call({"operation": operation, "subject": "did:privy:synthetic", **fields})
            try:
                setup = command("prepare", walletAddress=enrollment_fixture.OWNER)
                self.assertEqual(setup["state"], "funding_required")
                setup = command("faucet", enrollmentId=setup["enrollmentId"], revision=setup["revision"], signature=enrollment_fixture.sign(setup["message"]))
                command("register", enrollmentId=setup["enrollmentId"], revision=setup["revision"], signature=enrollment_fixture.sign(setup["message"]))
                plan = command("preview", enrollmentId=setup["enrollmentId"])
                binding = command("activate", enrollmentId=setup["enrollmentId"], planId=plan["planId"], revision=plan["revision"], signature=enrollment_fixture.sign(plan["message"]))["binding"]
                proposal = consumer_fixture.proposal(market=9001)
                body = {"operation": "broker", "subject": "did:privy:synthetic", "profileId": binding["id"],
                        "request": {"operation": "submit", "expectedMode": "policy", "expectedGrantId": binding["grantId"], "proposal": proposal}}
                request_id = str(uuid.uuid4())
                self.assertEqual(call(body, request_id)["state"], "complete")
                self.assertEqual(call(body, request_id)["state"], "complete")
                stop()
                port = start()
                self.assertEqual(command("binding")["binding"], binding)
                status = call({**body, "request": {**body["request"], "operation": "status"}})
                self.assertEqual(status["state"], "complete")
                self.assertEqual(json.loads((Path(temporary) / "metrics.json").read_text()), {"inert": True, "sends": 1})
            finally:
                stop()


if __name__ == "__main__":
    unittest.main()
