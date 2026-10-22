"""Behavior tests through the real built Node proposal boundary, without SDKs or funds."""
from dataclasses import replace
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from verdict_broker.core import Broker, BrokerError, Observation, Preflight, Receipt, Store, identity, json_load, node_call


ADDRESS = "0x" + "1" * 40
RULE = "The same oracle resolves YES when the closing value exceeds 100."


def request(pair=True):
    a = {"venue": "hl", "network": "testnet", "account": ADDRESS, "outcome": 123,
         "builder": {"address": "0x" + "2" * 40, "feeTenthsBp": 0}, "allInFeeBpsCap": "10", "tif": "Ioc"}
    b = {"venue": "lighter", "network": "devnet", "account": 42, "apiKeyIndex": 2, "market": 456, "creator": 7, "tif": "ioc"}
    common = {"title": "Oracle event", "settlementRule": RULE, "side": "yes", "action": "buy", "shares": "10", "limitPrice": "0.4", "feeReserveUSDC": "0.1"}
    return {"legs": [{**common, **a}, *([{**common, **b, "side": "no"}] if pair else [])],
            "policy": {"maxTotalDebitUSDC": "10", "maxLegDebitUSDC": "5"},
            "settlementReview": {"relationship": "same_event_same_orientation", "notes": "Operator checked both oracle rules manually."} if pair else None}


def proposal(pair=True):
    return node_call(["execution", "prepare", "--input", json.dumps(request(pair))])


class FakeAdapter:
    def __init__(self, *, filled="10", inventory="10", state="filled", settled=True, lost=False):
        self.filled, self.inventory, self.state, self.settled = filled, inventory, state, settled
        self.lost, self.sent, self.cancels, self.closed = lost, 0, 0, False
        self.check = Preflight("0", "100", "0.01", {}, time.time())
        self.fail_preflight = False
        self.on_submit = lambda: None

    def preflight(self, leg, client_id):
        if self.fail_preflight:
            raise RuntimeError("credential-in-unsafe-sdk-exception")
        return self.check

    def submit(self, leg, client_id, check):
        self.sent += 1
        self.on_submit()
        if self.lost:
            raise ConnectionError("signed-payload-secret")
        return Receipt(order_id="public-order-id")

    def observe(self, leg, client_id, receipt):
        return Observation(self.state, self.filled, self.inventory, self.settled)

    def cancel(self, leg, client_id, receipt):
        self.cancels += 1
        self.state = "canceled"

    def close(self):
        self.closed = True


class BrokerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "state"
        self.store = Store(self.root)
        self.p = proposal()
        self.a, self.b = FakeAdapter(), FakeAdapter()
        self.broker = Broker(self.store, lambda l: self.a if l["venue"] == "hl" else self.b, poll_seconds=0)

    def tearDown(self):
        self.tmp.cleanup()

    def test_complete_pair_and_durable_attempt_before_transport(self):
        def check_fence():
            self.assertTrue(any(e["type"] == "attempt_started" and e["leg"] == 0 for e in self.store.read(self.p["digest"])))
        self.a.on_submit = check_fence
        self.assertEqual(self.broker.submit(self.p, lambda _: True)["state"], "complete")
        self.assertEqual((self.a.sent, self.b.sent), (1, 1))
        self.assertTrue(self.a.closed and self.b.closed)
        raw = (self.root / (self.p["digest"] + ".jsonl")).read_text()
        self.assertNotIn("native", raw)
        self.assertNotIn("signed-payload", raw)

    def test_no_approval_no_submission(self):
        with self.assertRaises(BrokerError):
            self.broker.submit(self.p, lambda _: False)
        self.assertEqual((self.a.sent, self.b.sent), (0, 0))

    def test_partial_first_halts(self):
        self.a.filled = self.a.inventory = "4"
        self.a.state = "canceled"
        status = self.broker.submit(self.p, lambda _: True)
        self.assertEqual(status["legs"][0]["netInventoryChange"], "4")
        self.assertEqual(self.b.sent, 0)

    def test_gross_full_but_net_fee_shortfall_halts(self):
        self.a.inventory = "9.99"
        self.assertEqual(self.broker.submit(self.p, lambda _: True)["state"], "needs_reconciliation")
        self.assertEqual(self.b.sent, 0)

    def test_unsettled_match_halts(self):
        self.a.settled = False
        self.broker.submit(self.p, lambda _: True)
        self.assertEqual(self.b.sent, 0)

    def test_unknown_first_is_not_rejected(self):
        self.a.state = "unknown"
        self.broker.submit(self.p, lambda _: True)
        self.assertEqual(self.b.sent, 0)

    def test_lost_response_never_resubmits_after_restart(self):
        self.a.lost = True
        self.a.state = "unknown"
        self.broker.submit(self.p, lambda _: True)
        restarted = Broker(Store(self.root), lambda l: self.a if l["venue"] == "hl" else self.b, poll_seconds=0)
        restarted.submit(self.p, lambda _: self.fail("must reconcile, not approve/send again"))
        self.assertEqual((self.a.sent, self.b.sent), (1, 0))

    def test_actual_process_crash_after_fsync_leaves_fence_and_releases_account_lock(self):
        code = """
import json, os, sys
from pathlib import Path
sys.path.insert(0, 'tests')
from test_broker import FakeAdapter
from verdict_broker.core import Broker, Store
a = FakeAdapter()
a.on_submit = lambda: os._exit(7)
Broker(Store(Path(sys.argv[1])), lambda _: a, poll_seconds=0).submit(json.loads(sys.argv[2]), lambda _: True)
"""
        crashed = subprocess.run([sys.executable, "-c", code, str(self.root), json.dumps(self.p)], capture_output=True, text=True)
        self.assertEqual(crashed.returncode, 7, crashed.stderr)
        events = self.store.read(self.p["digest"])
        self.assertTrue(any(e["type"] == "attempt_started" for e in events))
        self.assertFalse(any(e["type"] == "receipt" for e in events))
        self.a.state = "unknown"
        status = self.broker.submit(self.p, lambda _: self.fail("never ask to resubmit after crash"))
        self.assertEqual(status["legs"][0]["state"], "unknown")
        self.assertEqual((self.a.sent, self.b.sent), (0, 0))

    def test_restart_after_first_fill_does_not_automatically_send_unattempted_second(self):
        self.a.on_submit = lambda: setattr(self.b, "fail_preflight", True)
        result = self.broker.submit(self.p, lambda _: True)
        self.assertIn("blocked", result)
        self.b.fail_preflight = False
        self.broker.submit(self.p, lambda _: True)
        self.assertEqual(self.b.sent, 0)

    def test_known_second_leg_failure_blocks_both_orders(self):
        self.b.fail_preflight = True
        with self.assertRaises(BrokerError):
            self.broker.submit(self.p, lambda _: True)
        self.assertEqual((self.a.sent, self.b.sent), (0, 0))

    def test_second_leg_net_shortfall_never_claims_hedge(self):
        self.b.inventory = "9.9"
        self.assertEqual(self.broker.submit(self.p, lambda _: True)["state"], "needs_reconciliation")

    def test_stale_preflight_blocks(self):
        self.a.check = replace(self.a.check, checked_at=time.time() - 10)
        with self.assertRaises(BrokerError):
            self.broker.submit(self.p, lambda _: True)
        self.assertEqual(self.a.sent, 0)

    def test_fee_increase_blocks(self):
        self.a.check = replace(self.a.check, required_fee="0.2")
        with self.assertRaises(BrokerError):
            self.broker.submit(self.p, lambda _: True)
        self.assertEqual(self.a.sent, 0)

    def test_balance_shortfall_blocks(self):
        self.a.check = replace(self.a.check, available_usdc="4.09")
        with self.assertRaises(BrokerError):
            self.broker.submit(self.p, lambda _: True)
        self.assertEqual(self.a.sent, 0)

    def test_proposal_tampering_rejected_before_factory(self):
        self.p["payload"]["legs"][0]["shares"] = "11"
        with self.assertRaises(BrokerError):
            self.broker.submit(self.p, lambda _: True)
        self.assertEqual(self.a.sent, 0)

    def test_expired_proposal_can_be_reconciled_but_not_submitted(self):
        with patch.object(self.broker, "clock", return_value=time.time() + 4000):
            with self.assertRaises(BrokerError):
                self.broker.submit(self.p, lambda _: True)
            self.assertEqual(self.broker.status(self.p)["legs"][0]["state"], "not_attempted")

    def test_account_lock_applies_across_different_proposals(self):
        with self.store.locked(self.p["payload"]["legs"]):
            with self.assertRaises(BrokerError):
                self.broker.submit(proposal(), lambda _: True)
        self.assertEqual(self.a.sent, 0)

    def test_truncated_journal_fails_closed(self):
        self.store.append(self.p["digest"], {"type": "attempt_started", "leg": 0})
        path = self.root / (self.p["digest"] + ".jsonl")
        with path.open("a") as f:
            f.write('{"broken":')
        with self.assertRaises(BrokerError):
            self.broker.submit(self.p, lambda _: True)

    def test_cancel_requires_separate_approval_and_exact_leg(self):
        self.a.state = "open"
        self.broker.submit(self.p, lambda _: True)
        with self.assertRaises(BrokerError):
            self.broker.cancel(self.p, 0, lambda _: False)
        self.broker.cancel(self.p, 0, lambda _: True)
        self.assertEqual((self.a.cancels, self.b.cancels), (1, 0))
        with self.assertRaises(BrokerError):
            self.broker.cancel(self.p, 1, lambda _: True)

    def test_observation_exception_hides_credentials(self):
        def unsafe(*_):
            raise RuntimeError("sdk-auth-secret")
        self.a.observe = unsafe
        result = self.broker.submit(self.p, lambda _: True)
        self.assertNotIn("sdk-auth-secret", json.dumps(result))
        self.assertEqual(result["legs"][0]["state"], "unknown")


class BoundaryTest(unittest.TestCase):
    def test_duplicate_and_nonfinite_json_rejected(self):
        for raw in ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}']:
            with self.assertRaises(BrokerError):
                json_load(raw)

    def test_secret_env_not_in_node_child(self):
        original = subprocess.run
        def capture(*args, **kwargs):
            self.assertNotIn("VERDICT_HL_AGENT_PRIVATE_KEY", kwargs["env"])
            self.assertNotIn("VERDICT_API_URL", kwargs["env"])
            return original(*args, **kwargs)
        with patch.dict(os.environ, {"VERDICT_HL_AGENT_PRIVATE_KEY": "do-not-inherit", "VERDICT_API_URL": "https://untrusted.invalid"}), patch("subprocess.run", side_effect=capture):
            self.assertFalse(node_call(["execution", "capabilities"])["hostedSigning"])

    def test_state_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "state"
            root.symlink_to(tmp)
            with self.assertRaises(BrokerError):
                Store(root)

    def test_journal_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "state")
            target = Path(tmp) / "sensitive"
            target.write_text("unchanged")
            (store.root / ("a" * 64 + ".jsonl")).symlink_to(target)
            with self.assertRaises(OSError):
                store.append("a" * 64, {"type": "attempt_started"})
            self.assertEqual(target.read_text(), "unchanged")

    def test_real_cli_review_and_noninteractive_submit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "proposal.json"
            path.write_text(json.dumps(proposal(False)))
            reviewed = subprocess.run([sys.executable, "-m", "verdict_broker", "review", "--proposal", str(path)], capture_output=True, text=True)
            self.assertEqual(reviewed.returncode, 0, reviewed.stderr)
            self.assertIn("UNSIGNED", reviewed.stdout)
            from verdict_broker.__main__ import confirmation
            with patch("sys.stdin.isatty", return_value=False), patch("sys.stderr"):
                with self.assertRaises(BrokerError):
                    confirmation(json.loads(reviewed.stdout))


if __name__ == "__main__":
    unittest.main()
