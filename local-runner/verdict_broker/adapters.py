"""Pinned official SDK boundaries. No network endpoints or secrets come from proposals."""
from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime
from decimal import Decimal, ROUND_CEILING
import logging
import os
import time

from .core import BrokerError, D, Observation, Preflight, Receipt, node_call


def secret(name):
    value = os.environ.get(name)
    if not value:
        raise BrokerError(f"Missing local operator environment variable {name}")
    return value


def fee_round(value):
    return str(value.quantize(D("0.000001"), rounding=ROUND_CEILING))


def send_deadline(preflight):
    return preflight.valid_until if preflight.valid_until is not None else preflight.checked_at + 5


def fresh_send(deadline):
    if time.time() >= deadline:
        raise BrokerError("Proposal/preflight deadline passed before transport; no order posted")


def check_rule(leg, title, rule):
    if not rule or rule != leg["settlementRule"] or title != leg["title"]:
        raise BrokerError("Market title or settlement rule differs from the confirmed proposal")


def check_depth(leg, levels):
    """An immediate order needs full visible depth within its immutable limit."""
    if leg["tif"] not in {"Ioc", "ioc", "FAK", "FOK"}:
        return
    wanted = D(leg["shares"])
    buy = leg["action"] == "buy"
    total = sum((D(s) for p, s in levels if (D(p) <= D(leg["limitPrice"]) if buy else D(p) >= D(leg["limitPrice"]))), D(0))
    if total < wanted:
        raise BrokerError("Fresh visible depth within the approved limit is insufficient")


class JsonHTTP:
    def __init__(self):
        import requests
        self.session = requests.Session()
        self.session.trust_env = False

    def request(self, method, url, **kwargs):
        response = self.session.request(method, url, timeout=15, allow_redirects=False, **kwargs)
        if not 200 <= response.status_code < 300:
            raise BrokerError("Venue returned a non-success HTTP status (details hidden)")
        return response.json()

    def close(self):
        self.session.close()


class Hyperliquid:
    def __init__(self, leg, *, wallet=None, http=None, bridge=node_call):
        from eth_account import Account
        self.wallet = wallet or Account.from_key(secret("VERDICT_HL_AGENT_PRIVATE_KEY"))
        if self.wallet.address.lower() == leg["account"]:
            raise BrokerError("Use a dedicated approved HL agent key, not the main wallet")
        self.host = "https://api.hyperliquid.xyz" if leg["network"] == "mainnet" else "https://api.hyperliquid-testnet.xyz"
        self.http, self.bridge = http or JsonHTTP(), bridge
        self.nonce = 0

    def info(self, kind, **args):
        return self.http.request("POST", self.host + "/info", json={"type": kind, **args})

    def env(self, leg):
        return {"VERDICT_NETWORK": leg["network"], "VERDICT_BUILDER_ADDRESS": leg["builder"]["address"],
                "VERDICT_BUILDER_FEE_TENTHS_BP": str(leg["builder"]["feeTenthsBp"])}

    def inventory(self, leg):
        balances = self.info("spotClearinghouseState", user=leg["account"])["balances"]
        token = "+" + str(10 * leg["outcome"] + (leg["side"] == "no"))
        def available(coin):
            return sum((D(b["total"]) - D(b["hold"]) for b in balances if b["coin"] == coin), D(0))
        def total(coin):
            return sum((D(b["total"]) for b in balances if b["coin"] == coin), D(0))
        return total(token), available(token), available("USDC")

    def preflight(self, leg, client_id):
        started = time.time()
        agents = self.info("extraAgents", user=leg["account"])
        if not any(a["address"].lower() == self.wallet.address.lower() and int(a["validUntil"]) > time.time() * 1000 for a in agents):
            raise BrokerError("HL agent is not currently approved for the confirmed account/network")
        if self.info("maxBuilderFee", user=leg["account"], builder=leg["builder"]["address"]) < leg["builder"]["feeTenthsBp"]:
            raise BrokerError("HL builder approval below confirmed fee; approve separately")
        args = [str(leg["outcome"]), "--side", leg["side"], "--action", leg["action"], "--price", leg["limitPrice"],
                "--size", leg["shares"], "--tif", leg["tif"], "--cloid", "0x" + client_id[:32]]
        built = self.bridge(["build-order", *args], self.env(leg))
        check_rule(leg, built["market"]["displayName"], built["market"]["settlementRule"])
        market = self.bridge(["market", str(leg["outcome"])], self.env(leg))
        if market["quoteToken"] != "USDC" or not market["expiresAt"] or datetime.fromisoformat(market["expiresAt"].replace("Z", "+00:00")).timestamp() <= time.time():
            raise BrokerError("HL market is expired, has unknown expiry, or is not USDC quoted")
        book = self.info("l2Book", coin=built["side"]["coin"])
        if abs(time.time() * 1000 - int(book["time"])) > 5000:
            raise BrokerError("HL book timestamp is stale")
        levels = book["levels"][1 if leg["action"] == "buy" else 0]
        check_depth(leg, [(l["px"], l["sz"]) for l in levels])
        total, available, cash = self.inventory(leg)
        if leg["action"] == "sell" and available < D(leg["shares"]):
            raise BrokerError("HL tokens are held by resting orders")
        # HIP-4 all-in cap is operator-declared; do not substitute perp/spot fee tiers.
        price_bound = D(leg["limitPrice"]) if leg["action"] == "buy" else D(1)
        fee = D(leg["shares"]) * price_bound * D(leg["allInFeeBpsCap"]) / 10000
        return Preflight(str(total), str(cash), fee_round(fee), built["action"], started)

    def _send(self, leg, action, deadline=None):
        from hyperliquid.utils.signing import sign_l1_action
        self.nonce = max(self.nonce + 1, int(time.time() * 1000))
        expiry = min(self.nonce + 5000, int(deadline * 1000)) if deadline is not None else self.nonce + 5000
        signature = sign_l1_action(self.wallet, action, None, self.nonce, expiry, leg["network"] == "mainnet")
        if deadline is not None:
            fresh_send(deadline)
        return self.http.request("POST", self.host + "/exchange", json={"action": action, "nonce": self.nonce,
                                  "signature": signature, "vaultAddress": None, "expiresAfter": expiry})

    def submit(self, leg, client_id, preflight):
        result = self._send(leg, preflight.native, send_deadline(preflight))
        if result.get("status") != "ok":
            return Receipt(rejected=True)
        statuses = result["response"]["data"]["statuses"]
        if len(statuses) != 1:
            raise BrokerError("Unexpected HL order response")
        item = statuses[0]
        if isinstance(item, dict) and "error" in item:
            return Receipt(rejected=True)
        data = item.get("filled", item.get("resting", {})) if isinstance(item, dict) else {}
        return Receipt(order_id=str(data["oid"]) if "oid" in data else None)

    def observe(self, leg, client_id, receipt):
        inventory, _, _ = self.inventory(leg)
        if receipt.rejected:
            return Observation("rejected", "0", str(inventory), True)
        result = self.info("orderStatus", user=leg["account"], oid="0x" + client_id[:32])
        if result.get("status") != "order":
            return Observation("unknown", "0", str(inventory), False)
        data = result["order"]
        order = data["order"]
        expected_coin = "#" + str(10 * leg["outcome"] + (leg["side"] == "no"))
        if (order["coin"] != expected_coin or order["cloid"].lower() != "0x" + client_id[:32]
                or D(order["origSz"]) != D(leg["shares"]) or order["side"] != ("B" if leg["action"] == "buy" else "A")
                or D(order["limitPx"]) != D(leg["limitPrice"])):
            raise BrokerError("HL order identity mismatch")
        status = data["status"]
        # Documented info/orderStatus terminal variants, rather than a suffix guess.
        canceled = {"canceled", "marginCanceled", "vaultWithdrawalCanceled", "openInterestCapCanceled", "selfTradeCanceled", "reduceOnlyCanceled", "siblingFilledCanceled", "delistedCanceled", "liquidatedCanceled", "scheduledCancel"}
        rejected = {"rejected", "tickRejected", "minTradeNtlRejected", "perpMarginRejected", "reduceOnlyRejected", "badAloPxRejected", "iocCancelRejected", "badTriggerPxRejected", "marketOrderNoLiquidityRejected", "positionIncreaseAtOpenInterestCapRejected", "positionFlipAtOpenInterestCapRejected", "tooAggressiveAtOpenInterestCapRejected", "openInterestIncreaseRejected", "insufficientSpotBalanceRejected", "oracleRejected", "perpMaxPositionRejected"}
        state = "canceled" if status in canceled else "rejected" if status in rejected else {"filled": "filled", "open": "open"}.get(status, "unknown")
        filled = D(0) if state == "rejected" else D(order["origSz"]) - D(order["sz"])
        return Observation(state, str(filled), str(inventory), state in {"filled", "canceled", "rejected"})

    def cancel(self, leg, client_id, receipt):
        # The same immutable client identity and asset, never account-wide cancellation.
        action = {"type": "cancelByCloid", "cancels": [{"asset": 100_000_000 + leg["outcome"] * 10 + (leg["side"] == "no"), "cloid": "0x" + client_id[:32]}]}
        result = self._send(leg, action)
        if result.get("status") != "ok":
            raise BrokerError("HL cancel not acknowledged")

    def close(self):
        self.http.close()


class Lighter:
    def __init__(self, leg, *, signer=None, bridge=node_call):
        import lighter
        logging.getLogger("lighter").setLevel(logging.WARNING)
        self.loop = asyncio.new_event_loop()
        self.deadline = None
        self.host = "https://mainnet.zklighter.elliot.ai" if leg["network"] == "mainnet" else "https://devnet.zklighter.elliot.ai"
        async def create():
            broker_adapter = self
            class DeadlineSigner(lighter.SignerClient):
                async def send_tx(self, tx_type, tx_info):
                    if broker_adapter.deadline is not None:
                        fresh_send(broker_adapter.deadline)
                    return await super().send_tx(tx_type=tx_type, tx_info=tx_info)
            return DeadlineSigner(url=self.host, account_index=leg["account"], chain_id=304 if leg["network"] == "mainnet" else 300,
                                        api_private_keys={leg["apiKeyIndex"]: secret("VERDICT_LIGHTER_API_PRIVATE_KEY")})
        self.signer = signer or self.loop.run_until_complete(create())
        self.orders = lighter.OrderApi(self.signer.api_client)
        self.bridge = bridge
        self.key_index = leg["apiKeyIndex"]

    def run(self, awaitable):
        return self.loop.run_until_complete(awaitable)

    def env(self, leg):
        return {"LIGHTER_NETWORK": leg["network"], "LIGHTER_CREATORS": str(leg["creator"])}

    def inventory(self, leg):
        result = self.bridge(["lighter", "positions", str(leg["account"])], self.env(leg))
        positions = result["positions"]
        # Opposite inventory nets on Lighter; an opposite holding invalidates a buy hedge.
        wanted = sum((D(p["size"]) for p in positions if p["market_id"] == leg["market"] and p["side"] == leg["side"]), D(0))
        opposite = sum((D(p["size"]) for p in positions if p["market_id"] == leg["market"] and p["side"] != leg["side"]), D(0))
        return wanted, opposite, D(result["availableBalanceUSDC"])

    def preflight(self, leg, client_id):
        started = time.time()
        error = self.signer.check_client()
        if error:
            raise BrokerError("Lighter API key/account binding failed")
        built = self.bridge(["lighter", "build-order", str(leg["market"]), "--side", leg["side"], "--action", leg["action"],
                             "--price", leg["limitPrice"], "--size", leg["shares"], "--tif", leg["tif"],
                             "--client-order-index", str(int(client_id[:12], 16))], self.env(leg))
        m = built["market"]
        if m["creator"] != leg["creator"]:
            raise BrokerError("Lighter creator changed")
        check_rule(leg, m["title"], m["settlementRule"])
        book = self.bridge(["lighter", "book", str(leg["market"])], self.env(leg))
        takes_ask = (leg["side"] == "yes") == (leg["action"] == "buy")
        levels = book["asks" if takes_ask else "bids"]
        check_depth(leg, [(D(l["price"]) if leg["side"] == "yes" else 1 - D(l["price"]), l["shares"]) for l in levels])
        owned, opposite, cash = self.inventory(leg)
        if leg["action"] == "buy" and opposite:
            raise BrokerError("Lighter buy would net existing opposite inventory; use a dedicated clean account/market")
        # Check existing orders too: public positions do not subtract reserved binary inventory.
        auth, err = self.signer.create_auth_token_with_expiry(api_key_index=self.key_index)
        if err:
            raise BrokerError("Lighter authentication unavailable")
        active = self.run(self.orders.account_active_orders(authorization=auth, account_index=leg["account"], market_id=leg["market"], _request_timeout=15))
        if active.code != 200 or active.orders:
            raise BrokerError("Lighter market has other open orders; cancel/reconcile them separately")
        rate = max(D(m["taker_fee"]) if m["is_taker_fee_enabled"] else D(0), D(m["maker_fee"]) if m["is_maker_fee_enabled"] else D(0)) / 100
        return Preflight(str(owned), str(cash), fee_round(D(leg["shares"]) * rate / 4), built["sdkArgs"], started)

    def submit(self, leg, client_id, preflight):
        self.deadline = send_deadline(preflight)
        fresh_send(self.deadline)
        try:
            _, response, error = self.run(self.signer.create_order(**preflight.native, api_key_index=self.key_index))
        finally:
            self.deadline = None
        if error or response is None:
            raise BrokerError("Lighter submission outcome unknown")
        if response.code != 200:
            return Receipt(rejected=True)
        return Receipt(transaction_id=response.tx_hash)

    def observe(self, leg, client_id, receipt):
        inventory, _, _ = self.inventory(leg)
        if receipt.rejected:
            return Observation("rejected", "0", str(inventory), True)
        auth, err = self.signer.create_auth_token_with_expiry(api_key_index=self.key_index)
        if err:
            raise BrokerError("Lighter auth unavailable")
        result = self.run(self.orders.account_orders(authorization=auth, account_index=leg["account"], client_order_indexes=str(int(client_id[:12], 16)), _request_timeout=15))
        if result.code != 200:
            raise BrokerError("Lighter order read failed")
        found = [o for o in result.orders if o.client_order_index == int(client_id[:12], 16)]
        if len(found) != 1:
            return Observation("unknown", "0", str(inventory), False)
        order = found[0]
        is_ask = (leg["side"] == "yes") != (leg["action"] == "buy")
        up_price = D(leg["limitPrice"]) if leg["side"] == "yes" else 1 - D(leg["limitPrice"])
        if (order.owner_account_index != leg["account"] or order.market_index != leg["market"] or order.is_ask != is_ask
                or D(order.initial_base_amount) != D(leg["shares"]) or D(order.price) != up_price):
            raise BrokerError("Lighter order identity mismatch")
        status = order.status.lower()
        known_cancels = {"canceled", "canceled-post-only", "canceled-reduce-only", "canceled-position-not-allowed", "canceled-margin-not-allowed", "canceled-too-much-slippage", "canceled-not-enough-liquidity", "canceled-self-trade", "canceled-expired", "canceled-oco", "canceled-child", "canceled-liquidation", "canceled-invalid-balance"}
        state = "canceled" if status in known_cancels else {"open": "open", "filled": "filled", "pending": "pending", "in-progress": "pending", "expired": "expired", "rejected": "rejected"}.get(status, "unknown")
        # Final exchange state plus an inventory reconciliation, not sendTx success.
        return Observation(state, order.filled_base_amount, str(inventory), state in {"filled", "canceled", "expired", "rejected"})

    def cancel(self, leg, client_id, receipt):
        _, response, error = self.run(self.signer.cancel_order(market_index=leg["market"], order_index=int(client_id[:12], 16), api_key_index=self.key_index))
        if error or response is None or response.code != 200:
            raise BrokerError("Lighter cancel outcome unknown")

    def close(self):
        self.run(self.signer.close())
        self.loop.close()


class Polymarket:
    def __init__(self, leg, *, client=None, http=None):
        from polymarket import SecureClient
        wallet = os.environ.get("VERDICT_POLYMARKET_DEPOSIT_WALLET", "").lower()
        if client is None and wallet != leg["account"]:
            raise BrokerError("Polymarket local deposit wallet differs from confirmed account")
        if client is None:
            from polymarket.models.clob.api_key import ApiKeyCreds
            from polymarket._internal.actions.relayer.deployed import fetch_deployed_sync
            from polymarket.models.clob.relayer import RelayerTransactionType
            creds = ApiKeyCreds(apiKey=secret("VERDICT_POLYMARKET_API_KEY"), passphrase=secret("VERDICT_POLYMARKET_API_PASSPHRASE"), secret=secret("VERDICT_POLYMARKET_API_SECRET"))
            # Pinned SDK hook: public create() may deploy a wallet. _create with supplied
            # credentials only validates auth; check deployment read-only and never set up.
            client = SecureClient._create(private_key=secret("VERDICT_POLYMARKET_PRIVATE_KEY"), wallet=wallet, credentials=creds, validate_credentials=False)
            try:
                if creds.key not in client.fetch_api_keys():
                    raise BrokerError("Polymarket supplied API credentials are inactive; no automatic credential creation")
                if client._ctx.wallet_type != "DEPOSIT_WALLET" or not fetch_deployed_sync(client._ctx.relayer, address=wallet, type=RelayerTransactionType.WALLET):
                    raise BrokerError("Use an existing deployed Polymarket deposit wallet; set it up separately")
            except Exception:
                client.close()
                raise
        self.client = client
        self.http = http or JsonHTTP()
        self.asset_type = None

    def market(self, leg):
        market = self.client.get_market(id=leg["marketId"])
        outcome = market.outcomes.yes if leg["side"] == "yes" else market.outcomes.no
        asset = outcome.position_id if market.version == "v2" else outcome.token_id
        if str(market.id) != leg["marketId"] or str(asset) != leg["assetId"] or market.version not in {"v1", "v2"}:
            raise BrokerError("Polymarket market/outcome asset or protocol version mismatch")
        self.asset_type = "CONDITIONAL-V2" if market.version == "v2" else "CONDITIONAL"
        return market

    def inventory(self, leg):
        if self.asset_type is None:
            self.market(leg)
        return self.client.get_balance_allowance(asset_type=self.asset_type, asset_id=leg["assetId"])

    def preflight(self, leg, client_id):
        started = time.time()
        if D(leg["shares"]) * 100 != (D(leg["shares"]) * 100).to_integral_value():
            raise BrokerError("Polymarket size is outside the pinned SDK's 0.01 share grid")
        market = self.market(leg)
        check_rule(leg, market.question, market.description)
        state = market.state
        if state.active is not True or state.closed is not False or state.accepting_orders is not True or state.enable_order_book is not True:
            raise BrokerError("Polymarket market is not accepting orders")
        if state.end_date and state.end_date.timestamp() <= time.time():
            raise BrokerError("Polymarket market has ended")
        if self.client.get_closed_only_mode():
            raise BrokerError("Polymarket account is closed-only")
        # Raw /balance-allowance is not an available balance when resting orders reserve it.
        # Initial scope deliberately requires a clean account rather than guessing reservations.
        if next(iter(self.client.list_open_orders()), None) is not None:
            raise BrokerError("Polymarket has open orders reserving balances; cancel/reconcile them separately")
        book = self.client.get_order_book(asset_id=leg["assetId"])
        if str(book.asset_id) != leg["assetId"] or str(book.condition_id) != str(market.condition_id):
            raise BrokerError("Polymarket book identity mismatch")
        if book.timestamp is None or abs(book.timestamp.timestamp() - time.time()) > 5:
            raise BrokerError("Polymarket book source timestamp is missing/stale")
        if D(leg["shares"]) < book.min_order_size or D(leg["limitPrice"]) % book.tick_size:
            raise BrokerError("Polymarket size/tick constraints changed")
        levels = book.asks if leg["action"] == "buy" else book.bids
        check_depth(leg, [(l.price, l.size) for l in levels])
        inventory = self.inventory(leg)
        cash = self.client.get_balance_allowance(asset_type="COLLATERAL")
        # Conservative current CLOB fee envelope, including prices improving toward 0.5.
        # This is the pinned SDK's /clob-markets fee schema, not Gamma's cached fee display.
        metadata = self.http.request("GET", "https://clob.polymarket.com/clob-markets/" + str(market.condition_id))
        fd = metadata.get("fd")
        if fd is None:
            rate = D(0)
        else:
            rate, exponent = D(str(fd["r"])), D(str(fd["e"]))
            if not rate.is_finite() or not exponent.is_finite() or rate < 0 or rate > 1 or exponent < 0:
                raise BrokerError("Unsupported Polymarket fee schedule")
        fee = D(leg["shares"]) * rate
        need = (D(leg["shares"]) * D(leg["limitPrice"]) if leg["action"] == "buy" else D(0)) + D(leg["feeReserveUSDC"])
        # No allowance-recovery writes: operator grants permissions separately.
        # Requiring every returned allowance is conservative across protocol exchanges.
        allowance = cash if leg["action"] == "buy" else inventory
        needed_units = need * 1_000_000 if leg["action"] == "buy" else D(leg["shares"]) * 1_000_000
        if not allowance.allowances or min(allowance.allowances.values()) < needed_units:
            raise BrokerError("Polymarket allowance insufficient; configure it separately")
        return Preflight(str(D(inventory.balance) / 1_000_000), str(D(cash.balance) / 1_000_000), fee_round(fee), {}, started)

    def submit(self, leg, client_id, preflight):
        signed = self.client.create_limit_order(asset_id=leg["assetId"], price=D(leg["limitPrice"]), size=D(leg["shares"]),
                                               side=leg["action"].upper(), expiration=leg.get("expiration"))
        # TIF is an unsigned POST policy in this pinned SDK. Do not change signed fields.
        signed = replace(signed, order_type=leg["tif"])
        shares = D(signed.taker_amount if leg["action"] == "buy" else signed.maker_amount) / 1_000_000
        price = D(signed.maker_amount) / signed.taker_amount if leg["action"] == "buy" else D(signed.taker_amount) / signed.maker_amount
        if shares != D(leg["shares"]) or (price > D(leg["limitPrice"]) if leg["action"] == "buy" else price < D(leg["limitPrice"])):
            raise BrokerError("SDK rounded confirmed shares or worsened limit; nothing posted")
        fresh_send(send_deadline(preflight))
        result = self.client.post_order(signed)
        return Receipt(order_id=str(result.order_id)) if result.ok else Receipt(rejected=True)

    def _read_order(self, leg, receipt):
        order = self.client.get_order(order_id=receipt.order_id)
        if (str(order.id) != receipt.order_id or str(order.asset_id) != leg["assetId"] or order.maker_address.lower() != leg["account"]
                or order.side != leg["action"].upper() or order.original_size != D(leg["shares"]) or order.price != D(leg["limitPrice"])):
            raise BrokerError("Polymarket order/account identity mismatch")
        return order

    def observe(self, leg, client_id, receipt):
        inventory = str(D(self.inventory(leg).balance) / 1_000_000)
        if receipt.rejected:
            return Observation("rejected", "0", inventory, True)
        if receipt.order_id is None:
            return Observation("unknown", "0", inventory, False)
        order = self._read_order(leg, receipt)
        state = {"LIVE": "open", "MATCHED": "filled", "CANCELED": "canceled", "CANCELLED": "canceled", "EXPIRED": "expired", "DELAYED": "pending"}.get(order.status.upper(), "unknown")
        settled = order.size_matched == 0
        if order.size_matched > 0 and order.associate_trades:
            settled = True
            for trade_id in order.associate_trades:
                trades = list(self.client.list_account_trades(id=trade_id, asset_id=leg["assetId"]))
                if len(trades) != 1 or trades[0].id != trade_id or trades[0].status != "CONFIRMED":
                    settled = False
        # Gross matched shares are never used as net acquired shares. Core checks token delta.
        return Observation(state, str(order.size_matched), inventory, settled)

    def cancel(self, leg, client_id, receipt):
        if receipt.order_id is None:
            raise BrokerError("Lost Polymarket order id; reconcile manually, never guess/cancel all")
        self._read_order(leg, receipt)  # Verify identity without depending on balances or settlement.
        result = self.client.cancel_order(order_id=receipt.order_id)
        if receipt.order_id not in result.canceled:
            raise BrokerError("Polymarket cancellation not acknowledged")

    def close(self):
        self.client.close()
        self.http.close()


def create_adapter(leg):
    return {"hl": Hyperliquid, "lighter": Lighter, "polymarket": Polymarket}[leg["venue"]](leg)
