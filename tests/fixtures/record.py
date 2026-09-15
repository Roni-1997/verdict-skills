#!/usr/bin/env python3
"""Record the Hyperliquid info responses the tests run against. Re-run to refresh; commit the result.

  python3 tests/fixtures/record.py                    every fixture; resets the batch date (recorded_at)
  python3 tests/fixtures/record.py --only a,b,c       only the named fixtures; the rest and the batch date stay

README.json carries the batch date, the endpoints, and under "fixtures" one entry per fixture recorded with --only
or carrying a time window (candleSnapshot): its date, network and the exact request body, so a window can be replayed.
"""
import json, os, sys, time, urllib.request
def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))
T = 'https://api.hyperliquid-testnet.xyz/info'; M = 'https://api.hyperliquid.xyz/info'
NOW = int(time.time() * 1000); DAY = 86_400_000
# Public addresses taken from recentTrades output (the `users` field) on 2026-09-15; no key of theirs is known to anyone here.
T_TRADER = '0xa98361b7c825e8ee9434b433d58d6126d2ccd04e'      # testnet: fills on #104741 with cloids, no open orders
T_MAKER = '0x876fa87b4d3818f437f38f1263bee508d7672d85'       # testnet: one resting order on #104740 (oid 55896593277)
fixtures = {
    'testnet_outcomeMeta': (T, {'type': 'outcomeMeta'}),
    'testnet_outcomeTemplates': (T, {'type': 'outcomeTemplates'}),
    'testnet_l2Book_113510': (T, {'type': 'l2Book', 'coin': '#113510'}),
    'testnet_outcomeDeployerLimits_at': (T, {'type': 'outcomeDeployerLimits', 'venue': 'at'}),
    'testnet_spotClearinghouseState_subdeployer': (T, {'type': 'spotClearinghouseState', 'user': '0x2bd816e68b18d1dd6327266f273f0658f20467dc'}),
    'mainnet_outcomeMeta': (M, {'type': 'outcomeMeta'}),
    'mainnet_outcomeTemplates': (M, {'type': 'outcomeTemplates'}),
    'mainnet_l2Book_12100': (M, {'type': 'l2Book', 'coin': '#12100'}),
    'mainnet_l2Book_12101': (M, {'type': 'l2Book', 'coin': '#12101'}),
    'mainnet_maxBuilderFee_sample': (M, {'type': 'maxBuilderFee', 'user': '0x0000000000000000000000000000000000000001', 'builder': '0x0000000000000000000000000000000000000002'}),
    # Trade and order data (recent_trades, candles, fills, open_orders, order_status). #104741 is the NO coin of testnet
    # outcome 10474, the only testnet outcome coin with trades in the last 24h on 2026-09-15; #113510 has never traded.
    'testnet_recentTrades_104740': (T, {'type': 'recentTrades', 'coin': '#104740'}),
    'testnet_recentTrades_104741': (T, {'type': 'recentTrades', 'coin': '#104741'}),
    'testnet_recentTrades_113510': (T, {'type': 'recentTrades', 'coin': '#113510'}),
    'testnet_candleSnapshot_104741_1h': (T, {'type': 'candleSnapshot', 'req': {'coin': '#104741', 'interval': '1h', 'startTime': NOW - 7 * DAY, 'endTime': NOW}}),
    'testnet_candleSnapshot_113510_1h': (T, {'type': 'candleSnapshot', 'req': {'coin': '#113510', 'interval': '1h', 'startTime': NOW - 7 * DAY, 'endTime': NOW}}),
    'testnet_userFills_trader': (T, {'type': 'userFills', 'user': T_TRADER}),
    'testnet_frontendOpenOrders_maker': (T, {'type': 'frontendOpenOrders', 'user': T_MAKER}),
    'testnet_frontendOpenOrders_trader': (T, {'type': 'frontendOpenOrders', 'user': T_TRADER}),
    'testnet_openOrders_maker': (T, {'type': 'openOrders', 'user': T_MAKER}),
    'testnet_orderStatus_maker_open': (T, {'type': 'orderStatus', 'user': T_MAKER, 'oid': 55896593277}),
    'testnet_orderStatus_trader_filled': (T, {'type': 'orderStatus', 'user': T_TRADER, 'oid': 60123639947}),
    'testnet_orderStatus_maker_unknown': (T, {'type': 'orderStatus', 'user': T_MAKER, 'oid': 1}),
    'mainnet_recentTrades_12100': (M, {'type': 'recentTrades', 'coin': '#12100'}),
    'mainnet_candleSnapshot_12100_1h': (M, {'type': 'candleSnapshot', 'req': {'coin': '#12100', 'interval': '1h', 'startTime': NOW - DAY, 'endTime': NOW}}),
}
only = None
if len(sys.argv) == 3 and sys.argv[1] == '--only':
    only = sys.argv[2].split(',')
    unknown = [n for n in only if n not in fixtures]
    if unknown:
        sys.exit(f'unknown fixture(s): {", ".join(unknown)}')
elif len(sys.argv) != 1:
    sys.exit(__doc__)
here = os.path.dirname(os.path.abspath(__file__))
readme_path = os.path.join(here, 'README.json')
readme = json.load(open(readme_path)) if os.path.exists(readme_path) else {}
stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
sources = {'testnet': T, 'mainnet': M}
recorded = readme.get('fixtures', {})
for name, (url, body) in fixtures.items():
    if only is not None and name not in only:
        continue
    data = post(url, body)
    json.dump(data, open(os.path.join(here, f'{name}.json'), 'w'), indent=1)
    print(name, len(json.dumps(data)), 'bytes')
    if only is not None or body['type'] == 'candleSnapshot':
        recorded[name] = {'recorded_at': stamp, 'source': 'testnet' if url == T else 'mainnet', 'request': body}
out = {
    'recorded_at': stamp if only is None else readme.get('recorded_at', stamp),
    'sources': sources,
    'note': 'Recorded with tests/fixtures/record.py; do not edit by hand. Entries under "fixtures" were recorded with --only or carry a time window and are dated one by one.',
    'fixtures': dict(sorted(recorded.items())),
}
json.dump(out, open(readme_path, 'w'), indent=1)
