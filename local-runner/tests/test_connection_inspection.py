"""Read-only inspection with inert SDK ports; no credentials, signatures or live calls."""
from copy import deepcopy
from pathlib import Path
import json
import tempfile
import time
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

from verdict_broker.adapters import Hyperliquid, Lighter
from verdict_broker.authority import HumanAuthority, PolicyAuthority, issue_grant
from verdict_broker.core import Broker, BrokerError, Store
from verdict_broker.rpc import _dispatch
from test_broker import proposal

OWNER = "0x" + "1" * 40
AGENT = "0x" + "3" * 40


class InspectionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "state")
        self.template = proposal(False)
        self.grant = issue_grant(self.store, [self.template], max_debit_usdc="25", max_orders=7,
                                expires_at_ms=int((time.time() + 3600) * 1000), cancel_own_orders=True, confirm=lambda _: True)
        self.adapter = Mock()
        self.adapter.inspect_connection.return_value = {"ownerWallet": OWNER, "agentAddress": AGENT,
            "checks": {"registration": "ready", "builder": "missing"}, "notes": ["Separate builder approval required."]}
        self.factory = Mock(return_value=self.adapter)
        self.broker = Broker(self.store, self.factory, authority=PolicyAuthority(self.store, self.grant["grantId"]))
        self.request = {"operation": "inspectConnection", "expectedMode": "policy", "expectedGrantId": self.grant["grantId"]}

    def tearDown(self):
        self.tmp.cleanup()

    def test_inspects_saved_scope_without_reserving_or_sending(self):
        before = self.store.read("authority")
        result = _dispatch(self.broker, self.request)
        self.assertEqual(result["kind"], "execution_connection_inspection")
        self.assertEqual(result["templates"], [self.template])
        self.assertEqual((result["maxDebitUSDC"], result["maxOrders"]), ("25", 7))
        row = result["accounts"][0]
        self.assertEqual(row["account"], {"venue": "hl", "network": "testnet", "account": OWNER})
        self.assertEqual(row["ownerWallet"], OWNER)
        self.assertEqual(row["checks"], {"registration": "ready", "builder": "missing"})
        self.assertGreater(row["checkedAt"], 0)
        self.assertFalse(result["fundedAcceptanceVerified"])
        self.assertEqual(self.store.read("authority"), before)
        self.factory.assert_called_once_with(self.template["payload"]["legs"][0])
        self.adapter.inspect_connection.assert_called_once_with(self.template["payload"]["legs"])
        self.adapter.close.assert_called_once()
        self.adapter.submit.assert_not_called()
        self.adapter.preflight.assert_not_called()
        self.adapter.cancel.assert_not_called()

    def test_original_limits_remain_distinct_from_reserved_budget_and_accounts_deduplicate(self):
        with self.store.authority_locked():
            self.broker.authority.reserve(self.template)
        result = self.broker.inspect_connection()
        self.assertEqual((result["maxDebitUSDC"], result["maxOrders"]), ("25", 7))
        self.assertEqual(result["authority"]["remainingOrders"], 6)
        self.assertNotEqual(result["authority"]["remainingDebitUSDC"], result["maxDebitUSDC"])
        grant = issue_grant(self.store, [self.template, self.template], max_debit_usdc="25", max_orders=7,
                            expires_at_ms=int((time.time() + 3600) * 1000), cancel_own_orders=True, confirm=lambda _: True)
        broker = Broker(self.store, self.factory, authority=PolicyAuthority(self.store, grant["grantId"]))
        self.factory.reset_mock()
        result = broker.inspect_connection()
        self.assertEqual(len(result["templates"]), 2)
        self.assertEqual(len(result["accounts"]), 1)
        self.factory.assert_called_once()
        self.assertEqual(len(self.adapter.inspect_connection.call_args.args[0]), 2)

    def test_requires_pinned_policy_and_rejects_selectors_before_adapter(self):
        for change in [{"expectedGrantId": "22222222-2222-4222-8222-222222222222"}, {"account": OWNER},
                       {"proposal": self.template}, {"privateKey": "inert"}, {"expectedMode": "per_order"}]:
            with self.subTest(change=change), self.assertRaises(BrokerError):
                _dispatch(self.broker, {**self.request, **change})
        with self.assertRaises(BrokerError):
            _dispatch(self.broker, {"operation": "inspectConnection", "expectedMode": "policy"})
        self.factory.assert_not_called()
        human = Broker(self.store, self.factory, authority=HumanAuthority(lambda _: True))
        with self.assertRaises(BrokerError):
            human.inspect_connection()

    def test_adapter_failures_return_unknown_without_leaking_exception(self):
        self.factory.side_effect = RuntimeError("VERDICT_HL_AGENT_PRIVATE_KEY private-secret /secret/socket")
        result = _dispatch(self.broker, self.request)
        row = result["accounts"][0]
        self.assertIsNone(row["ownerWallet"])
        self.assertIsNone(row["agentAddress"])
        self.assertEqual(row["checks"], {"registration": "unknown", "builder": "unknown"})
        encoded = json.dumps(result)
        for forbidden in ["VERDICT_", "private-secret", "/secret/socket"]:
            self.assertNotIn(forbidden, encoded)

    def test_polymarket_is_explicitly_unsupported_without_loading_credentials(self):
        template = deepcopy(self.template)
        leg = template["payload"]["legs"][0]
        for key in ["outcome", "builder", "allInFeeBpsCap"]:
            del leg[key]
        leg.update(venue="polymarket", network="polygon", marketId="123", assetId="123", tif="FAK")
        from verdict_broker.core import node_call
        template = node_call(["execution", "prepare", "--input", json.dumps({"legs": [leg], "policy": template["payload"]["policy"]})])
        grant = issue_grant(self.store, [template], max_debit_usdc="25", max_orders=7,
                            expires_at_ms=int((time.time() + 3600) * 1000), cancel_own_orders=True, confirm=lambda _: True)
        broker = Broker(self.store, self.factory, authority=PolicyAuthority(self.store, grant["grantId"]))
        result = broker.inspect_connection()
        self.assertIsNone(result["accounts"][0]["ownerWallet"])
        self.assertEqual(result["accounts"][0]["checks"]["registration"], "unknown")
        self.factory.assert_not_called()


class AdapterInspectionTest(unittest.TestCase):
    def hl(self, agents, builder=10):
        adapter = object.__new__(Hyperliquid)
        adapter.wallet = NS(address=AGENT)
        adapter.info = Mock(side_effect=lambda kind, **_: agents if kind == "extraAgents" else builder)
        return adapter

    def test_hl_actual_public_agent_and_registration_expiry_builder_checks(self):
        legs = [{"account": OWNER, "builder": {"address": "0x" + "2" * 40, "feeTenthsBp": 10}}]
        for agents, expected in [([], "missing"), ([{"address": AGENT, "validUntil": 1}], "missing"),
                ([{"address": AGENT.upper().replace("0X", "0x"), "validUntil": int(time.time() * 1000) + 60000}], "ready"),
                ([{"address": AGENT, "validUntil": "9999999999999"}], "unknown"), ([{"address": AGENT, "validUntil": True}], "unknown")]:
            result = self.hl(agents).inspect_connection(legs)
            self.assertEqual(result["agentAddress"], AGENT)
            self.assertEqual(result["ownerWallet"], OWNER)
            self.assertEqual(result["checks"]["registration"], expected)
        adapter = self.hl([], builder=9)
        self.assertEqual(adapter.inspect_connection(legs)["checks"]["builder"], "missing")
        adapter = self.hl([], builder="999")
        self.assertEqual(adapter.inspect_connection(legs)["checks"]["builder"], "unknown")
        # Every saved builder requirement on an account must pass.
        adapter = self.hl([], builder=10)
        self.assertEqual(adapter.inspect_connection([*legs, {**legs[0], "builder": {"address": "0x" + "4" * 40, "feeTenthsBp": 11}}])["checks"]["builder"], "missing")
        self.assertEqual(adapter.info.call_count, 3)

    def lighter(self, response, error=None):
        adapter = object.__new__(Lighter)
        adapter.signer = NS(api_client=object(), check_client=Mock(return_value=error))
        adapter.run = lambda value: value
        api = Mock()
        api.account.return_value = response
        return adapter, api

    def test_lighter_fresh_numeric_account_owner_and_key_checks_no_coercions(self):
        for index, owner, error, expected_owner, expected in [
            (42, OWNER, None, OWNER, "ready"), (42, OWNER, "inactive", OWNER, "missing"),
            (42, OWNER, "", OWNER, "unknown"), (42, OWNER, False, OWNER, "unknown"),
            ("42", OWNER, None, None, "unknown"), (True, OWNER, None, None, "unknown"),
            (43, OWNER, None, None, "unknown"), (42, None, None, None, "unknown"),
            (42, "invalid", None, None, "unknown"), (42, "0x" + "0" * 40, None, None, "unknown")]:
            response = NS(code=200, accounts=[NS(index=index, l1_address=owner)])
            adapter, api = self.lighter(response, error)
            with patch.dict("sys.modules", {"lighter": NS(AccountApi=lambda _: api)}):
                result = adapter.inspect_connection([{"account": 42}])
            self.assertEqual(result["ownerWallet"], expected_owner)
            self.assertEqual(result["checks"]["registration"], expected)
            self.assertIsNone(result["agentAddress"])
            api.account.assert_called_once_with(by="index", value="42", _request_timeout=15)
            adapter.signer.check_client.assert_called_once()
        adapter, api = self.lighter(NS(code=200, accounts=[]))
        with patch.dict("sys.modules", {"lighter": NS(AccountApi=lambda _: api)}):
            self.assertEqual(adapter.inspect_connection([{"account": "42"}])["checks"]["registration"], "unknown")
        api.account.assert_not_called()


if __name__ == "__main__":
    unittest.main()
