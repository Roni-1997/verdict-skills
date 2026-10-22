"""Exact proposal-leg public research through the actual CLI/validation boundary."""
from copy import deepcopy
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from verdict_broker.core import BrokerError, node_call
from test_broker import request, RULE
from test_quotes import NOW, snapshot


def prepared():
    r = request()
    r["legs"][0].update(network="mainnet", limitPrice="0.25")
    r["legs"][1] = {"venue": "polymarket", "network": "polygon", "account": "0x" + "3" * 40,
                    "marketId": "123", "assetId": "200", "title": "Oracle event", "settlementRule": RULE,
                    "side": "no", "action": "buy", "shares": "10", "limitPrice": "0.65", "feeReserveUSDC": "0.2", "tif": "FAK"}
    r["policy"]["maxLegDebitUSDC"] = "8"
    p = node_call(["execution", "prepare", "--input", json.dumps(r)])
    p["payload"].update(createdAt=NOW, expiresAt=NOW + 300000)
    p["digest"] = hashlib.sha256(json.dumps(p["payload"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return p


def capture():
    s = snapshot(); s["market"].update(title="Oracle event", settlementRule=RULE)
    return s


class ProposalQuoteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.proposal = prepared()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / "proposal.json"
        self.path.write_text(json.dumps(self.proposal))
        self.s = capture()

    def tearDown(self): self.tmp.cleanup()

    def run_quote(self, **kwargs):
        from verdict_broker.quotes import quote_proposal
        return quote_proposal(self.path, kwargs.pop("index", 1), snapshot=kwargs.pop("snapshot", self.s), at=kwargs.pop("at", NOW), **kwargs)

    def test_exact_no_leg_binds_size_limit_and_asset_without_exposing_accounts(self):
        q = self.run_quote()
        self.assertEqual((q["status"], q["side"], q["action"], q["assetId"], q["requestedShares"], q["limitPrice"]), ("complete", "no", "buy", "200", "10", "0.65"))
        self.assertEqual((q["proposalDigest"], q["proposalLegIndex"]), (self.proposal["digest"], 1))
        self.assertEqual((q["otherLegs"], q["authorization"], q["sourceMode"]), ("not_assessed", "none", "saved_snapshot"))
        self.assertIsNone(q["netSharesReceived"])
        self.assertNotIn(self.proposal["payload"]["legs"][1]["account"], json.dumps(q))
        self.assertEqual(json.loads(self.path.read_text()), self.proposal)

    def test_partial_depth_respects_original_limit_without_resizing(self):
        self.s["book"]["no"]["asks"] = [{"price": "0.6", "shares": "4"}, {"price": "0.7", "shares": "50"}]
        q = self.run_quote()
        self.assertEqual((q["status"], q["filledShares"], q["unfilledShares"], q["notionalUSDC"]), ("partial", "4", "6", "2.4"))
        self.assertEqual(q["proposalDigest"], self.proposal["digest"])

    def test_identity_or_terms_mismatch_never_publishes_a_quote(self):
        for key, value in [("marketId", "456"), ("assets", {"yes": "100", "no": "300"}), ("title", "Other event"), ("settlementRule", "Other rule")]:
            s = capture(); s["market"][key] = value
            with self.subTest(key=key), self.assertRaises(BrokerError): self.run_quote(snapshot=s)
        for key, value in [("venue", "hl"), ("network", "mainnet")]:
            s = capture(); s[key] = value
            with self.assertRaises(BrokerError): self.run_quote(snapshot=s)

    def test_wrong_leg_or_changed_digest_fails_canonical_validation(self):
        for index in [0, -1, 2, True]:
            with self.subTest(index=index), self.assertRaises(BrokerError): self.run_quote(index=index)
        p = deepcopy(self.proposal); p["payload"]["legs"][1]["shares"] = "9"
        self.path.write_text(json.dumps(p))
        with self.assertRaises(BrokerError): self.run_quote()

    def test_proposal_window_checked_before_reads_and_after_quote_evaluation(self):
        for at in [NOW - 1, NOW + 300000]:
            with self.assertRaises(BrokerError): self.run_quote(at=at)
        with patch("verdict_broker.quotes.time.time", side_effect=[NOW / 1000, (NOW + 300000) / 1000]):
            with self.assertRaises(BrokerError): self.run_quote(at=None)

    def test_expiry_is_exclusive_and_stale_or_disabled_depth_stays_blocked(self):
        last = NOW + 299999
        self.s["fetchedAt"] = last
        self.s["book"]["no"]["sourceAt"] = datetime.fromtimestamp(last / 1000, timezone.utc).isoformat()
        self.assertEqual(self.run_quote(at=last)["status"], "complete")
        with self.assertRaises(BrokerError): self.run_quote(at=last + 1)
        self.s = capture()
        q = self.run_quote(at=NOW + 5001)
        self.assertEqual(q["status"], "blocked")
        self.assertNotIn("notionalUSDC", q)
        self.s["market"]["enableOrderBook"] = False
        self.assertEqual(self.run_quote()["status"], "blocked")

    def test_live_mode_captures_only_exact_public_market_and_retains_current_clock(self):
        with patch("verdict_broker.public.public_market", return_value=self.s) as public, patch("verdict_broker.quotes.time.time", return_value=NOW / 1000):
            q = self.run_quote(snapshot=None, at=None)
        public.assert_called_once_with("polymarket", "polygon", "123")
        self.assertEqual((q["sourceMode"], q["evaluationMode"]), ("live_capture", "current_time"))
        with patch("verdict_broker.public.public_market") as public:
            with self.assertRaises(BrokerError): self.run_quote(snapshot=None)
            public.assert_not_called()

    def test_cli_saved_replay_rejects_conflicting_overrides_and_missing_leg(self):
        source = self.root / "public.json"; source.write_text(json.dumps(self.s))
        cmd = [sys.executable, "-m", "verdict_broker", "public-quote", "--proposal", str(self.path), "--leg", "1", "--snapshot", str(source), "--at", str(NOW), "--state-dir", str(self.root / "state")]
        result = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["proposalDigest"], self.proposal["digest"])
        for flag, value in [("--shares", "20"), ("--side", "yes"), ("--action", "sell"), ("--limit-price", "0.7"), ("--market-id", "456"), ("--venue", "polymarket"), ("--network", "polygon")]:
            with self.subTest(flag=flag):
                failure = subprocess.run([*cmd, flag, value], capture_output=True, text=True)
                self.assertEqual(failure.returncode, 1)
                self.assertEqual(failure.stdout, "")
        missing = subprocess.run([arg for i, arg in enumerate(cmd) if i not in {6, 7}], capture_output=True, text=True)
        self.assertEqual(missing.returncode, 1)
        self.assertFalse((self.root / "state").exists())

    def test_saved_cli_cannot_enter_network_private_adapter_or_state_paths(self):
        from verdict_broker.__main__ import main
        source = self.root / "public.json"; source.write_text(json.dumps(self.s))
        output = io.StringIO()
        with patch("verdict_broker.public.public_market", side_effect=AssertionError("network forbidden")), patch("verdict_broker.adapters.create_adapter", side_effect=AssertionError("private adapter forbidden")), patch("verdict_broker.__main__.Store", side_effect=AssertionError("state forbidden")), redirect_stdout(output):
            result = main(["public-quote", "--proposal", str(self.path), "--leg", "1", "--snapshot", str(source), "--at", str(NOW)])
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(output.getvalue())["authorization"], "none")

    def test_malformed_saved_root_never_switches_into_live_mode(self):
        from verdict_broker.__main__ import main
        source = self.root / "public.json"
        for value in [None, [], True, 123, "not a snapshot"]:
            source.write_text(json.dumps(value))
            for selectors in [["--proposal", str(self.path), "--leg", "1"], ["--side", "yes", "--action", "buy", "--shares", "10"]]:
                with self.subTest(value=value, selectors=selectors), patch("verdict_broker.public.public_market") as public, redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
                    code = main(["public-quote", "--snapshot", str(source), *selectors])
                    self.assertEqual(code, 1)
                    self.assertEqual(out.getvalue(), "")
                    public.assert_not_called()


if __name__ == "__main__": unittest.main()
