"""INERT ONLY: real signer HTTP, PostgreSQL vault/authority, fresh broker processes.

This fixture never imports a venue SDK or contacts a venue. Its order receipts are
synthetic. PostgreSQL is disposable test infrastructure, not a cloud deployment.
"""
import argparse
import contextlib
from http.server import ThreadingHTTPServer
import json
import multiprocessing
import os
from pathlib import Path
import signal
import sqlite3
import sys
import time

import psycopg

from verdict_broker.authority import PolicyAuthority
from verdict_broker.core import Broker, BrokerError, D, Observation, Preflight, Receipt
from verdict_broker.postgres_store import POSTGRES_STORE_DDL, PostgresStore
from verdict_broker.private_vault import ENROLLMENTS_DDL, SIGNER_REQUESTS_DDL, canonical_uuid
from verdict_broker.provisioner import address
from verdict_broker.rpc import _dispatch
from verdict_broker.signer_http import PostgresSigner, SignerHTTP, VercelHandler, _clean_child_environment, key_from_base64
from provisioner_fixture import FixtureVenue


def _broker(pipe, config, record, request):
    _clean_child_environment()
    store = None
    database = None
    try:
        database = sqlite3.connect(Path(config["fixtureRoot"]) / "inert-orders.sqlite")
        database.execute("CREATE TABLE IF NOT EXISTS orders(client TEXT PRIMARY KEY, market INTEGER, shares TEXT, status TEXT)")
        database.execute("CREATE TABLE IF NOT EXISTS calls(client TEXT NOT NULL)")
        database.commit()
        class Adapter:
            def inventory(self, leg):
                return sum((D(row[0]) for row in database.execute("SELECT shares FROM orders WHERE market=?", (leg["market"],))), D(0))

            def inspect_connection(self, legs):
                return {"ownerWallet": record["owner"], "agentAddress": None, "checks": {"registration": "ready", "builder": "ready"}, "notes": ["INERT fixture; never venue evidence."]}

            def preflight(self, leg, client_id):
                return Preflight(str(self.inventory(leg)), "1000", "0", {}, time.time())

            def submit(self, leg, client_id, preflight):
                if preflight.before_transport is not None:
                    preflight.before_transport()
                with database:
                    database.execute("INSERT INTO calls VALUES(?)", (client_id,))
                    database.execute("INSERT INTO orders VALUES(?,?,?,'filled')", (client_id, leg["market"], leg["shares"]))
                count = database.execute("SELECT count(*) FROM calls").fetchone()[0]
                path = Path(config["fixtureRoot"]) / "metrics.json"
                temporary = path.with_suffix(".tmp")
                temporary.write_text(json.dumps({"inert": True, "sends": count}))
                temporary.replace(path)
                return Receipt(order_id=client_id)

            def observe(self, leg, client_id, receipt):
                row = database.execute("SELECT shares,status FROM orders WHERE client=?", (client_id,)).fetchone()
                return Observation(row[1] if row else "unknown", row[0] if row else "0", str(self.inventory(leg)), row is not None)

            def cancel(self, leg, client_id, receipt):
                with database:
                    database.execute("UPDATE orders SET status='canceled' WHERE client=?", (client_id,))

            def close(self):
                pass
        def factory(leg):
            if any(leg.get(k) != value for k, value in record["binding"]["accounts"][0].items()):
                raise BrokerError("Inert worker target mismatch")
            return Adapter()
        store = PostgresStore(config["dsn"], deployment=config["deploymentId"], namespace=record["id"], database_id=config["databaseId"])
        broker = Broker(store, factory, authority=PolicyAuthority(store, record["binding"]["grantId"]), poll_seconds=0)
        pipe.send({"ok": True, "result": _dispatch(broker, request)})
    except Exception:
        pipe.send({"ok": False, "error": "Inert broker unavailable"})
    finally:
        if database:
            database.close()
        if store:
            store.close()
        pipe.close()


def inert_broker(config, record, request):
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    subset = {k: config[k] for k in ("dsn", "deploymentId", "databaseId", "fixtureRoot")}
    process = context.Process(target=_broker, args=(child, subset, record, request), daemon=True)
    process.start()
    child.close()
    try:
        if not parent.poll(15):
            raise BrokerError("Inert broker timed out")
        result = parent.recv()
        if not result.get("ok"):
            raise BrokerError("Inert broker unavailable")
        return result["result"]
    finally:
        parent.close()
        process.join(timeout=1)
        if process.is_alive():
            process.terminate()
            process.join(timeout=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--mode", choices=("per_order", "policy"), required=True)
    parser.add_argument("--deployment-id", required=True)
    parser.add_argument("--database-id", required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    deployment, database_id = canonical_uuid(args.deployment_id), canonical_uuid(args.database_id)
    root = args.root.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    wrapping = root / "INERT-wrapping-key"
    if not wrapping.exists():
        wrapping.write_bytes(os.urandom(32))
        wrapping.chmod(0o600)
    dsn = os.environ["VERDICT_TEST_POSTGRES_DSN"]
    # Test administrator bootstrap only, and only if this deployment is NEW.
    with psycopg.connect(dsn, autocommit=True) as admin:
        admin.execute(POSTGRES_STORE_DDL)
        admin.execute(ENROLLMENTS_DDL)
        admin.execute(SIGNER_REQUESTS_DDL)
        with admin.transaction():
            new = admin.execute("INSERT INTO verdict_signer.runtime_metadata VALUES(%s,%s,1) ON CONFLICT DO NOTHING RETURNING database_id", (deployment, database_id)).fetchone()
            if new is not None:
                admin.execute("INSERT INTO verdict_signer.vault_state VALUES(%s,0)", (deployment,))
            if admin.execute("SELECT database_id::text FROM verdict_signer.runtime_metadata WHERE deployment_id=%s", (deployment,)).fetchone() != (database_id,):
                raise BrokerError("Inert database identity changed")
    config = {"dsn": dsn, "deploymentId": deployment, "databaseId": database_id, "wrappingKey": wrapping.read_bytes(), "fixtureRoot": str(root),
              "provisioning": {"runtime": "hosted_signer", "origin": args.origin, "mode": args.mode, "creators": [7],
                               "maxOrderDebitUSDC": "10", "maxDebitUSDC": "100", "maxOrders": 20, "grantTtlSeconds": 3600}}
    service_key = key_from_base64(os.environ["VERDICT_TEST_SIGNER_SERVICE_KEY"])
    venue = FixtureVenue(root, address(args.owner))
    class Handler(VercelHandler):
        def service(self):
            return SignerHTTP(deployment=deployment, service_key=service_key, factory=lambda: PostgresSigner(config, venue=venue, broker=inert_broker))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as listener:
        print(json.dumps({"inert": True, "port": listener.server_address[1]}), flush=True)
        listener.serve_forever(poll_interval=0.1)


if __name__ == "__main__":
    main()
