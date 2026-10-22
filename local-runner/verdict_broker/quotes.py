"""Public, replayable Polymarket depth/fee research. No signing or inventory inference."""
from datetime import datetime
from decimal import Decimal, InvalidOperation, localcontext
import re
import time

from .core import BrokerError

D = Decimal
PLAIN = re.compile(r"\d{1,16}(?:\.\d{1,12})?\Z")
TICKS = {D(x) for x in ["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"]}


def decimal(value, *, maximum=D("1000000000000000"), positive=False):
    if not isinstance(value, str) or not PLAIN.fullmatch(value):
        raise BrokerError("Invalid quote decimal (values hidden)")
    result = D(value)
    if result > maximum or (positive and result <= 0):
        raise BrokerError("Quote decimal outside supported bounds (values hidden)")
    return result


def text(value):
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def timestamp(value):
    if not isinstance(value, str):
        raise BrokerError("Missing quote source timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return int(parsed.timestamp() * 1000)
    except (ValueError, OverflowError) as e:
        raise BrokerError("Invalid quote source timestamp") from e


def fee_number(value, maximum):
    if type(value) not in {str, int, float} or len(str(value)) > 64:
        raise BrokerError("Unsupported CLOB fee number")
    try:
        number = D(str(value))
    except InvalidOperation as e:
        raise BrokerError("Invalid CLOB fee number") from e
    if not number.is_finite() or number < 0 or number > maximum:
        raise BrokerError("CLOB fee number outside supported bounds")
    if not number:
        return D(0)
    if number.adjusted() < -24:
        raise BrokerError("CLOB fee number exceeds supported precision")
    with localcontext() as ctx:
        ctx.prec = 256
        number = number.normalize()
    if number.as_tuple().exponent < -24:
        raise BrokerError("CLOB fee number exceeds supported precision")
    return number


def fee_parameters(value):
    # None is an explicitly captured fee-free schedule; absence is NOT zero.
    if value is None:
        return D(0), 0
    if not isinstance(value, dict) or "r" not in value or "e" not in value:
        raise BrokerError("Missing/unsupported current CLOB fee parameters")
    rate = fee_number(value["r"], D(1))
    exponent = fee_number(value["e"], D(8))
    if exponent % 1:
        raise BrokerError("Only integer CLOB fee exponents 0..8 are supported for quote research")
    return rate, int(exponent)


def levels(value, tick):
    if not isinstance(value, list) or len(value) > 10000:
        raise BrokerError("Invalid or oversized quote depth")
    grouped = {}
    for row in value:
        if not isinstance(row, dict) or set(row) != {"price", "shares"}:
            raise BrokerError("Invalid quote level fields")
        price = decimal(row["price"], maximum=D(1), positive=True)
        size = decimal(row["shares"], positive=True)
        if price >= 1 or price % tick:
            raise BrokerError("Book price outside the current tick grid")
        grouped[price] = grouped.get(price, D(0)) + size
    return grouped


def quote_polymarket(snapshot, side, action, shares, *, limit_price=None, at=None, max_age_ms=5000):
    """Walk a public snapshot. Caller controls evaluation time only for explicit replay."""
    if side not in {"yes", "no"} or action not in {"buy", "sell"}:
        raise BrokerError("Quote side/action must be yes|no and buy|sell")
    wanted = decimal(shares, maximum=D("1000000000"), positive=True)
    if wanted * 100 != (wanted * 100).to_integral_value():
        raise BrokerError("Polymarket shares must fit the pinned SDK's 0.01 share grid")
    if type(max_age_ms) is not int or not 1 <= max_age_ms <= 60000:
        raise BrokerError("Quote age budget must be 1..60000 milliseconds")
    now = int(time.time() * 1000) if at is None else at
    if type(now) is not int or now < 0 or now > 8_640_000_000_000_000:
        raise BrokerError("Invalid quote evaluation time")
    try:
        if snapshot["venue"] != "polymarket" or snapshot["network"] != "polygon":
            raise BrokerError("Quote requires a Polymarket polygon snapshot")
        market = snapshot["market"]
        market_id = market["marketId"]
        asset = market["assets"][side]
        if not isinstance(market_id, str) or not re.fullmatch(r"\d{1,20}", market_id) or not isinstance(asset, str) or not re.fullmatch(r"\d{1,78}", asset) or int(asset) >= 2 ** 256:
            raise BrokerError("Invalid quote market/asset identity")
        if market["version"] not in {"v1", "v2"}:
            raise BrokerError("Unknown quote market protocol version")
        book = snapshot["book"][side]
        if book["assetId"] != asset:
            raise BrokerError("Quote book asset does not match the selected outcome")
        captured = snapshot["fetchedAt"]
        if type(captured) is not int or not 0 <= captured <= now:
            raise BrokerError("Quote capture is invalid or follows evaluation")
        source = timestamp(book["sourceAt"])
        tick = decimal(book["tickSize"], maximum=D(1), positive=True)
        minimum = decimal(book["minimumShares"], positive=True)
        if tick not in TICKS:
            raise BrokerError("Unsupported SDK quote tick")
        limit = None if limit_price is None else decimal(limit_price, maximum=D(1), positive=True)
        if limit is not None and (limit >= 1 or limit % tick):
            raise BrokerError("Quote limit is outside the current tick grid")
        rate, exponent = fee_parameters(market["clobFeeSchedule"])
        with localcontext() as ctx:
            ctx.prec = 256
            bids, asks = levels(book["bids"], tick), levels(book["asks"], tick)
            bid, ask = max(bids, default=None), min(asks, default=None)
            if bid is not None and ask is not None and bid > ask:
                raise BrokerError("Crossed quote book; capture a fresh snapshot")
            reasons = []
            if market["active"] is not True or market["closed"] is not False or market["acceptingOrders"] is not True or market.get("enableOrderBook") is not True:
                reasons.append("market_not_accepting_orders")
            if market.get("expiresAt") is not None and timestamp(market["expiresAt"]) <= now:
                reasons.append("market_ended")
            if now - captured > max_age_ms or now - source > max_age_ms or source > captured:
                reasons.append("snapshot_clock_outside_age_budget")
            if wanted < minimum:
                reasons.append("below_market_minimum_shares")
            base = {"kind": "polymarket_quote", "venue": "polymarket", "network": "polygon", "marketId": market_id,
                    "assetId": asset, "side": side, "action": action, "requestedShares": shares,
                    "evaluatedAt": now, "evaluationMode": "replay" if at is not None else "current_time", "capturedAt": captured, "sourceAt": source, "maxAgeMs": max_age_ms,
                    "tickSize": text(tick), "minimumShares": text(minimum), "inventoryVerified": False,
                    "netSharesReceived": None, "feeModel": {"rate": text(rate), "exponent": exponent, "rebatesAssumed": False},
                    "note": "Snapshot research only, not an order, net inventory or guaranteed cash requirement. Fee values are unrounded curve math; venue execution/rounding and collection in cash or tokens can differ. No rebates or verified contract equivalence."}
            if reasons:
                return {**base, "status": "blocked", "reasons": reasons}
            remaining, notional, fee, count, worst = wanted, D(0), D(0), 0, None
            selected = asks if action == "buy" else bids
            for price, available in sorted(selected.items(), reverse=action == "sell"):
                if limit is not None and (price > limit if action == "buy" else price < limit):
                    continue
                take = min(remaining, available)
                notional += take * price
                fee += take * rate * (price * (1 - price)) ** exponent
                remaining -= take
                worst, count = price, count + 1
                if not remaining:
                    break
            filled = wanted - remaining
            return {**base, "status": "complete" if not remaining else "partial", "reasons": [],
                    "filledShares": text(filled), "unfilledShares": text(remaining), "notionalUSDC": text(notional),
                    "curveFeeUSDC": text(fee), "buyNotionalPlusCurveFeeUSDC": text(notional + fee) if action == "buy" else None,
                    "sellNotionalMinusCurveFeeUSDC": text(notional - fee) if action == "sell" else None,
                    "averagePrice": text(notional / filled) if filled else None, "worstPrice": text(worst) if worst is not None else None,
                    "levelsUsed": count, "limitPrice": text(limit) if limit is not None else None,
                    "bestBid": text(bid) if bid is not None else None, "bestAsk": text(ask) if ask is not None else None,
                    "midpoint": text((bid + ask) / 2) if bid is not None and ask is not None else None,
                    "spread": text(ask - bid) if bid is not None and ask is not None else None}
    except (KeyError, TypeError) as e:
        raise BrokerError("Malformed public quote snapshot (values hidden)") from e
