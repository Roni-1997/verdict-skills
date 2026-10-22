"""Quote economics, invalid/stale evidence and real saved-snapshot CLI replay."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from verdict_broker.core import BrokerError
from verdict_broker.quotes import quote_polymarket

NOW = 1792638000000


def snapshot():
    def book(asset, asks, bids):
        return {"assetId": asset, "sourceAt": "2026-10-22T03:00:00+00:00", "tickSize": "0.01", "minimumShares": "1",
                "asks": [{"price": p, "shares": s} for p, s in asks], "bids": [{"price": p, "shares": s} for p, s in bids]}
    return {"venue": "polymarket", "network": "polygon", "fetchedAt": NOW,
            "market": {"marketId": "123", "assets": {"yes": "100", "no": "200"}, "version": "v1", "active": True,
                       "closed": False, "acceptingOrders": True, "enableOrderBook": True, "expiresAt": "2026-10-23T03:00:00+00:00", "clobFeeSchedule": {"r": "0.07", "e": 1}},
            "book": {"yes": book("100", [("0.5", "5"), ("0.4", "5")], [("0.35", "4"), ("0.39", "6")]),
                     "no": book("200", [("0.6", "20")], [("0.59", "20")])}}


def quote(s=None, **kw):
    return quote_polymarket(snapshot() if s is None else s, kw.pop("side", "yes"), kw.pop("action", "buy"), kw.pop("shares", "10"), at=kw.pop("at", NOW), **kw)


class QuoteTest(unittest.TestCase):
    def test_walks_actual_depth_and_per_price_curve_instead_of_midpoint(self):
        q = quote()
        self.assertEqual(q["status"], "complete")
        self.assertEqual(q["notionalUSDC"], "4.5")
        self.assertEqual(q["curveFeeUSDC"], "0.1715")
        self.assertEqual(q["buyNotionalPlusCurveFeeUSDC"], "4.6715")
        self.assertEqual(q["averagePrice"], "0.45")
        self.assertEqual(q["worstPrice"], "0.5")
        self.assertEqual((q["bestBid"], q["bestAsk"], q["midpoint"], q["spread"]), ("0.39", "0.4", "0.395", "0.01"))
        self.assertIsNone(q["netSharesReceived"])
        self.assertFalse(q["inventoryVerified"])

    def test_sell_walks_highest_bids_first_and_subtracts_modeled_fee(self):
        q = quote(action="sell")
        self.assertEqual(q["notionalUSDC"], "3.74")
        self.assertEqual(q["curveFeeUSDC"], "0.163618")
        self.assertEqual(q["sellNotionalMinusCurveFeeUSDC"], "3.576382")
        self.assertIsNone(q["buyNotionalPlusCurveFeeUSDC"])

    def test_selected_no_asset_uses_its_own_book(self):
        q = quote(side="no")
        self.assertEqual((q["assetId"], q["notionalUSDC"]), ("200", "6"))

    def test_partial_limit_quote_never_extrapolates_requested_notional(self):
        q = quote(limit_price="0.4")
        self.assertEqual((q["status"], q["filledShares"], q["unfilledShares"], q["notionalUSDC"]), ("partial", "5", "5", "2"))
        self.assertEqual(q["curveFeeUSDC"], "0.084")

    def test_sell_limit_omits_bids_below_the_limit(self):
        q = quote(action="sell", limit_price="0.38")
        self.assertEqual((q["status"], q["filledShares"], q["notionalUSDC"]), ("partial", "6", "2.34"))

    def test_duplicate_price_levels_aggregate_without_changing_economics(self):
        s = snapshot()
        s["book"]["yes"]["asks"] = [{"price": "0.4", "shares": "2"}, {"price": "0.4", "shares": "3"}, {"price": "0.5", "shares": "5"}]
        self.assertEqual(quote(s), quote())

    def test_empty_depth_is_partial_without_fake_average_or_mid(self):
        s = snapshot()
        s["book"]["yes"]["asks"] = []
        q = quote(s)
        self.assertEqual((q["status"], q["filledShares"], q["notionalUSDC"]), ("partial", "0", "0"))
        for key in ["averagePrice", "worstPrice", "midpoint", "spread"]:
            self.assertIsNone(q[key])

    def test_explicit_fee_free_schedule_is_supported_but_absent_schedule_is_not_zero(self):
        s = snapshot()
        s["market"]["clobFeeSchedule"] = None
        self.assertEqual(quote(s)["curveFeeUSDC"], "0")
        del s["market"]["clobFeeSchedule"]
        with self.assertRaises(BrokerError): quote(s)

    def test_dynamic_market_rate_and_exponent_are_not_hardcoded_by_category(self):
        s = snapshot()
        s["market"]["clobFeeSchedule"] = {"r": "0.04", "e": 2}
        self.assertEqual(quote(s)["curveFeeUSDC"], "0.02402")

    def test_sdk_decimal_string_and_numeric_fee_parameters_are_equivalent(self):
        for rate, exponent in [("0.07", "1"), ("7e-2", "1.0"), (0.07, 1.0)]:
            s = snapshot(); s["market"]["clobFeeSchedule"] = {"r": rate, "e": exponent}
            self.assertEqual(quote(s)["curveFeeUSDC"], "0.1715")

    def test_disabled_or_unknown_orderbook_state_cannot_quote_as_complete(self):
        for value in [False, None]:
            s = snapshot(); s["market"]["enableOrderBook"] = value
            self.assertEqual(quote(s)["status"], "blocked")
        s = snapshot(); del s["market"]["enableOrderBook"]
        self.assertEqual(quote(s)["status"], "blocked")

    def test_unverified_or_invalid_fee_models_fail_closed(self):
        for fee in [{"r": "0.05", "e": 0.5}, {"r": "0.05", "e": True}, {"r": "NaN", "e": 1}, {"r": "1.1", "e": 1}, {"r": "-0.1", "e": 1}, {"r": "1e-9999999", "e": 1}, {"r": "0.05", "e": 9}, {}]:
            s = snapshot(); s["market"]["clobFeeSchedule"] = fee
            with self.subTest(fee=fee), self.assertRaises(BrokerError): quote(s)

    def test_stale_source_blocks_even_with_a_recent_local_capture(self):
        q = quote(at=NOW + 5001)
        self.assertEqual(q["status"], "blocked")
        self.assertIn("snapshot_clock_outside_age_budget", q["reasons"])
        self.assertNotIn("notionalUSDC", q)

    def test_future_or_missing_source_and_capture_fail_closed(self):
        s = snapshot(); s["book"]["yes"]["sourceAt"] = "2026-10-22T03:00:01+00:00"
        self.assertEqual(quote(s)["status"], "blocked")
        for value in [None, "invalid", "2026-10-22T03:00:00"]:
            s["book"]["yes"]["sourceAt"] = value
            with self.assertRaises(BrokerError): quote(s)
        with self.assertRaises(BrokerError): quote(at=NOW - 1)

    def test_closed_expired_or_below_minimum_quotes_return_blocked_without_prices(self):
        cases = [({"closed": True}, "market_not_accepting_orders"), ({"expiresAt": "2026-10-22T03:00:00+00:00"}, "market_ended")]
        for change, reason in cases:
            s = snapshot(); s["market"].update(change)
            q = quote(s)
            self.assertIn(reason, q["reasons"]); self.assertNotIn("notionalUSDC", q)
        self.assertIn("below_market_minimum_shares", quote(shares="0.99")["reasons"])

    def test_bad_quantity_precision_limits_and_identity_are_rejected(self):
        for shares in ["0", "-1", "1e2", "10.001", "1000000001", "NaN", None]:
            with self.subTest(shares=shares), self.assertRaises(BrokerError): quote(shares=shares)
        for price in ["0", "1", "0.405", "Infinity"]:
            with self.assertRaises(BrokerError): quote(limit_price=price)
        s = snapshot(); s["book"]["yes"]["assetId"] = "wrong"
        with self.assertRaises(BrokerError): quote(s)
        s = snapshot(); s["network"] = "mainnet"
        with self.assertRaises(BrokerError): quote(s)

    def test_crossed_or_bad_grid_books_fail_closed(self):
        for row in [{"price": "0.41", "shares": "1"}, {"price": "0.395", "shares": "1"}, {"price": "0.39", "shares": "-1"}, {"price": "0.39", "shares": "1", "privateKey": "hidden"}]:
            s = snapshot(); s["book"]["yes"]["bids"] = [row]
            with self.assertRaises(BrokerError): quote(s)

    def test_does_not_modify_the_replay_snapshot(self):
        s = snapshot(); original = deepcopy(s)
        quote(s)
        self.assertEqual(s, original)

    def test_real_cli_replays_saved_snapshot_without_sdks_credentials_or_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "public.json"
            path.write_text(json.dumps(snapshot()))
            cmd = [sys.executable, "-m", "verdict_broker", "public-quote", "--snapshot", str(path), "--side", "yes", "--action", "buy", "--shares", "10", "--at", str(NOW)]
            result = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["curveFeeUSDC"], "0.1715")
            self.assertEqual(json.loads(result.stdout)["sourceMode"], "saved_snapshot")
            self.assertEqual(json.loads(result.stdout)["evaluationMode"], "replay")
            stale = subprocess.run([*cmd[:-1], str(NOW + 6000)], capture_output=True, text=True)
            self.assertEqual(json.loads(stale.stdout)["status"], "blocked")
            mixed = subprocess.run([*cmd, "--venue", "polymarket"], capture_output=True, text=True)
            self.assertEqual(mixed.returncode, 1)


if __name__ == "__main__": unittest.main()
