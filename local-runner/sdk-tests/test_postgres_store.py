"""Real PostgreSQL store and broker lifecycle; inert Lighter testnet adapters only."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
import unittest
import uuid

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from verdict_broker.authority import PolicyAuthority, inspect_grant, issue_grant, revoke_grant
from verdict_broker.core import Broker, BrokerError, account_key, node_call
from verdict_broker.postgres_store import POSTGRES_STORE_DDL, PostgresStore, connection_options

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from test_broker import FakeAdapter, request


DSN = os.environ.get("VERDICT_TEST_POSTGRES_DSN") or os.environ.get("VERDICT_TEST_POSTGRES")


class ConnectionOptionsTest(unittest.TestCase):
    def test_every_tcp_conninfo_form_overrides_disabled_tls(self):
        for dsn in ("postgresql://remote.example/test?sslmode=disable",
                    "postgresql:///test?host=remote.example&sslmode=disable",
                    "dbname=test hostaddr=192.0.2.1 sslmode=disable"):
            with self.subTest(dsn=dsn):
                options = connection_options(dsn)
                self.assertEqual(options["sslmode"], "verify-full")
                self.assertTrue(Path(options["sslrootcert"]).is_file())
        self.assertEqual(connection_options("postgresql:///test?host=/tmp/test"), {})


def local_test_dsn(value):
    parsed = conninfo_to_dict(value)
    host, database = parsed.get("host", ""), parsed.get("dbname", "")
    if (host not in {"localhost", "127.0.0.1", "::1"} and not host.startswith("/")
            or parsed.get("hostaddr") or parsed.get("service")
            or not re.fullmatch(r"verdict_(?:mcp_)?test(?:_[a-z0-9_]+)?", database)):
        raise RuntimeError("PostgreSQL tests require an explicitly configured local disposable verdict_test database")
    return value


def proposal():
    value = request(True)
    value["legs"] = [{**value["legs"][1], "network": "testnet", "apiKeyIndex": 5, "side": "yes"}]
    value["settlementReview"] = None
    return node_call(["execution", "prepare", "--input", json.dumps(value)])


@unittest.skipUnless(DSN, "Set VERDICT_TEST_POSTGRES_DSN to a disposable local PostgreSQL database")
class PostgresStoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.created = False
        cls.database_name = "verdict_mcp_test_store_" + uuid.uuid4().hex
        cls.parent = psycopg.connect(local_test_dsn(DSN), autocommit=True, connect_timeout=5)
        try:
            cls.parent.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(cls.database_name)))
            cls.created = True
            cls.dsn = make_conninfo(DSN, dbname=cls.database_name)
            cls.admin = psycopg.connect(cls.dsn, autocommit=True, connect_timeout=5)
            cls.admin.execute(POSTGRES_STORE_DDL)
        except BaseException:
            if cls.created:
                cls.parent.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(cls.database_name)))
            cls.parent.close()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.admin.close()
        if cls.created:
            cls.parent.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(cls.database_name)))
        cls.parent.close()

    def setUp(self):
        self.deployment, self.database_id, self.namespace = (str(uuid.uuid4()) for _ in range(3))
        self.admin.execute("INSERT INTO verdict_signer.runtime_metadata VALUES(%s,%s,1)", (self.deployment, self.database_id))
        self.stores = []
        self.store = self.open(provision=True)
        self.template = proposal()

    def tearDown(self):
        for store in self.stores:
            store.close()

    def open(self, *, namespace=None, provision=False):
        constructor = PostgresStore.provision if provision else PostgresStore
        store = constructor(self.dsn, deployment=self.deployment, namespace=namespace or self.namespace, database_id=self.database_id)
        self.stores.append(store)
        return store

    def issue(self, *, debit="25", orders=10):
        return issue_grant(self.store, [self.template], max_debit_usdc=debit, max_orders=orders,
                           expires_at_ms=int((time.time() + 3600) * 1000), cancel_own_orders=True, confirm=lambda _: True)

    def broker(self, store, grant, adapter):
        return Broker(store, lambda _: adapter, authority=PolicyAuthority(store, grant["grantId"]), poll_seconds=0)

    def test_ordinary_open_never_provisions_missing_namespace_or_replaces_marker(self):
        missing = str(uuid.uuid4())
        with self.assertRaisesRegex(BrokerError, "missing or unavailable"):
            PostgresStore(self.dsn, deployment=self.deployment, namespace=missing, database_id=self.database_id)
        self.assertEqual(self.admin.execute("SELECT count(*) FROM verdict_signer.private_namespaces WHERE deployment_id=%s AND namespace=%s", (self.deployment, missing)).fetchone()[0], 0)
        with self.assertRaises(BrokerError):
            PostgresStore(self.dsn, deployment=self.deployment, namespace=self.namespace, database_id=str(uuid.uuid4()))
        self.assertEqual(self.open().identity, self.store.identity)
        other = self.open(namespace=str(uuid.uuid4()), provision=True)
        grant = self.issue()
        with self.assertRaisesRegex(BrokerError, "same state"):
            Broker(other, lambda _: FakeAdapter(), authority=PolicyAuthority(self.store, grant["grantId"]))

    def test_immutable_records_conflict_across_sessions_and_remain_after_reopening(self):
        second = self.open()
        name = "grant-" + str(uuid.uuid4()) + ".json"
        barrier = threading.Barrier(2)

        def compete(store, value):
            barrier.wait(timeout=5)
            try:
                store.write_once(name, value)
                return "written"
            except BrokerError:
                return "conflict"

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(compete, self.store, {"winner": 1})
            other = executor.submit(compete, second, {"winner": 2})
            self.assertEqual(sorted([first.result(timeout=10), other.result(timeout=10)]), ["conflict", "written"])
        saved = self.store.read_private(name)
        self.store.write_once(name, saved, allow_existing=True)
        with self.assertRaises(BrokerError):
            second.write_once(name, {"winner": 3}, allow_existing=True)
        self.store.close(); second.close()
        reopened = self.open()
        self.assertEqual(reopened.read_private(name), saved)
        self.assertEqual(reopened.private_names("grant-", ".json"), [name])
        self.assertEqual(self.admin.execute("SELECT record_count FROM verdict_signer.private_namespaces WHERE deployment_id=%s AND namespace=%s", (self.deployment, self.namespace)).fetchone()[0], 1)

    def test_concurrent_committed_append_has_one_contiguous_original_journal(self):
        second = self.open()
        digest = self.template["digest"]
        barrier = threading.Barrier(2)

        def append(store, producer):
            barrier.wait(timeout=5)
            for index in range(8):
                store.append(digest, {"type": "test_event", "producer": producer, "index": index})

        with ThreadPoolExecutor(max_workers=2) as executor:
            left = executor.submit(append, self.store, "left")
            right = executor.submit(append, second, "right")
            left.result(timeout=15); right.result(timeout=15)
        rows = self.open().read(digest)
        self.assertEqual([row["sequence"] for row in rows], list(range(16)))
        self.assertEqual({(row["producer"], row["index"]) for row in rows}, {(producer, index) for producer in ("left", "right") for index in range(8)})
        self.assertEqual(self.open().proposal_journals(), [(digest, rows)])

    def test_global_account_lock_spans_namespaces_and_releases_after_operation(self):
        other = self.open(namespace=str(uuid.uuid4()), provision=True)
        legs = self.template["payload"]["legs"]
        with self.store.authority_locked(), self.store.locked(legs):
            with other.authority_locked(), self.assertRaisesRegex(BrokerError, "busy"):
                with other.locked(legs):
                    self.fail("The same account must not acquire a second lock")
        with other.authority_locked(), other.locked(legs):
            self.assertEqual(other.read(self.template["digest"]), [])

    def test_two_independent_sessions_cannot_overspend_the_same_grant(self):
        grant = self.issue(debit="4.1", orders=1)
        second = self.open()
        adapters = [FakeAdapter(), FakeAdapter()]
        brokers = [self.broker(self.store, grant, adapters[0]), self.broker(second, grant, adapters[1])]
        proposals = [self.template, proposal()]
        barrier = threading.Barrier(2)

        def submit(index):
            barrier.wait(timeout=5)
            try:
                return brokers[index].submit(proposals[index])["state"]
            except BrokerError:
                return "blocked"

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = [executor.submit(submit, index) for index in range(2)]
            self.assertEqual(sorted(result.result(timeout=20) for result in results), ["blocked", "complete"])
        self.assertEqual(sum(adapter.sent for adapter in adapters), 1)
        restarted = self.open()
        remaining = inspect_grant(restarted, grant["grantId"])
        self.assertEqual(remaining["remainingOrders"], 0)
        self.assertEqual(Decimal(remaining["remainingDebitUSDC"]), Decimal(0))
        self.assertEqual(sum(row["type"] == "reserved" for row in restarted.read("authority")), 1)

    def test_ambiguous_transport_survives_restart_without_a_second_send_or_refund(self):
        grant = self.issue()
        first = FakeAdapter(lost=True, state="unknown", filled="0", inventory="0", settled=False)
        result = self.broker(self.store, grant, first).submit(self.template)
        self.assertEqual((first.sent, result["state"]), (1, "needs_reconciliation"))
        original = next(row for row in self.store.read(self.template["digest"]) if row["type"] == "attempt_started")
        self.store.close()
        restarted = self.open()
        second = FakeAdapter(state="unknown", filled="0", inventory="0", settled=False)
        second.on_submit = lambda: self.fail("Original uncertain attempt must never be sent again")
        status = self.broker(restarted, grant, second).submit(self.template)
        self.assertEqual((second.sent, status["state"], status["automaticRetry"]), (0, "needs_reconciliation", False))
        self.assertEqual(next(row for row in restarted.read(self.template["digest"]) if row["type"] == "attempt_started"), original)
        self.assertEqual(inspect_grant(restarted, grant["grantId"])["remainingOrders"], 9)
        self.assertEqual(restarted.unresolved_accounts(), {account_key(self.template["payload"]["legs"][0])})
        self.assertEqual(restarted.unresolved_accounts(exclude_digest=self.template["digest"]), set())

    def test_crash_after_committed_attempt_fence_leaves_only_reconciliation(self):
        grant = self.issue()
        adapter = FakeAdapter(state="unknown", filled="0", inventory="0", settled=False)

        def crash_before_transport():
            self.assertTrue(any(row["type"] == "attempt_started" for row in self.store.read(self.template["digest"])))
            raise SystemExit("simulated function death before SDK transport")

        adapter.on_submit = crash_before_transport
        with self.assertRaises(SystemExit):
            self.broker(self.store, grant, adapter).submit(self.template)
        self.assertEqual(adapter.sent, 0)
        self.store.close()
        reopened = self.open()
        other = FakeAdapter(state="unknown", filled="0", inventory="0", settled=False)
        self.assertEqual(self.broker(reopened, grant, other).submit(self.template)["state"], "needs_reconciliation")
        self.assertEqual(other.sent, 0)
        self.assertEqual(inspect_grant(reopened, grant["grantId"])["remainingOrders"], 9)

    def test_separate_session_revoke_during_signing_is_visible_before_transport(self):
        grant = self.issue()
        revoker = self.open()
        adapter = FakeAdapter(state="unknown", filled="0", inventory="0", settled=False)
        revoked = []
        adapter.on_submit = lambda: revoked.append(revoke_grant(revoker, grant["grantId"]))
        result = self.broker(self.store, grant, adapter).submit(self.template)
        self.assertEqual((adapter.sent, len(revoked), result["state"]), (0, 1, "needs_reconciliation"))
        self.assertEqual(inspect_grant(self.open(), grant["grantId"])["newRisk"], "revoked")
        self.assertTrue(revoke_grant(revoker, grant["grantId"])["revoked"])

    def test_server_terminated_session_at_final_signing_hook_fails_closed_without_reconnect(self):
        grant = self.issue()
        adapter = FakeAdapter(state="unknown", filled="0", inventory="0", settled=False)
        original_connection = self.store.connection
        pid = original_connection.info.backend_pid

        def terminate_own_session():
            self.assertTrue(self.admin.execute("SELECT pg_terminate_backend(%s)", (pid,)).fetchone()[0])

        adapter.on_submit = terminate_own_session
        with self.assertRaises(BrokerError):
            self.broker(self.store, grant, adapter).submit(self.template)
        self.assertEqual(adapter.sent, 0)
        self.assertIs(self.store.connection, original_connection)
        self.assertTrue(original_connection.closed)
        restarted = self.open()
        other = FakeAdapter(state="unknown", filled="0", inventory="0", settled=False)
        self.assertEqual(self.broker(restarted, grant, other).submit(self.template)["state"], "needs_reconciliation")
        self.assertEqual(other.sent, 0)

    def test_missing_or_replaced_runtime_marker_fails_existing_and_reopened_stores(self):
        self.admin.execute("UPDATE verdict_signer.runtime_metadata SET database_id=%s WHERE deployment_id=%s", (str(uuid.uuid4()), self.deployment))
        with self.assertRaises(BrokerError):
            self.store.read("authority")
        with self.assertRaises(BrokerError):
            self.open()
        with self.assertRaises(BrokerError):
            PostgresStore.provision(self.dsn, deployment=self.deployment, namespace=self.namespace, database_id=self.database_id)

    def test_record_and_event_count_witnesses_detect_clean_deletion(self):
        name = "grant-" + str(uuid.uuid4()) + ".json"
        self.store.write_once(name, {"grant": "witness"})
        self.admin.execute("DELETE FROM verdict_signer.private_records WHERE deployment_id=%s AND namespace=%s AND name=%s", (self.deployment, self.namespace, name))
        with self.assertRaisesRegex(BrokerError, "witness changed"):
            self.store.read_private(name, missing_ok=True)
        other = self.open(namespace=str(uuid.uuid4()), provision=True)
        other.append(self.template["digest"], {"type": "first"})
        other.append(self.template["digest"], {"type": "last"})
        self.admin.execute("DELETE FROM verdict_signer.private_events WHERE deployment_id=%s AND namespace=%s AND sequence=1", (self.deployment, other.namespace))
        with self.assertRaisesRegex(BrokerError, "witness changed"):
            other.read(self.template["digest"])

    def test_proposal_reservation_witness_detects_truncated_authority_tail_even_with_adjusted_count(self):
        grant = self.issue()
        adapter = FakeAdapter()
        self.assertEqual(self.broker(self.store, grant, adapter).submit(self.template)["state"], "complete")
        with self.admin.transaction():
            deleted = self.admin.execute("DELETE FROM verdict_signer.private_events WHERE deployment_id=%s AND namespace=%s AND digest='authority' AND body->>'type'='reserved'", (self.deployment, self.namespace)).rowcount
            self.assertEqual(deleted, 1)
            self.admin.execute("UPDATE verdict_signer.private_namespaces SET event_count=event_count-1 WHERE deployment_id=%s AND namespace=%s", (self.deployment, self.namespace))
        self.assertEqual(len(self.store.read("authority")), 1)
        with self.assertRaisesRegex(BrokerError, "Reservation ledger missing or truncated"):
            PolicyAuthority(self.open(), grant["grantId"])
        self.assertEqual(adapter.sent, 1)

    def test_deleted_table_fails_closed_and_ordinary_open_never_creates_schema(self):
        # All schemas in this child database belong only to this test class.
        self.admin.execute("ALTER TABLE verdict_signer.private_events RENAME TO private_events_test_hidden")
        try:
            with self.assertRaises(BrokerError):
                self.open()
        finally:
            # Restore only as an explicit test-admin action, never through runtime code.
            self.admin.execute("ALTER TABLE verdict_signer.private_events_test_hidden RENAME TO private_events")
        self.assertEqual(self.open().read("authority"), [])


if __name__ == "__main__":
    unittest.main()
