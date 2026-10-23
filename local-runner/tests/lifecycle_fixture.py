"""Nonfunded integration fixture: real broker/authority/RPC, deterministic fake venue."""
from pathlib import Path
import signal
import sys
import time

from verdict_broker.authority import PolicyAuthority, issue_grant
from verdict_broker.core import Broker, D, Observation, Preflight, Receipt, Store, load_proposal
from verdict_broker.rpc import serve_local


def main():
    template, socket_path, state_dir = map(Path, sys.argv[1:])
    store = Store(state_dir)
    proposal = load_proposal(template)
    grant = issue_grant(store, [proposal], max_debit_usdc="100", max_orders=20,
                        expires_at_ms=int(time.time() * 1000) + 600_000,
                        cancel_own_orders=True, confirm=lambda _: True)

    class FakeVenue:
        inventory = D(0)
        orders = {}

        def preflight(self, leg, client_id):
            return Preflight(format(self.inventory, 'f'), "1000", "0.01", {}, time.time())

        def submit(self, leg, client_id, preflight):
            if preflight.before_transport is not None:
                preflight.before_transport()
            partial = leg["shares"] == "9"
            filled = D(4) if partial else D(leg["shares"])
            self.inventory += filled
            self.orders[client_id] = ("canceled" if partial else "filled", filled)
            return Receipt(order_id=client_id)

        def observe(self, leg, client_id, receipt):
            state, filled = self.orders.get(client_id, ("unknown", D(0)))
            return Observation(state, format(filled, 'f'), format(self.inventory, 'f'), state != "unknown")

        def cancel(self, leg, client_id, receipt):
            if client_id in self.orders:
                self.orders[client_id] = ("canceled", self.orders[client_id][1])

        def close(self):
            pass

    venue = FakeVenue()
    broker = Broker(store, lambda _: venue, authority=PolicyAuthority(store, grant["grantId"]), poll_seconds=0)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    serve_local(socket_path, broker)


if __name__ == "__main__":
    main()
