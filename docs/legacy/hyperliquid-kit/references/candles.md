# candles

Open, high, low, close, volume and trade count per bucket for one side of a market over a lookback window, oldest first, at one of Hyperliquid's candle intervals.

Read only. No account, no key, no confirmation.

| Intent | CLI | MCP tool |
|---|---|---|
| "price history of market N", "how has YES moved this week", "hourly candles for the NO side", "chart data" | `verdict candles <outcome> --side yes\|no --interval <1m\|3m\|5m\|15m\|30m\|1h\|2h\|4h\|8h\|12h\|1d\|3d\|1w\|1M> --lookback <minutes>` | `candles { "outcome": <outcome>, "side": "no", "interval": "1h", "lookbackMinutes": 10080 }` |

## Flags

| Flag | Values | Meaning |
|---|---|---|
| `<outcome>` | integer | Market index. |
| `--side` | `yes`, `no`, `0`, `1`, or a side name | Which side's coin. Required. |
| `--interval` | `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M` | Bucket size. Exactly the set Hyperliquid accepts (verified live on 2026-09-15; `2m`, `10m`, `6h` and `1y` were refused). Anything else is exit 1 before any request. |
| `--lookback` | whole number of minutes, 1 to 527040 (366 days) | The window ends now and starts this many minutes earlier. |
| `--pretty` | | Indent the JSON. |

## Output

Recorded from the testnet fixtures (outcome 10474, the NO side, `--interval 1h --lookback 10080`) on 2026-09-15; trimmed to the first and the last of 145 candles. `startTime` and `endTime` are the window the command sent, so they change on every run. Values are as recorded on 2026-09-15 and may differ on a later run; numbers appear exactly as the CLI prints them.

```json
{
  "outcome": 10474,
  "side": 1,
  "coin": "#104741",
  "interval": "1h",
  "startTime": 1788890864016,
  "endTime": 1789495664016,
  "count": 145,
  "candles": [
    { "time": 1788890400000, "closeTime": 1788893999999, "open": 0.7, "high": 0.7, "low": 0.7, "close": 0.7, "volume": 0, "trades": 0 },
    { "time": 1789408800000, "closeTime": 1789412399999, "open": 0.7, "high": 0.7, "low": 0.7, "close": 0.7, "volume": 15, "trades": 1 }
  ]
}
```

| Field | Meaning |
|---|---|
| `startTime`, `endTime` | The window sent, milliseconds since the epoch; the first candle is the bucket that contains `startTime`. |
| `count` | Candles returned. Hyperliquid answers with about the most recent 5,000 candles of a window at most (5,083 came back for 8,640 one-minute buckets on 2026-09-15), so a long window at a short interval is cut at the old end, never padded. |
| `time`, `closeTime` | Bucket open and close, milliseconds since the epoch. |
| `open`, `high`, `low`, `close` | Quote units (USDC) per token. A bucket with no trade repeats the last close in all four. |
| `volume` | Tokens traded in the bucket. |
| `trades` | Prints in the bucket. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input",...}` | Missing `--side`, `--interval` or `--lookback`; an interval outside the set above; a lookback that is not a whole number of minutes from 1 to 527040; an unknown side. | Fix the flags from the table above. |
| 2 | `{"error":"not_found",...}` | No such market on this network; or the side has no candles: Hyperliquid keeps candles for an outcome coin from its first trade on and answers an empty list for a coin that has never traded (or a window before its first trade). The message says which. | For a market that exists, say the side has not traded; do not retry with a longer window hoping for data that is not there. |
| 3 | `{"error":"upstream",...}` | The candleSnapshot fetch failed (HTTP 422 is the venue refusing the request), drifted, or answered about another coin or interval. | Retry once, then report the JSON. |

## Notes

- Candles exist for outcome coins on both networks once the coin has traded: verified on 2026-09-15 with testnet `#104741` (145 hourly candles over 7 days) and mainnet `#12100` (24 hourly candles over 1 day); testnet `#113510`, which never traded, answered an empty list. The command reports that as exit 2 with the reason, never as an empty chart.
- The YES and NO coins mirror each other (a YES print at p is a NO print at 1 - p), so the NO candles are 1 minus the YES candles with high and low swapped. Read one side.
- Candles are history; for the executable price now use `quote`, for the book use `book`.
