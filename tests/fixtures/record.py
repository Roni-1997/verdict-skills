#!/usr/bin/env python3
"""Record the Hyperliquid info responses the tests run against. Re-run to refresh; commit the result."""
import json, time, urllib.request
def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))
T = 'https://api.hyperliquid-testnet.xyz/info'; M = 'https://api.hyperliquid.xyz/info'
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
}
for name, (url, body) in fixtures.items():
    data = post(url, body)
    json.dump(data, open(f'tests/fixtures/{name}.json', 'w'), indent=1)
    print(name, len(json.dumps(data)), 'bytes')
json.dump({'recorded_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'sources': {'testnet': T, 'mainnet': M},
           'note': 'Recorded with tests/fixtures/record.py; do not edit by hand.'}, open('tests/fixtures/README.json', 'w'), indent=1)
