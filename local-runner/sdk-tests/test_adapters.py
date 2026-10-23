"""Official installed SDK signing with ephemeral test keys; no real transport or funds."""
import asyncio
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal as D
import json
import time
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch, Mock, AsyncMock

from eth_account import Account
import lighter
from polymarket import SecureClient
from polymarket.clients._transport import SyncTransport
from polymarket.clients.secure import get_environment_config, derive_beacon_deposit_wallet_address
from polymarket.environments import PRODUCTION
from polymarket.models.clob.api_key import ApiKeyCreds
from hyperliquid.utils.signing import recover_agent_or_user_from_l1_action

from verdict_broker.adapters import Hyperliquid, Lighter, Polymarket, check_depth, fee_round
from verdict_broker.core import BrokerError, Preflight, Receipt


ACCOUNT = "0x" + "1" * 40
BASE = {"title": "Oracle event", "settlementRule": "Verified oracle rule", "shares": "10", "side": "yes", "action": "buy", "limitPrice": "0.4", "feeReserveUSDC": "0.1", "account": ACCOUNT}
V1_ASSET = str(1 << 50)  # Nonzero reserved bits: actual SDK V1 namespace.
V2_ASSET = str(1 << 248)  # Supported V2 module 1, YES outcome 0.
POLY = {**BASE, "venue": "polymarket", "network": "polygon", "marketId": "123", "assetId": V1_ASSET, "tif": "FAK"}
HL = {**BASE, "venue": "hl", "network": "testnet", "outcome": 123, "tif": "Ioc", "allInFeeBpsCap": "10", "builder": {"address": "0x" + "2" * 40, "feeTenthsBp": 10}}
LIGHTER = {**BASE, "venue": "lighter", "network": "devnet", "market": 4555, "creator": 7, "account": 42, "apiKeyIndex": 2, "tif": "ioc"}


class HLSDKTest(unittest.TestCase):
    def preflight_fixture(self, names=("Yes", "No"), leg=HL):
        wallet = Account.create()
        sides = [{"index": i, "name": name, "coin": f"#123{i}", "assetId": 100001230 + i} for i, name in enumerate(names)]
        selected = 0 if leg["side"] == "yes" else 1
        action = {"type": "order", "orders": [{"a": 100001230 + selected}]}
        built = {"market": {"outcome": 123, "displayName": BASE["title"], "settlementRule": BASE["settlementRule"]}, "side": dict(sides[selected]), "action": action}
        market = {"outcome": 123, "sides": sides, "quoteToken": "USDC", "expiresAt": datetime.fromtimestamp(time.time() + 86400, timezone.utc).isoformat()}
        adapter = Hyperliquid(HL, wallet=wallet, http=Mock(), bridge=lambda args, env: built if args[0] == "build-order" else market)
        def info(kind, **kw):
            if kind == "extraAgents": return [{"address": wallet.address, "validUntil": int((time.time() + 86400) * 1000)}]
            if kind == "maxBuilderFee": return 10
            if kind == "l2Book": return {"time": int(time.time() * 1000), "levels": [[], [{"px": "0.4", "sz": "10"}]]}
            raise AssertionError(kind)
        adapter.info = info
        adapter.inventory = lambda _: (D(0), D(0), D(100))
        return adapter, built, market

    def test_preflight_rejects_named_or_reversed_outcomes_in_yes_no_proposal(self):
        for names in [("Over", "Under"), ("Arsenal", "Chelsea"), ("No", "Yes")]:
            adapter, _, _ = self.preflight_fixture(names)
            with self.subTest(names=names), self.assertRaises(BrokerError): adapter.preflight(HL, "a" * 64)

    def test_preflight_binds_selected_side_and_native_asset_to_approved_outcome(self):
        for side in ["yes", "no"]:
            leg = {**HL, "side": side}
            adapter, built, _ = self.preflight_fixture(leg=leg)
            self.assertIs(adapter.preflight(leg, "a" * 64).native, built["action"])
        for key, value in [("index", 1), ("name", "Over"), ("coin", "#9990"), ("assetId", 100009990)]:
            adapter, built, _ = self.preflight_fixture(); built["side"][key] = value
            with self.subTest(key=key), self.assertRaises(BrokerError): adapter.preflight(HL, "a" * 64)
        adapter, built, _ = self.preflight_fixture(); built["action"]["orders"][0]["a"] = 100009990
        with self.assertRaises(BrokerError): adapter.preflight(HL, "a" * 64)

    def test_official_signature_recovers_ephemeral_agent_and_exact_action(self):
        wallet = Account.create()
        captured = []
        class Transport:
            def request(self, method, url, **kw):
                body = kw["json"]
                captured.append(body)
                self_test.assertEqual(recover_agent_or_user_from_l1_action(body["action"], body["signature"], None, body["nonce"], body["expiresAfter"], False).lower(), wallet.address.lower())
                return {"status": "ok", "response": {"data": {"statuses": [{"resting": {"oid": 456}}]}}}
            def close(self): pass
        self_test = self
        adapter = Hyperliquid(HL, wallet=wallet, http=Transport())
        action = {"type": "order", "orders": [{"a": 100001230, "b": True, "p": "0.4", "s": "10", "r": False, "t": {"limit": {"tif": "Ioc"}}, "c": "0x" + "a" * 32}], "grouping": "na", "builder": {"b": HL["builder"]["address"], "f": 10}}
        receipt = adapter.submit(HL, "a" * 64, Preflight("0", "100", "0.1", action, time.time()))
        self.assertEqual(receipt.order_id, "456")
        self.assertIs(captured[0]["action"], action)
        self.assertEqual(list(action), ["type", "orders", "grouping", "builder"])
        adapter.cancel(HL, "a" * 64, receipt)
        self.assertEqual(captured[1]["action"], {"type": "cancelByCloid", "cancels": [{"asset": 100001230, "cloid": "0x" + "a" * 32}]})

    def test_per_order_error_is_rejection_even_when_envelope_ok(self):
        http = Mock()
        http.request.return_value = {"status": "ok", "response": {"data": {"statuses": [{"error": "not enough balance"}]}}}
        adapter = Hyperliquid(HL, wallet=Account.create(), http=http)
        self.assertTrue(adapter.submit(HL, "a" * 64, Preflight("0", "100", "0", {}, time.time())).rejected)

    def test_revocation_after_signing_blocks_hl_transport(self):
        from hyperliquid.utils.signing import sign_l1_action
        http = Mock()
        adapter = Hyperliquid(HL, wallet=Account.create(), http=http)
        signed = []
        def sign(*args):
            result = sign_l1_action(*args)
            signed.append(True)
            return result
        def guard():
            self.assertEqual(signed, [True])
            raise BrokerError("Grant revoked")
        with patch("hyperliquid.utils.signing.sign_l1_action", side_effect=sign):
            with self.assertRaisesRegex(BrokerError, "revoked"):
                adapter.submit(HL, "a" * 64, Preflight("0", "100", "0", {}, time.time(), before_transport=guard))
        http.request.assert_not_called()

    def test_unknown_order_never_becomes_rejection(self):
        adapter = Hyperliquid(HL, wallet=Account.create(), http=Mock())
        adapter.inventory = lambda _: (D(0), D(0), D(100))
        adapter.info = lambda *a, **kw: {"status": "unknownOid"}
        self.assertEqual(adapter.observe(HL, "a" * 64, Receipt()).state, "unknown")

    def test_documented_hl_cancel_and_reject_variants_are_terminal(self):
        adapter = Hyperliquid(HL, wallet=Account.create(), http=Mock())
        adapter.inventory = lambda _: (D(0), D(0), D(100))
        order = {"coin": "#1230", "cloid": "0x" + "a" * 32, "origSz": "10", "sz": "0", "side": "B", "limitPx": "0.4"}
        for status, expected in [("marginCanceled", "canceled"), ("selfTradeCanceled", "canceled"), ("iocCancelRejected", "rejected"), ("badAloPxRejected", "rejected")]:
            adapter.info = lambda *a, **kw: {"status": "order", "order": {"order": order, "status": status}}
            observed = adapter.observe(HL, "a" * 64, Receipt())
            self.assertEqual(observed.state, expected)
            self.assertTrue(observed.settled)
            if expected == "rejected": self.assertEqual(observed.filled, "0")


class LighterSDKTest(unittest.TestCase):
    def test_real_native_signer_exact_ticks_and_explicit_devnet_chain(self):
        async def run():
            private, _, error = lighter.create_api_key()
            self.assertIsNone(error)
            client = lighter.SignerClient("https://devnet.zklighter.elliot.ai", 42, {2: private}, chain_id=300)
            try:
                kind, raw, _, error = client.sign_create_order(market_index=4555, client_order_index=777, base_amount=100000,
                    price=6000, is_ask=True, order_type=0, time_in_force=0, order_expiry=0, nonce=7, api_key_index=2)
                self.assertIsNone(error)
                self.assertEqual(kind, 14)
                tx = json.loads(raw)
                self.assertEqual({k: tx[k] for k in ["AccountIndex", "ApiKeyIndex", "MarketIndex", "ClientOrderIndex", "BaseAmount", "Price", "IsAsk", "Nonce"]},
                                 {"AccountIndex": 42, "ApiKeyIndex": 2, "MarketIndex": 4555, "ClientOrderIndex": 777, "BaseAmount": 100000, "Price": 6000, "IsAsk": 1, "Nonce": 7})
            finally:
                await client.close()
        asyncio.run(run())

    def test_adapter_constructor_passes_chain_not_hostname_inference(self):
        private, _, error = lighter.create_api_key()
        self.assertIsNone(error)
        with patch.dict("os.environ", {"VERDICT_LIGHTER_API_PRIVATE_KEY": private}):
            adapter = Lighter(LIGHTER)
            try:
                self.assertEqual(adapter.signer.chain_id, 300)
            finally: adapter.close()

    def test_deadline_after_slow_native_nonce_signing_prevents_transport(self):
        private, _, _ = lighter.create_api_key()
        with patch.dict("os.environ", {"VERDICT_LIGHTER_API_PRIVATE_KEY": private}):
            adapter = Lighter(LIGHTER)
        now = time.time()
        clock = [now]
        def slow_sign(*args, **kwargs):
            clock[0] += 10
            return 14, '{}', 'public-hash', None
        try:
            with patch.object(adapter.signer, "sign_create_order", side_effect=slow_sign), patch.object(lighter.SignerClient, "send_tx", new_callable=AsyncMock) as transport, patch("verdict_broker.adapters.time.time", side_effect=lambda: clock[0]):
                with self.assertRaises(BrokerError):
                    adapter.submit(LIGHTER, "a" * 64, Preflight("0", "100", "0", {"market_index": 4555, "client_order_index": 777, "base_amount": 100000, "price": 6000, "is_ask": True, "order_type": 0, "time_in_force": 0}, now, now + 1))
                transport.assert_not_called()
        finally: adapter.close()

    def test_cancel_uses_original_client_index_not_exchange_oid(self):
        class Signer:
            api_client = Mock()
            async def cancel_order(self, **kwargs):
                self.args = kwargs
                return None, NS(code=200), None
            async def close(self): pass
        signer = Signer()
        adapter = Lighter(LIGHTER, signer=signer)
        try:
            adapter.cancel(LIGHTER, "abcdef012345" + "0" * 52, Receipt(order_id="999999999999999"))
            self.assertEqual(signer.args, {"market_index": 4555, "order_index": int("abcdef012345", 16), "api_key_index": 2})
        finally: adapter.close()

    def test_revocation_after_native_signing_blocks_lighter_transport(self):
        private, _, _ = lighter.create_api_key()
        with patch.dict("os.environ", {"VERDICT_LIGHTER_API_PRIVATE_KEY": private}):
            adapter = Lighter(LIGHTER)
        signed = []
        def sign(*args, **kwargs):
            signed.append(True)
            return 14, '{}', 'public-hash', None
        def guard():
            self.assertEqual(signed, [True])
            raise BrokerError("Grant revoked")
        try:
            with patch.object(adapter.signer, "sign_create_order", side_effect=sign), patch.object(lighter.SignerClient, "send_tx", new_callable=AsyncMock) as transport:
                with self.assertRaisesRegex(BrokerError, "revoked"):
                    adapter.submit(LIGHTER, "a" * 64, Preflight("0", "100", "0", {"market_index": 4555, "client_order_index": 777, "base_amount": 100000, "price": 6000, "is_ask": True, "order_type": 0, "time_in_force": 0}, time.time(), before_transport=guard))
                transport.assert_not_called()
            self.assertIsNone(adapter.before_transport)
        finally: adapter.close()

    def test_private_order_terminal_cancellation_variants_reconcile(self):
        class Signer:
            api_client = Mock()
            def create_auth_token_with_expiry(self, **kwargs): return "test-auth-memory-only", None
            async def close(self): pass
        adapter = Lighter(LIGHTER, signer=Signer())
        adapter.inventory = lambda _: (D(0), D(0), D(100))
        order = NS(client_order_index=int("a" * 12, 16), owner_account_index=42, market_index=4555,
                   is_ask=False, initial_base_amount="10", price="0.4", filled_base_amount="3", status="canceled-not-enough-liquidity")
        async def orders(**kw): return NS(code=200, orders=[order])
        adapter.orders = NS(account_orders=orders)
        try:
            for status in ["canceled-not-enough-liquidity", "canceled-expired", "canceled-post-only", "canceled-invalid-balance"]:
                order.status = status
                observed = adapter.observe(LIGHTER, "a" * 64, Receipt())
                self.assertEqual((observed.state, observed.filled, observed.settled), ("canceled", "3", True))
            order.status = "pending"
            self.assertEqual(adapter.observe(LIGHTER, "a" * 64, Receipt()).state, "pending")
        finally: adapter.close()


class PolySDKTest(unittest.TestCase):
    def setUp(self):
        wallet = Account.create()
        deposit_wallet = derive_beacon_deposit_wallet_address(wallet.address, get_environment_config(PRODUCTION).wallet_derivation)
        creds = ApiKeyCreds(apiKey="00000000-0000-4000-8000-000000000000", passphrase="test-only", secret="dGVzdA==")
        self.client = SecureClient._create(private_key=wallet.key.hex(), wallet=deposit_wallet, credentials=creds, validate_credentials=False)
        self.assertEqual(self.client._ctx.wallet_type, "DEPOSIT_WALLET")
        self.assertEqual(self.client._ctx.signer_type, "OWNER")
        self.adapter = Polymarket(POLY, client=self.client, http=Mock())
        self.posts = []
        self.get_patch = patch.object(SyncTransport, "get_json", self.get)
        self.post_patch = patch.object(SyncTransport, "post_json", self.post)
        self.get_patch.start()
        self.post_patch.start()

    def tearDown(self):
        self.get_patch.stop()
        self.post_patch.stop()
        self.adapter.close()

    def get(self, path, **kwargs):
        if path.startswith("/markets-by-token/"):
            return {"condition_id": "0x" + "a" * 64}
        if path.startswith("/clob-markets/"):
            return {"fd": {"r": "0.01", "e": 1}, "nr": False, "mts": "0.01", "t": [{"t": V1_ASSET}, {"t": V2_ASSET}]}
        raise AssertionError("Unexpected SDK GET route: " + path)

    def post(self, path, **kwargs):
        self.assertEqual(path, "/order")
        self.posts.append(kwargs["json"])
        return {"success": True, "errorMsg": "", "orderID": "0x" + "b" * 64, "status": "matched", "makingAmount": "4", "takingAmount": "10", "tradeIDs": [], "transactionsHashes": []}

    def test_real_sdk_signs_exact_shares_and_posts_fak_without_changing_signature(self):
        original = self.client.create_limit_order
        captured = []
        def sign(**kw):
            order = original(**kw)
            captured.append(order)
            return order
        with patch.object(self.client, "create_limit_order", side_effect=sign):
            receipt = self.adapter.submit(POLY, "a" * 64, Preflight("0", "100", "0.1", {}, time.time()))
        body = self.posts[0]
        self.assertEqual(body["orderType"], "FAK")
        self.assertEqual(body["order"]["takerAmount"], "10000000")
        self.assertEqual(body["order"]["makerAmount"], "4000000")
        self.assertEqual(body["order"]["signature"], captured[0].signature)
        self.assertEqual(body["order"]["signatureType"], 3)
        self.assertGreater(len(captured[0].signature), 132)  # Native deposit-wallet signature wrapper.
        self.assertEqual(receipt.order_id, "0x" + "b" * 64)

    def test_sdk_rounding_different_quantity_is_never_posted(self):
        leg = {**POLY, "shares": "10.001"}
        with self.assertRaises(BrokerError):
            self.adapter.submit(leg, "a" * 64, Preflight("0", "100", "0.1", {}, time.time()))
        self.assertFalse(self.posts)

    def test_revocation_after_signing_blocks_polymarket_transport(self):
        original = self.client.create_limit_order
        signed = []
        def sign(**kw):
            result = original(**kw)
            signed.append(True)
            return result
        def guard():
            self.assertEqual(signed, [True])
            raise BrokerError("Grant revoked")
        with patch.object(self.client, "create_limit_order", side_effect=sign):
            with self.assertRaisesRegex(BrokerError, "revoked"):
                self.adapter.submit(POLY, "a" * 64, Preflight("0", "100", "0", {}, time.time(), before_transport=guard))
        self.assertFalse(self.posts)

    def test_all_supported_tifs_use_official_posting_policy(self):
        for tif in ["FAK", "FOK", "GTC", "GTD"]:
            leg = {**POLY, "tif": tif}
            if tif == "GTD":
                leg["expiration"] = int(datetime.now(timezone.utc).timestamp()) + 600
            self.adapter.submit(leg, "a" * 64, Preflight("0", "100", "0.1", {}, time.time()))
            self.assertEqual(self.posts[-1]["orderType"], tif)

    def test_matched_is_not_settled_and_net_inventory_is_not_gross(self):
        self.adapter.inventory = lambda _: NS(balance=9_990_000)
        order = NS(id="order", asset_id=V1_ASSET, maker_address=ACCOUNT, side="BUY", original_size=D(10), price=D("0.4"),
                   size_matched=D(10), status="MATCHED", associate_trades=("trade",))
        with patch.object(self.client, "get_order", return_value=order), patch.object(self.client, "list_account_trades", return_value=[NS(id="trade", status="MINED")]):
            observed = self.adapter.observe(POLY, "a" * 64, Receipt(order_id="order"))
        self.assertFalse(observed.settled)
        self.assertEqual(observed.inventory, "9.99")
        self.assertEqual(observed.filled, "10")

    def test_lost_order_id_stays_unknown_and_cannot_cancel_all(self):
        self.adapter.inventory = lambda _: NS(balance=0)
        self.assertEqual(self.adapter.observe(POLY, "a" * 64, Receipt()).state, "unknown")
        with self.assertRaises(BrokerError):
            self.adapter.cancel(POLY, "a" * 64, Receipt())

    def test_cancel_does_not_depend_on_unrelated_balance_or_settlement_reads(self):
        order = NS(id="order", asset_id=V1_ASSET, maker_address=ACCOUNT, side="BUY", original_size=D(10), price=D("0.4"),
                   size_matched=D(3), status="LIVE", associate_trades=("pending-trade",))
        with patch.object(self.adapter, "inventory", side_effect=RuntimeError("balance endpoint temporarily unavailable")), patch.object(self.client, "get_order", return_value=order), patch.object(self.client, "list_account_trades", side_effect=AssertionError("cancellation must not await settlement")), patch.object(self.client, "cancel_order", return_value=NS(canceled=("order",))) as cancel:
            self.adapter.cancel(POLY, "a" * 64, Receipt(order_id="order"))
            cancel.assert_called_once_with(order_id="order")

    def test_v2_uses_position_id_and_conditional_v2_balance(self):
        market = NS(id="123", version="v2", outcomes=NS(yes=NS(position_id=V2_ASSET, token_id="wrong")))
        with patch.object(self.client, "get_market", return_value=market):
            self.adapter.market({**POLY, "assetId": V2_ASSET})
            self.assertEqual(self.adapter.asset_type, "CONDITIONAL-V2")

    def test_real_sdk_signs_and_posts_v2_position_id(self):
        self.adapter.submit({**POLY, "assetId": V2_ASSET}, "a" * 64, Preflight("0", "100", "0.1", {}, time.time()))
        self.assertEqual(self.posts[0]["order"]["tokenId"], V2_ASSET)
        self.assertEqual(self.posts[0]["order"]["signatureType"], 3)
        self.assertEqual(self.posts[0]["order"]["takerAmount"], "10000000")

    def test_constructor_never_uses_auto_deploy_or_creates_api_credentials(self):
        created = NS(_ctx=NS(wallet_type="DEPOSIT_WALLET", relayer=Mock()), close=Mock(), fetch_api_keys=lambda: ("test-key",))
        env = {"VERDICT_POLYMARKET_DEPOSIT_WALLET": ACCOUNT, "VERDICT_POLYMARKET_PRIVATE_KEY": "test-placeholder",
               "VERDICT_POLYMARKET_API_KEY": "test-key", "VERDICT_POLYMARKET_API_PASSPHRASE": "test-pass", "VERDICT_POLYMARKET_API_SECRET": "dGVzdA=="}
        with patch.dict("os.environ", env), patch.object(SecureClient, "create", side_effect=AssertionError("must not auto-deploy")), patch.object(SecureClient, "_create", return_value=created) as make, patch("polymarket._internal.actions.relayer.deployed.fetch_deployed_sync", return_value=False):
            with self.assertRaises(BrokerError):
                Polymarket(POLY)
            self.assertIsNotNone(make.call_args.kwargs["credentials"])
            self.assertIs(make.call_args.kwargs["validate_credentials"], False)
            created.close.assert_called_once()

    def test_bad_api_credentials_fail_without_sdk_key_creation_fallback(self):
        from polymarket._internal.actions import auth
        from polymarket.models.clob.api_key import ApiKeyCreds
        real = SecureClient._create
        wallet = Account.create()
        creds = ApiKeyCreds(apiKey="test-key", passphrase="test-only", secret="dGVzdA==")
        env = {"VERDICT_POLYMARKET_DEPOSIT_WALLET": ACCOUNT, "VERDICT_POLYMARKET_PRIVATE_KEY": wallet.key.hex(),
               "VERDICT_POLYMARKET_API_KEY": creds.key, "VERDICT_POLYMARKET_API_PASSPHRASE": creds.passphrase, "VERDICT_POLYMARKET_API_SECRET": creds.secret}
        def build(**kw):
            # Exercise the REAL SDK bootstrap with the broker's validate flag.
            return real(**{**kw, "wallet": wallet.address})
        with patch.dict("os.environ", env), patch.object(SecureClient, "_create", side_effect=build), patch.object(SecureClient, "fetch_api_keys", return_value=()), patch.object(auth, "create_or_derive_api_key_sync", side_effect=AssertionError("must not create keys")) as bootstrap:
            with self.assertRaises(BrokerError):
                Polymarket(POLY)
            bootstrap.assert_not_called()

    def test_slow_signing_metadata_cannot_post_past_deadline(self):
        signed = self.client.create_limit_order(asset_id=V1_ASSET, price=D("0.4"), size=D(10), side="BUY")
        now = time.time()
        with patch.object(self.client, "create_limit_order", return_value=signed), patch("verdict_broker.adapters.time.time", return_value=now + 10):
            with self.assertRaises(BrokerError):
                self.adapter.submit(POLY, "a" * 64, Preflight("0", "100", "0.1", {}, now, now + 1))
        self.assertFalse(self.posts)

    def test_unrepresentable_shares_fail_before_any_sdk_signing_or_network_read(self):
        with patch.object(self.client, "get_market", side_effect=AssertionError("must reject at local boundary")):
            with self.assertRaises(BrokerError):
                self.adapter.preflight({**POLY, "shares": "10.001"}, "a" * 64)

    def test_conflicting_open_orders_block_before_raw_balances_are_trusted(self):
        market = NS(question=BASE["title"], description=BASE["settlementRule"], state=NS(active=True, closed=False, accepting_orders=True, enable_order_book=True, end_date=None))
        with patch.object(self.adapter, "market", return_value=market), patch.object(self.client, "get_closed_only_mode", return_value=False), patch.object(self.client, "list_open_orders", return_value=iter([NS(id="resting-order")])):
            with self.assertRaisesRegex(BrokerError, "reserving balances"):
                self.adapter.preflight(POLY, "a" * 64)


class PureBoundaryTest(unittest.TestCase):
    def test_immediate_depth_requires_full_quantity_within_limit(self):
        with self.assertRaises(BrokerError):
            check_depth(POLY, [("0.4", "9"), ("0.41", "100")])
        check_depth(POLY, [("0.39", "5"), ("0.4", "5")])
        check_depth({**POLY, "tif": "GTC"}, [])

    def test_fee_rounds_up_to_usdc_micro_units(self):
        self.assertEqual(fee_round(D("0.0000001")), "0.000001")

    def test_public_polymarket_snapshot_reads_both_assets_and_sorts_books(self):
        from verdict_broker.public import public_market
        market = NS(id="123", question=BASE["title"], description=BASE["settlementRule"], condition_id="0x" + "a" * 64, version="v1",
                    outcomes=NS(yes=NS(token_id="123"), no=NS(token_id="456")),
                    state=NS(active=True, closed=False, accepting_orders=True, enable_order_book=True, end_date=None))
        client = Mock()
        client.get_market.return_value = market
        def book(*, asset_id):
            return NS(asset_id=asset_id, condition_id=market.condition_id, timestamp=datetime.now(timezone.utc), tick_size=D("0.01"), min_order_size=D(1),
                      asks=[NS(price=D("0.6"), size=D(2)), NS(price=D("0.5"), size=D(3))], bids=[])
        client.get_order_book.side_effect = book
        http = Mock()
        http.request.return_value = {"fd": None}
        with patch("polymarket.PublicClient", return_value=client), patch("verdict_broker.adapters.JsonHTTP", return_value=http):
            result = public_market("polymarket", "polygon", "123")
        self.assertEqual(result["market"]["assets"], {"yes": "123", "no": "456"})
        self.assertTrue(result["market"]["enableOrderBook"])
        self.assertEqual(result["book"]["yes"]["asks"][0]["price"], "0.5")
        self.assertEqual(client.get_order_book.call_count, 2)
        client.close.assert_called_once()

    def test_public_snapshot_refuses_cross_network_and_malformed_ids(self):
        from verdict_broker.public import public_market
        for venue, network, market in [("polymarket", "mainnet", "123"), ("lighter", "polygon", "123"), ("hl", "testnet", "../../key")]:
            with self.assertRaises(BrokerError):
                public_market(venue, network, market)


if __name__ == "__main__":
    unittest.main()
