"""Consumer envelopes authorize changing markets, never changing owners or limits."""
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock

from verdict_broker.adapters import Lighter
from verdict_broker.authority import PolicyAuthority, _reservation_debit, consumer_scope, revoke_grant
from verdict_broker.core import Broker, BrokerError, Store, node_call
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from test_broker import FakeAdapter, request
import test_provisioner as provisioning_fixture
from test_provisioner import OWNER


def proposal(**change):
    value = request(True)
    value["legs"] = [{**value["legs"][1], "network": "testnet", "apiKeyIndex": 5, **change}]
    value["settlementReview"] = None
    value["policy"] = {"maxTotalDebitUSDC": "100", "maxLegDebitUSDC": "100"}
    return node_call(["execution", "prepare", "--input", json.dumps(value)])


class ConsumerAuthorityTest(unittest.TestCase):
    def setUp(self):
        self.fixture = provisioning_fixture.ProvisionerTest()
        self.fixture.setUp()
        self.fixture.now = time.time()
        self.plan, _, self.binding = self.fixture.activate()
        self.store = Store(Path(self.fixture.config["stateDir"]) / self.plan["enrollmentId"])
        self.authority = PolicyAuthority(self.store, self.binding["grantId"])
        self.adapter = FakeAdapter()
        self.adapter.inspect_connection = Mock(return_value={"ownerWallet": OWNER, "agentAddress": None,
                                                           "checks": {"registration": "ready", "builder": "ready"}, "notes": []})
        self.broker = Broker(self.store, lambda _: self.adapter, authority=self.authority, poll_seconds=0)

    def tearDown(self):
        self.fixture.tearDown()

    def test_new_market_qualifies_and_inspection_has_one_scope_bound_account(self):
        for market in (456, 999):
            self.assertEqual(self.broker.preflight(proposal(market=market))["state"], "ready")
        result = self.broker.inspect_connection()
        self.assertEqual(result["scope"], self.plan["scope"])
        self.assertEqual(result["templates"], [])
        self.assertEqual(result["accounts"][0]["account"], self.binding["accounts"][0])
        self.assertEqual(self.adapter.sent, 0)

    def test_wrong_account_network_slot_creator_sell_and_resting_rejected(self):
        for changed in ({"account": 43}, {"network": "mainnet"}, {"network": "devnet"}, {"apiKeyIndex": 4},
                        {"creator": 8}, {"action": "sell"}, {"tif": "gtc"}, {"shares": "30"}):
            with self.subTest(changed=changed), self.assertRaises(BrokerError):
                self.broker.preflight(proposal(**changed))
        self.assertEqual(self.adapter.sent, 0)

    def test_owner_and_registration_rechecked_independently_before_send(self):
        for inspection in ({"ownerWallet": "0x" + "f" * 40, "checks": {"registration": "ready"}},
                           {"ownerWallet": OWNER, "checks": {"registration": "missing"}}):
            self.adapter.inspect_connection.return_value = inspection
            with self.assertRaises(BrokerError):
                self.broker.preflight(proposal())
        self.assertEqual(self.adapter.sent, 0)

    def test_cumulative_order_and_money_reservation_and_revoke_after_sign(self):
        for market in (456, 457, 458):
            self.broker.submit(proposal(market=market))
        self.assertEqual(self.adapter.sent, 3)
        with self.assertRaises(BrokerError):
            self.broker.submit(proposal(market=459))
        self.assertEqual(self.adapter.sent, 3)
        self.assertEqual(self.authority.describe()["remainingOrders"], 0)
        revoke_grant(self.store, self.binding["grantId"])
        with self.assertRaises(BrokerError):
            self.authority.before_transport(proposal())

    def test_consumer_cost_rounds_both_notional_and_fees_up_to_usdc_units(self):
        p = {"payload": {"legs": [{"action": "buy", "shares": "1.00000001", "limitPrice": "0.00000001", "feeReserveUSDC": "0.00000001"}]}}
        self.assertEqual(_reservation_debit({"kind": "consumer_lighter"}, p), 2_000_000)
        self.assertLess(_reservation_debit({}, p), 2_000_000)

    def test_immutable_scope_and_operator_caps_cannot_be_expanded(self):
        for changed in ({"network": "mainnet"}, {"apiKeyIndex": 4}, {"creators": []}, {"epoch": True}, {"version": True}, {"origin": "https://example.com/path"}):
            with self.subTest(changed=changed), self.assertRaises(BrokerError):
                consumer_scope({**self.plan["scope"], **changed})
        marker = self.store.root / ("grant-" + self.binding["grantId"] + ".json")
        marker.write_text(json.dumps({"grantId": self.binding["grantId"], "grantHash": "f" * 64}))
        with self.assertRaises(BrokerError):
            self.authority.check(proposal())

    def test_cumulative_debit_expiry_and_final_transport_revocation(self):
        for market in (800, 801):
            p = proposal(market=market, shares="24")
            with self.store.authority_locked():
                self.authority.reserve(p)
        with self.assertRaises(BrokerError):
            self.authority.check(proposal(market=802, shares="24"))
        expired = PolicyAuthority(self.store, self.binding["grantId"], clock=lambda: self.fixture.now + 3601)
        with self.assertRaises(BrokerError):
            expired.check(proposal())
        revoke_grant(self.store, self.binding["grantId"])
        with self.assertRaises(BrokerError):
            self.authority.before_transport(proposal(market=800, shares="24"))


class FreshLighterMetadataTest(unittest.TestCase):
    def adapter(self, changed=None, book_changed=None):
        leg = proposal()["payload"]["legs"][0]
        market = {"market_id": 456, "network": "testnet", "market_type": "binary_options", "status": "active", "is_frozen": False,
                  "start_timestamp": int((time.time() - 60) * 1000), "end_timestamp": int((time.time() + 60) * 1000),
                  "price_decimals": 4, "size_decimals": 4, "settlement_cap": 10000, "creator": 7,
                  "title": leg["title"], "settlementRule": leg["settlementRule"], "taker_fee": "1", "maker_fee": "0",
                  "is_taker_fee_enabled": True, "is_maker_fee_enabled": False}
        market.update(changed or {})
        book_market = {**market, **(book_changed or {})}
        adapter = object.__new__(Lighter)
        adapter.signer = NS(check_client=lambda: None, create_auth_token_with_expiry=lambda **_: ("synthetic-auth", None))
        adapter.key_index = 5
        adapter.orders = NS(account_active_orders=lambda **_: NS(code=200, orders=[]))
        adapter.run = lambda value: value
        adapter.inventory = lambda _: (0, 0, 100)
        adapter.bridge = Mock(side_effect=[{"market": market, "sdkArgs": {}}, {"market": book_market,
                                "bids": [{"price": "0.6", "shares": "100"}], "asks": [{"price": "0.7", "shares": "100"}]}])
        return adapter, leg, market

    def test_fresh_window_creator_network_contract_and_book_revision_are_independent(self):
        cases = ({"market_id": 457}, {"network": "mainnet"}, {"market_type": "perp"}, {"creator": 8}, {"status": "settled"},
                 {"is_frozen": True}, {"end_timestamp": 1}, {"start_timestamp": 9_000_000_000_000_000}, {"settlement_cap": 2},
                 {"settlementRule": "changed resolution"})
        for changed in cases:
            with self.subTest(changed=changed), self.assertRaises(BrokerError):
                adapter, leg, _ = self.adapter(changed)
                adapter.preflight(leg, "a" * 64)
        for changed in ({"creator": 8}, {"settlementRule": "changed"}, {"status": "settled"}):
            with self.subTest(book_changed=changed), self.assertRaises(BrokerError):
                adapter, leg, _ = self.adapter(book_changed=changed)
                adapter.preflight(leg, "a" * 64)

    def test_fees_use_global_price_bound_and_preflight_deadline_includes_close(self):
        adapter, leg, market = self.adapter()
        result = adapter.preflight(leg, "a" * 64)
        self.assertEqual(result.required_fee, "0.025000")
        self.assertEqual(result.valid_until, market["end_timestamp"] / 1000)


if __name__ == "__main__":
    unittest.main()
