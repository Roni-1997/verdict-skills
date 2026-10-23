"""Operator authority and durable lifecycle tests; fake venues, no keys or funds."""
from dataclasses import replace
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from verdict_broker.authority import HumanAuthority, PolicyAuthority, issue_grant, inspect_grant, revoke_grant
from verdict_broker.core import Broker, BrokerError, Store, account_key, node_call
from test_broker import FakeAdapter, proposal, request


def prepare(value):
    return node_call(["execution", "prepare", "--input", json.dumps(value)])


class AuthorityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "state")
        self.template = proposal(False)
        self.grant = self.issue([self.template])
        self.authority = PolicyAuthority(self.store, self.grant["grantId"])
        self.a = FakeAdapter()
        self.broker = Broker(self.store, lambda _: self.a, authority=self.authority, poll_seconds=0)

    def tearDown(self):
        self.tmp.cleanup()

    def issue(self, templates, *, debit="25", orders=10, cancel=True):
        return issue_grant(self.store, templates, max_debit_usdc=debit, max_orders=orders,
                           expires_at_ms=int((time.time() + 3600) * 1000), cancel_own_orders=cancel, confirm=lambda _: True)

    def test_mandatory_authority_and_operator_grant_confirmation(self):
        with self.assertRaises(TypeError):
            Broker(self.store, lambda _: self.a)
        with self.assertRaisesRegex(BrokerError, "did not approve"):
            issue_grant(self.store, [self.template], max_debit_usdc="1", max_orders=1,
                        expires_at_ms=int((time.time() + 60) * 1000), cancel_own_orders=False, confirm=lambda _: False)
        self.assertEqual(len([e for e in self.store.read("authority") if e["type"] == "grant_issued"]), 1)

    def test_preflight_shares_price_fee_bounds_and_no_authorization(self):
        value = request(False)
        value["legs"][0].update(shares="9", limitPrice="0.39", feeReserveUSDC="0.09")
        result = self.broker.preflight(prepare(value))
        self.assertEqual((result["state"], result["authorization"], self.a.sent), ("ready", "none", 0))
        self.assertEqual(result["authority"]["remainingOrders"], 10)
        self.assertEqual(len(self.store.read("authority")), 1)
        self.assertEqual(set(result["legs"][0]), {"leg", "inventoryShares", "availableUSDC", "feeBoundUSDC", "checkedAt", "validUntil"})

    def test_every_identity_and_envelope_expansion_is_denied(self):
        changes = [
            {"account": "0x" + "3" * 40}, {"network": "mainnet"}, {"outcome": 124},
            {"title": "Changed title"}, {"settlementRule": "Changed oracle rule"},
            {"tif": "Gtc"}, {"side": "no"}, {"action": "sell"},
            {"shares": "11"}, {"limitPrice": "0.41"}, {"feeReserveUSDC": "0.11"},
            {"builder": {"address": "0x" + "4" * 40, "feeTenthsBp": 0}},
            {"builder": {"address": "0x" + "2" * 40, "feeTenthsBp": 1}},
            {"allInFeeBpsCap": "11"},
        ]
        for change in changes:
            with self.subTest(change=change):
                value = request(False)
                value["legs"][0].update(change)
                with self.assertRaisesRegex(BrokerError, "template scope"):
                    self.broker.preflight(prepare(value))
        self.assertEqual(self.a.sent, 0)

    def test_loosened_proposal_caps_do_not_expand_operator_scope(self):
        for key in ["maxTotalDebitUSDC", "maxLegDebitUSDC"]:
            value = request(False)
            value["policy"][key] = "11"
            with self.subTest(key=key), self.assertRaisesRegex(BrokerError, "template scope"):
                self.broker.preflight(prepare(value))

    def test_sell_template_only_allows_better_price_and_bounded_inventory(self):
        value = request(False)
        value["legs"][0].update(action="sell")
        template = prepare(value)
        grant = self.issue([template])
        broker = Broker(self.store, lambda _: self.a, authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        self.a.check = replace(self.a.check, inventory="10")
        value["legs"][0]["limitPrice"] = "0.41"
        self.assertEqual(broker.preflight(prepare(value))["state"], "ready")
        value["legs"][0]["limitPrice"] = "0.39"
        with self.assertRaisesRegex(BrokerError, "template scope"):
            broker.preflight(prepare(value))

    def test_lighter_creator_and_api_key_are_frozen(self):
        value = request(True)
        value["legs"] = [value["legs"][1]]
        value["settlementReview"] = None
        grant = self.issue([prepare(value)])
        broker = Broker(self.store, lambda _: self.a, authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        for field in ["creator", "apiKeyIndex", "market"]:
            altered = json.loads(json.dumps(value))
            altered["legs"][0][field] += 1
            with self.subTest(field=field), self.assertRaisesRegex(BrokerError, "template scope"):
                broker.preflight(prepare(altered))

    def test_two_singles_do_not_authorize_an_agent_pair(self):
        pair_request = request(True)
        second = request(True)
        second["legs"] = [second["legs"][1]]
        second["settlementReview"] = None
        grant = self.issue([self.template, prepare(second)])
        broker = Broker(self.store, lambda _: self.a, authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        with self.assertRaisesRegex(BrokerError, "template scope"):
            broker.submit(prepare(pair_request))
        self.assertEqual(self.a.sent, 0)

    def test_ordered_pair_relationship_and_review_are_frozen(self):
        template = proposal(True)
        grant = self.issue([template])
        broker = Broker(self.store, lambda _: self.a, authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        value = request(True)
        value["legs"].reverse()
        with self.assertRaisesRegex(BrokerError, "template scope"):
            broker.preflight(prepare(value))
        value = request(True)
        value["settlementReview"]["notes"] = "The agent invented a different settlement review."
        with self.assertRaisesRegex(BrokerError, "template scope"):
            broker.preflight(prepare(value))

    def test_reservation_is_durable_before_transport_and_repeat_never_recharges(self):
        def inspect_before_transport():
            rows = self.store.read("authority")
            self.assertEqual(rows[-1]["type"], "reserved")
            self.assertEqual(rows[-1]["proposalDigest"], self.template["digest"])
            self.assertTrue(any(e["type"] == "policy_reserved" for e in self.store.read(self.template["digest"])))
            self.assertTrue(any(e["type"] == "attempt_started" for e in self.store.read(self.template["digest"])))
        self.a.on_submit = inspect_before_transport
        self.assertEqual(self.broker.submit(self.template)["state"], "complete")
        self.assertEqual(self.broker.submit(self.template)["state"], "complete")
        self.assertEqual(self.a.sent, 1)
        summary = inspect_grant(self.store, self.grant["grantId"])
        self.assertEqual((summary["remainingDebitUSDC"], summary["remainingOrders"]), ("20.900000000000", 9))

    def test_whole_pair_budget_is_reserved_even_if_first_leg_is_partial(self):
        pair = proposal(True)
        grant = self.issue([pair], debit="8.2", orders=2)
        first, second = FakeAdapter(filled="4", inventory="4", state="canceled"), FakeAdapter()
        broker = Broker(self.store, lambda leg: first if leg["venue"] == "hl" else second,
                        authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        self.assertEqual(broker.submit(pair)["state"], "needs_reconciliation")
        self.assertEqual((first.sent, second.sent), (1, 0))
        summary = inspect_grant(self.store, grant["grantId"])
        self.assertEqual((summary["remainingDebitUSDC"], summary["remainingOrders"]), ("0.000000000000", 0))
        self.assertEqual(summary["newRisk"], "unresolved")

    def test_stranded_full_first_leg_blocks_both_accounts_across_restart_and_grants(self):
        pair = proposal(True)
        grant = self.issue([pair])
        first, second = FakeAdapter(), FakeAdapter()
        first.on_submit = lambda: setattr(second, "fail_preflight", True)
        broker = Broker(self.store, lambda leg: first if leg["venue"] == "hl" else second,
                        authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        result = broker.submit(pair)
        self.assertEqual([leg["state"] for leg in result["legs"]], ["filled", "not_attempted"])
        self.assertEqual(self.store.unresolved_accounts(), {account_key(leg) for leg in pair["payload"]["legs"]})
        second.fail_preflight = False
        first.on_submit = lambda: None
        self.assertEqual(broker.status(pair)["legs"], result["legs"])
        self.assertEqual(inspect_grant(self.store, grant["grantId"])["newRisk"], "unresolved")
        restarted_store = Store(self.store.root)
        for active_grant in [grant, self.issue([pair])]:
            restarted = Broker(restarted_store, lambda leg: first if leg["venue"] == "hl" else second,
                               authority=PolicyAuthority(restarted_store, active_grant["grantId"]), poll_seconds=0)
            for operation in [restarted.preflight, restarted.submit]:
                with self.assertRaisesRegex(BrokerError, "unresolved prior execution"):
                    operation(proposal(True))
        second_only = request(True)
        second_only["legs"] = [second_only["legs"][1]]
        second_only["settlementReview"] = None
        single_grant = self.issue([prepare(second_only)])
        single = Broker(restarted_store, lambda _: second, authority=PolicyAuthority(restarted_store, single_grant["grantId"]), poll_seconds=0)
        with self.assertRaisesRegex(BrokerError, "unresolved prior execution"):
            single.submit(prepare(second_only))
        self.assertEqual((first.sent, second.sent), (1, 0))

    def test_pair_full_first_and_zero_second_remains_fenced(self):
        pair = proposal(True)
        grant = self.issue([pair])
        first, second = FakeAdapter(), FakeAdapter(state="rejected", filled="0", inventory="0")
        broker = Broker(self.store, lambda leg: first if leg["venue"] == "hl" else second,
                        authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        self.assertEqual(broker.submit(pair)["state"], "needs_reconciliation")
        self.assertEqual((first.sent, second.sent), (1, 1))
        self.assertEqual(inspect_grant(self.store, grant["grantId"])["newRisk"], "unresolved")
        with self.assertRaisesRegex(BrokerError, "unresolved prior execution"):
            broker.submit(proposal(True))

    def test_balanced_full_pair_or_proven_empty_pair_can_clear_exposure_fence(self):
        for filled in ["10", "0"]:
            with self.subTest(filled=filled), tempfile.TemporaryDirectory() as path:
                store = Store(Path(path) / "state")
                pair = proposal(True)
                grant = issue_grant(store, [pair], max_debit_usdc="25", max_orders=10,
                                    expires_at_ms=int((time.time() + 3600) * 1000), cancel_own_orders=True, confirm=lambda _: True)
                first = FakeAdapter(state="filled" if filled == "10" else "rejected", filled=filled, inventory=filled)
                second = FakeAdapter()
                broker = Broker(store, lambda leg: first if leg["venue"] == "hl" else second,
                                authority=PolicyAuthority(store, grant["grantId"]), poll_seconds=0)
                broker.submit(pair)
                self.assertEqual(store.unresolved_accounts(), set())
                self.assertEqual(inspect_grant(store, grant["grantId"])["newRisk"], "active")
                self.assertEqual(broker.preflight(proposal(True))["state"], "ready")

    def test_cumulative_budget_persists_across_digests_and_restart(self):
        grant = self.issue([self.template], debit="4.1", orders=1)
        broker = Broker(self.store, lambda _: self.a, authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        self.assertEqual(broker.submit(self.template)["state"], "complete")
        restarted = Broker(Store(self.store.root), lambda _: self.a, authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        with self.assertRaisesRegex(BrokerError, "budget exceeded"):
            restarted.submit(proposal(False))
        self.assertEqual(self.a.sent, 1)

    def test_old_terminal_status_is_frozen_across_later_inventory_and_restart(self):
        old = self.broker.submit(self.template)
        self.a.check = replace(self.a.check, inventory="10", checked_at=time.time())
        self.a.inventory = "20"
        self.assertEqual(self.broker.submit(proposal(False))["state"], "complete")
        self.a.observe = lambda *_: self.fail("frozen execution must not read later inventory")
        self.assertEqual(self.broker.status(self.template), old)
        restarted = Broker(Store(self.store.root), lambda _: self.a, authority=PolicyAuthority(self.store, self.grant["grantId"]), poll_seconds=0)
        self.assertEqual(restarted.status(self.template), old)

    def test_settled_fill_waits_for_inventory_lag_before_freezing(self):
        self.a.inventory = "0"
        first = self.broker.submit(self.template)
        self.assertEqual(first["state"], "needs_reconciliation")
        self.assertFalse(any(e["type"] == "terminal_observation" for e in self.store.read(self.template["digest"])))
        with self.assertRaisesRegex(BrokerError, "unresolved prior execution"):
            self.broker.preflight(proposal(False))
        self.a.inventory = "10"
        self.assertEqual(self.broker.status(self.template)["state"], "complete")
        self.assertEqual(self.broker.preflight(proposal(False))["state"], "ready")

    def test_preflight_refuses_exhausted_budget_without_reserving_again(self):
        grant = self.issue([self.template], debit="4.1", orders=1)
        broker = Broker(self.store, lambda _: self.a, authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        broker.submit(self.template)
        with self.assertRaisesRegex(BrokerError, "budget exceeded"):
            broker.preflight(proposal(False))
        self.assertEqual(inspect_grant(self.store, grant["grantId"])["remainingOrders"], 0)

    def test_unknown_human_attempt_fences_another_grant_but_allows_explicit_human_recovery(self):
        self.a.lost, self.a.state = True, "unknown"
        human = Broker(self.store, lambda _: self.a, authority=HumanAuthority(lambda _: True), poll_seconds=0)
        human.submit(self.template)
        with self.assertRaisesRegex(BrokerError, "unresolved prior execution"):
            self.broker.submit(proposal(False))
        fresh_grant = self.issue([self.template])
        switched = Broker(self.store, lambda _: self.a, authority=PolicyAuthority(self.store, fresh_grant["grantId"]), poll_seconds=0)
        with self.assertRaisesRegex(BrokerError, "unresolved prior execution"):
            switched.submit(proposal(False))
        self.a.lost, self.a.state = False, "filled"
        reviews = []
        human.authority.confirm = lambda review: reviews.append(review) or True
        human.submit(proposal(False))  # separately approved; does not clear the unknown attempt
        self.assertIn("unresolved earlier execution", "\n".join(reviews[0]["confirmation"]))
        self.a.state = "unknown"
        with self.assertRaisesRegex(BrokerError, "unresolved prior execution"):
            switched.submit(proposal(False))

    def test_partial_and_fee_short_terminals_keep_account_fenced(self):
        for filled, inventory in [("4", "4"), ("10", "9.99")]:
            with self.subTest(filled=filled):
                # Each subcase has its own account to avoid borrowing prior exposure.
                value = request(False)
                value["legs"][0]["account"] = "0x" + ("5" if filled == "4" else "6") * 40
                p = prepare(value)
                grant = self.issue([p])
                a = FakeAdapter(filled=filled, inventory=inventory, state="canceled" if filled == "4" else "filled")
                broker = Broker(self.store, lambda _: a, authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
                broker.submit(p)
                with self.assertRaisesRegex(BrokerError, "unresolved prior execution"):
                    broker.submit(prepare(value))

    def test_proven_zero_terminal_can_clear_fence_without_refunding_budget(self):
        self.a.state, self.a.filled, self.a.inventory = "rejected", "0", "0"
        self.broker.submit(self.template)
        self.assertEqual(inspect_grant(self.store, self.grant["grantId"])["newRisk"], "active")
        self.assertEqual(inspect_grant(self.store, self.grant["grantId"])["remainingOrders"], 9)
        self.a.state, self.a.filled, self.a.inventory = "filled", "10", "10"
        self.assertEqual(self.broker.submit(proposal(False))["state"], "complete")

    def test_revoke_during_signing_is_visible_without_waiting_on_held_lock(self):
        def revoke_while_signing():
            revoke_grant(self.store, self.grant["grantId"])
            self.a.state = "unknown"
        self.a.on_submit = revoke_while_signing
        status = self.broker.submit(self.template)
        self.assertEqual((self.a.sent, status["legs"][0]["state"]), (0, "unknown"))
        self.assertEqual(inspect_grant(self.store, self.grant["grantId"])["newRisk"], "revoked")
        self.assertEqual(revoke_grant(self.store, self.grant["grantId"])["revoked"], True)

    def test_expiry_during_signing_and_proposal_expiry_block_actual_send(self):
        self.a.on_submit = lambda: setattr(self.authority, "clock", lambda: self.grant["expiresAt"] / 1000)
        self.a.state = "unknown"
        self.broker.submit(self.template)
        self.assertEqual(self.a.sent, 0)
        self.assertEqual(inspect_grant(self.store, self.grant["grantId"])["remainingOrders"], 9)

    def test_exact_own_cleanup_survives_expiry_revoke_but_other_grant_cannot_cancel(self):
        self.a.state, self.a.filled, self.a.inventory = "open", "0", "0"
        self.broker.submit(self.template)
        other = self.issue([self.template])
        foreign = Broker(self.store, lambda _: self.a, authority=PolicyAuthority(self.store, other["grantId"]), poll_seconds=0)
        with self.assertRaisesRegex(BrokerError, "own attempted orders"):
            foreign.cancel(self.template, 0)
        revoke_grant(self.store, self.grant["grantId"])
        self.authority.clock = lambda: self.grant["expiresAt"] / 1000
        self.broker.clock = lambda: self.template["payload"]["expiresAt"] / 1000 + 1
        self.assertEqual(self.broker.cancel(self.template, 0)["legs"][0]["state"], "canceled")
        self.assertEqual(self.a.cancels, 1)

    def test_cleanup_requires_explicit_operator_grant(self):
        grant = self.issue([self.template], cancel=False)
        self.a.state = "open"
        broker = Broker(self.store, lambda _: self.a, authority=PolicyAuthority(self.store, grant["grantId"]), poll_seconds=0)
        broker.submit(self.template)
        with self.assertRaisesRegex(BrokerError, "own attempted orders"):
            broker.cancel(self.template, 0)

    def test_missing_changed_and_cleanly_truncated_registry_fail_closed(self):
        self.broker.submit(self.template)
        path = self.store.root / "authority.jsonl"
        original = path.read_text()
        path.unlink()
        with self.assertRaises(BrokerError):
            PolicyAuthority(self.store, self.grant["grantId"])
        path.write_text(original)
        path.chmod(0o600)
        rows = original.splitlines()
        path.write_text("\n".join(rows[:-1]) + "\n")
        with self.assertRaisesRegex(BrokerError, "missing or truncated"):
            PolicyAuthority(self.store, self.grant["grantId"])
        path.write_text(original.replace('"maxDebitUSDC":"25"', '"maxDebitUSDC":"26"', 1))
        with self.assertRaisesRegex(BrokerError, "changed or corrupt"):
            PolicyAuthority(self.store, self.grant["grantId"])

    def test_actual_crash_after_reservation_never_resumes_or_recharges(self):
        code = '''
import json, os, sys
from pathlib import Path
sys.path.insert(0, 'tests')
from test_broker import FakeAdapter
from verdict_broker.authority import PolicyAuthority
from verdict_broker.core import Store, Broker
class CrashStore(Store):
    def append(self, digest, event):
        super().append(digest, event)
        if event.get('type') == 'reserved': os._exit(7)
store = CrashStore(Path(sys.argv[1]))
Broker(store, lambda _: FakeAdapter(), authority=PolicyAuthority(store, sys.argv[2]), poll_seconds=0).submit(json.loads(sys.argv[3]))
'''
        result = subprocess.run([sys.executable, "-c", code, str(self.store.root), self.grant["grantId"], json.dumps(self.template)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertFalse(any(e["type"] == "attempt_started" for e in self.store.read(self.template["digest"])))
        with self.assertRaisesRegex(BrokerError, "reservation without an attempt"):
            self.broker.submit(self.template)
        self.assertEqual((self.a.sent, inspect_grant(self.store, self.grant["grantId"])["remainingOrders"]), (0, 9))

    def test_real_processes_on_different_accounts_cannot_overspend_shared_grant(self):
        other_request = request(False)
        other_request["legs"][0]["account"] = "0x" + "7" * 40
        other = prepare(other_request)
        grant = self.issue([self.template, other], debit="4.1", orders=1)
        code = '''
import json, sys
from pathlib import Path
sys.path.insert(0, 'tests')
from test_broker import FakeAdapter
from verdict_broker.authority import PolicyAuthority
from verdict_broker.core import Store, Broker, BrokerError
store = Store(Path(sys.argv[1])); a = FakeAdapter()
try:
    Broker(store, lambda _: a, authority=PolicyAuthority(store, sys.argv[2]), poll_seconds=0).submit(json.loads(sys.argv[3]))
except BrokerError: pass
print(json.dumps({'sent': a.sent}))
'''
        processes = [subprocess.Popen([sys.executable, "-c", code, str(self.store.root), grant["grantId"], json.dumps(p)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for p in [self.template, other]]
        outputs = [p.communicate(timeout=30) for p in processes]
        self.assertEqual([p.returncode for p in processes], [0, 0], outputs)
        self.assertEqual(sum(json.loads(out)["sent"] for out, _ in outputs), 1)
        summary = inspect_grant(self.store, grant["grantId"])
        self.assertEqual((summary["remainingDebitUSDC"], summary["remainingOrders"]), ("0.000000000000", 0))

    def test_reserved_debit_uses_exact_canonical_ceiling_without_decimal_rounding(self):
        from verdict_broker.authority import _debit
        value = request(True)
        value["legs"] = [value["legs"][1]]
        value["settlementReview"] = None
        value["legs"][0].update(shares="123456789.123456789123", limitPrice="0.123456789123", feeReserveUSDC="0.1")
        value["policy"].update(maxLegDebitUSDC="999999999", maxTotalDebitUSDC="999999999")
        p = prepare(value)
        self.assertEqual(_debit(p), 15241578880617284828)


if __name__ == "__main__":
    unittest.main()
