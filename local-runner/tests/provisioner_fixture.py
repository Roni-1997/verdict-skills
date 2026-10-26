"""INERT integration only: actual private control/vault/authority/broker Unix RPC.

No SDK client, venue HTTP, user key or real transaction is used. State and counters
survive process restarts so OAuth/MCP integration can prove original identities.
"""
import argparse
import contextlib
import json
import multiprocessing
import os
from pathlib import Path
import signal
import socket
import sqlite3
import sys
import time

from verdict_broker.authority import PolicyAuthority
from verdict_broker.core import Broker, BrokerError, D, Observation, Preflight, Receipt, Store
from verdict_broker.provisioner import Provisioner, address, serve_provisioner
from verdict_broker.rpc import serve_local

PUBLIC = "0x" + "1" * 80


class FixtureVenue:
    def __init__(self, root, owner):
        self.path, self.owner = root / "fixture-venue.json", owner
        if not self.path.exists():
            self.save({"owner": owner, "account": None, "keys": {"4": "0x" + "2" * 80}, "registrations": 0, "faucets": 0})
        if self.read()["owner"] != owner:
            raise BrokerError("Fixture owner must remain fixed across restart")

    def read(self):
        return json.loads(self.path.read_text())

    def save(self, value):
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value))
        temporary.chmod(0o600)
        temporary.replace(self.path)

    def account(self, owner):
        if owner != self.owner:
            raise BrokerError("Wrong synthetic owner")
        return self.read()["account"]

    def verify_owner(self, account, owner):
        if self.account(owner) != account:
            raise BrokerError("Wrong synthetic account")

    def funding_required(self, account, owner):
        self.verify_owner(account, owner)
        return False

    def keys(self, account):
        return {int(slot): key for slot, key in self.read()["keys"].items()}

    def nonce(self, account, slot):
        return 7

    def generate(self):
        return {"privateKey": "INERT-FIXTURE-NOT-A-VENUE-KEY", "publicKey": PUBLIC}

    def registration(self, record):
        message = ("Register Lighter Account\n\npubkey: " + record["publicKey"]
                   + "\nnonce: 0x" + format(record["nonce"], "016x")
                   + "\naccount index: 0x" + format(record["account"], "016x")
                   + "\napi key index: 0x" + format(record["apiKeyIndex"], "016x")
                   + "\nOnly sign this message for a trusted client!")
        return {"message": message, "txType": 8, "txInfo": "{}", "txHash": "INERT-NO-TRANSACTION"}

    def send(self, record, signature):
        state = self.read()
        state["registrations"] += 1
        state["keys"][str(record["apiKeyIndex"])] = record["publicKey"]
        self.save(state)
        return {"accepted": True}

    def ready(self, record):
        return self.keys(record["account"]).get(record["apiKeyIndex"]) == record["publicKey"]

    def faucet(self, owner):
        if owner != self.owner:
            raise BrokerError("Wrong synthetic faucet owner")
        state = self.read()
        state["faucets"] += 1
        state["account"] = 42
        self.save(state)


def fixture_worker(socket_path, state_path, metrics_path, target, owner, grant_id):
    database = sqlite3.connect(Path(state_path) / "fixture-orders.sqlite")
    database.execute("CREATE TABLE IF NOT EXISTS orders(client TEXT PRIMARY KEY, market INTEGER, shares TEXT, status TEXT)")
    database.execute("CREATE TABLE IF NOT EXISTS calls(client TEXT NOT NULL)")
    database.commit()

    class Adapter:
        def inventory(self, leg):
            return sum((D(row[0]) for row in database.execute("SELECT shares FROM orders WHERE market=?", (leg["market"],))), D(0))

        def inspect_connection(self, legs):
            return {"ownerWallet": owner, "agentAddress": None, "checks": {"registration": "ready", "builder": "ready"}, "notes": ["INERT fixture, not venue evidence."]}

        def preflight(self, leg, client_id):
            return Preflight(str(self.inventory(leg)), "1000", "0", {}, time.time())

        def submit(self, leg, client_id, preflight):
            if preflight.before_transport is not None:
                preflight.before_transport()
            with database:
                database.execute("INSERT INTO calls(client) VALUES(?)", (client_id,))
                database.execute("INSERT INTO orders VALUES(?,?,?,?)", (client_id, leg["market"], leg["shares"], "filled"))
            metrics = Path(metrics_path)
            temporary = metrics.with_suffix(".tmp")
            count = database.execute("SELECT count(*) FROM calls").fetchone()[0]
            temporary.write_text(json.dumps({"inert": True, "submissions": count, "sends": count}))
            temporary.replace(metrics)
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
        if any(leg.get(key) != value for key, value in target.items()):
            raise BrokerError("Synthetic worker target mismatch")
        return Adapter()

    broker_store = Store(Path(state_path))
    broker = Broker(broker_store, factory, authority=PolicyAuthority(broker_store, grant_id), poll_seconds=0)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        serve_local(Path(socket_path), broker)
    finally:
        database.close()


class FixtureWorkers:
    def __init__(self, root, sockets):
        self.root, self.sockets, self.children = root, sockets, {}

    def ensure(self, record):
        binding = record["binding"]
        current = self.children.get(binding["id"])
        if current is not None and current.is_alive():
            return
        path = Path(binding["brokerSocket"])
        if path.exists():
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                try:
                    probe.connect(str(path))
                except ConnectionRefusedError:
                    path.unlink()
                else:
                    raise BrokerError("Original fixture worker is still active")
        worker = multiprocessing.get_context("spawn").Process(target=fixture_worker,
                 args=(str(path), str(self.root / "state" / record["id"]), str(self.root / "metrics.json"),
                       binding["accounts"][0], record["owner"], binding["grantId"]), daemon=True)
        worker.start()
        self.children[binding["id"]] = worker
        deadline = time.monotonic() + 5
        while not path.exists() and worker.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        if not path.exists():
            raise BrokerError("Fixture worker failed to start")

    def close(self):
        for child in self.children.values():
            if child.is_alive():
                child.terminate()
            child.join(timeout=3)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--mode", choices=["per_order", "policy"], required=True)
    args = parser.parse_args()
    root = Store(args.root).root
    sockets = Store(root / "sockets").root
    Store(args.socket.parent)
    key = root / "fixture-wrapping-key"
    if not key.exists():
        key.write_bytes(os.urandom(32))
        key.chmod(0o600)
    if not (root / "metrics.json").exists():
        (root / "metrics.json").write_text(json.dumps({"inert": True, "submissions": 0, "sends": 0}))
    if args.socket.exists():
        args.socket.unlink()  # only a caller-created temporary fixture path
    config = {"origin": args.origin, "stateDir": str(root / "state"), "socketDir": str(sockets), "wrappingKeyFile": str(key),
              "mode": args.mode, "creators": [7], "maxOrderDebitUSDC": "10", "maxDebitUSDC": "100", "maxOrders": 20, "grantTtlSeconds": 3600}
    service = Provisioner(config, venue=FixtureVenue(root, address(args.owner)), workers=FixtureWorkers(root, sockets))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        serve_provisioner(args.socket, service)
    finally:
        service.close()


if __name__ == "__main__":
    main()
