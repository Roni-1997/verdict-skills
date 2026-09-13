# build-order

An unsigned Hyperliquid order action for one Verdict market, carrying `builder: { b, f }`, plus the settlement rule, notional, maximum loss, payout if right and the builder fee in cents per $1,000. The command signs nothing and submits nothing.

Signable. The two-message rule applies. The analysis-to-trade boundary, stated identically in SKILL.md: Pre-trade read-only checks (`builder-status`, `quote`) may run in the trade turn before `build-order`; a turn whose purpose is analysis never runs `build-order`; signing never happens in the turn that produced the payload.

| Intent | CLI | MCP tool |
|---|---|---|
| "buy 250 YES on 1210 at 0.018", "sell my NO at 0.97", "place an order on Verdict", "bid 0.62 for 100 YES" | `verdict build-order <outcome> --side yes\|no --action buy\|sell --price <0..1> --size <tokens> [--tif Gtc\|Ioc\|Alo] [--cloid 0x<32 hex>]` | `build_order { "outcome": 1210, "side": "yes", "action": "buy", "price": "0.018", "size": "250" }` |

## Flags

| Flag | Values | Meaning |
|---|---|---|
| `<outcome>` | integer | Market index from `verdict markets`. |
| `--side` | `yes`, `no`, `0`, `1`, or a side name | The side being bought or sold. |
| `--action` | `buy`, `sell` | Buying pays `price` per token now and receives 1 USDC per token if right. Selling receives `price` per token now and owes nothing if right. |
| `--price` | decimal string strictly between 0 and 1, at most 5 decimals | Limit price per token, for example `0.618`. Tick is 0.00001. |
| `--size` | whole number as a string | Tokens, for example `250`. No fractions. |
| `--tif` | `Gtc` (default), `Ioc`, `Alo` | Good till cancelled rests on the book; immediate or cancel fills what crosses and cancels the rest; add liquidity only is rejected if it would cross. |
| `--cloid` | `0x` + 32 hex characters | Optional client order id, 16 bytes. |
| `--pretty` | | Indent the JSON. |

Price and size are strings on purpose: they enter the signed payload verbatim, trailing zeros removed (`0.0180` becomes `0.018`).

## Output

Recorded on 2026-09-13 from the mainnet fixtures with builder `0x...b1` at 10 tenths of a basis point.

```json
{
  "action": {
    "type": "order",
    "orders": [ { "a": 100012100, "b": true, "p": "0.018", "s": "250", "r": false, "t": { "limit": { "tif": "Gtc" } } } ],
    "grouping": "na",
    "builder": { "b": "0x00000000000000000000000000000000000000b1", "f": 10 }
  },
  "market": {
    "outcome": 1210,
    "venue": "out",
    "displayName": "BTC above 100000 at 20261001-0000?",
    "settlementRule": "The market resolves to Yes if the BTC price is above 100000 at 20261001-0000, and otherwise resolves to No. Settlement is according to the 1-second TWAP of BTC-USDC mark price ending at 20261001-0000. If BTC is delisted before this market settles, settlement is instead according to the BTC settlement price at delisting.",
    "expiresAt": "2026-10-01T00:00:00.000Z"
  },
  "side": { "index": 0, "name": "template:Yes", "coin": "#12100", "assetId": 100012100 },
  "summary": {
    "action": "buy",
    "price": "0.018",
    "size": "250",
    "notional": 4.5,
    "maxLossIfWrong": 4.5,
    "payoutIfRight": 250,
    "builderFeeCentsPer1000": 10,
    "builderFeeEstimate": 0.00045
  },
  "confirmation": [
    "BUY 250 template:Yes on BTC above 100000 at 20261001-0000? at 0.018",
    "Settles: The market resolves to Yes if the BTC price is above 100000 at 20261001-0000, and otherwise resolves to No. ...",
    "Notional 4.50 USDC; builder fee 10 cents per $1,000 to 0x00000000000000000000000000000000000000b1",
    "This payload is unsigned. Sign it with your own key and submit it yourself. Confirm before signing."
  ]
}
```

| Field | Meaning |
|---|---|
| `action` | The order action exactly as Hyperliquid hashes it. Key order matters (msgpack encodes keys in insertion order): `type, orders, grouping, builder`, and inside each order `a, b, p, s, r, t[, c]`. Do not edit it. |
| `action.orders[0].a` | Asset id of the side: `100000000 + 10 * outcome + side`. |
| `action.orders[0].b` | `true` for buy, `false` for sell. |
| `action.builder` | Verdict's builder code: address `b` and fee `f` in tenths of a basis point. Present on every order the kit builds. |
| `summary.notional` | `price * size` in USDC. |
| `summary.maxLossIfWrong` | Buy: the notional. Sell: `(1 - price) * size`, what the seller pays out if the side wins. |
| `summary.payoutIfRight` | Buy: `size` USDC. Sell: the notional received. |
| `summary.builderFeeCentsPer1000` | The builder fee, cents per $1,000 of notional. Equal to `f`. |
| `summary.builderFeeEstimate` | `notional * f / 100000` in USDC for this order. |
| `confirmation` | Lines for the user. Show them in full. |

## Confirmation flow

Message 1, this turn (the turn in which the user asked to trade, not the turn that presented analysis):

1. Pre-trade read-only checks, allowed in this turn by the boundary sentence above: `verdict builder-status <address>` must show `approved: true` (otherwise the approval flow comes first, with its own two messages); `verdict quote` for the same side and size shows the executable price next to the limit price.
2. Run `verdict build-order ...` with every flag filled in.
3. Present:

| Field | Value from the output |
|---|---|
| Market | `market.displayName`, outcome `market.outcome`, venue `market.venue`, network |
| Settlement rule | `market.settlementRule`, verbatim and complete |
| Expires | `market.expiresAt` |
| Side | `side.name` (index `side.index`) |
| Action | BUY or SELL |
| Price | `summary.price` per token |
| Size | `summary.size` tokens |
| Notional | `summary.notional` USDC |
| Maximum loss | `summary.maxLossIfWrong` USDC |
| Payout if right | `summary.payoutIfRight` USDC |
| Builder fee | `summary.builderFeeCentsPer1000` cents per $1,000 (about `summary.builderFeeEstimate` USDC on this order) |
| Builder address | `action.builder.b`, complete |
| Time in force | `action.orders[0].t.limit.tif` |
| Payload | unsigned; the user's own signer signs it with the user's agent key on the user's machine and submits it to `/exchange` on this network; the kit does neither and neither do you |

4. Ask: "Sign and submit this order? Confirm or abort." Ask in plain text and end your message there. Do not ask through a blocking question tool (Claude Code's AskUserQuestion or an equivalent): its answer comes back as a tool result inside the same turn, and a tool result is not a reply. Only the user's next message counts: Confirm means proceed; Abort, no reply, or anything unclear means stop.
5. End the message. No signing, no `/exchange` call, no other command after the question.

Message 2, only after the user replies in a new message:

- Abort: acknowledge and stop. Nothing is signed. Do not ask again or offer to reconsider; a later "do it anyway" is a new request from Message 1, not a confirmation.
- Confirm: Do not write ad-hoc signing code and do not install packages at trade time. Hand the unchanged action to the user's own signer or wallet and stop. `sign-and-submit.md` describes what that component does with `action`. When the user reports the `/exchange` response, show its `statuses` (resting order id, fill, or error) as JSON.
- Any other reply is not a confirmation.
- A changed price, size, side, market or time in force voids the confirmation. Run `build-order` again and present again.
- Intent in earlier messages ("I want to buy YES") is not a confirmation. Ask on every order.

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input",...}` | Price not strictly between 0 and 1 or more than 5 decimals; fractional or nonpositive size; missing flag; `--tif` not Gtc, Ioc or Alo; unknown side. | Fix the flags from the table. Do not guess a different market. |
| 2 | `{"error":"not_found",...}` | No such market on this network. | Run `verdict markets`; check `VERDICT_NETWORK`. |
| 3 | `{"error":"upstream",...}` | Market lookup failed. | Retry once, then report the JSON. |
| 4 | `{"error":"not_configured",...}` | No builder code configured. The kit does not build orders without one. | Do not retry. Tell the user to set `VERDICT_BUILDER_ADDRESS`. |

## Notes

- Every order the kit builds carries the builder code. There is no flag to drop it and it must not be edited out.
- Buys are funded from spot USDC; sells need the tokens (`verdict positions`). Hyperliquid rejects otherwise, after signing.
- Orders route only to Verdict markets on Hyperliquid. The kit never builds an order for Polymarket, Kalshi or Deribit.
- Mainnet only when the user set `VERDICT_NETWORK=mainnet`. Never change the network yourself.
- Never write the signed payload or the key to a file, a commit or a chat.
