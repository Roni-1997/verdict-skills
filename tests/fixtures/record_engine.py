#!/usr/bin/env python3
"""Record the fixtures the engine tests run against: Hyperliquid mainnet catalog, books and asset
contexts for a handful of deployer markets, and the venue payloads the engine fetches for them
(Polymarket gamma, Kalshi, Deribit). Venue payloads are trimmed by rule (not by hand) to the rows
relevant to the recorded markets so the repository stays small; README.json records when and
how. Re-run to refresh; tests freeze the clock at recorded_at so the recorded expiries stay live."""
import datetime as dt, json, re, time, urllib.request

HL = 'https://api.hyperliquid.xyz/info'
OUT = 'tests/fixtures/engine'
UA = {'Accept': 'application/json', 'User-Agent': 'verdict-skills-fixtures/0.1'}

# Deployer markets the offline tests exercise: venue out BTC/HYPE price markets with real two-sided
# books (1209-1217, 1251), the skew BTC daily whose strike the Kalshi Sep 18 ladder brackets (2899),
# and one multi-outcome question (Premier League winner: fallback 1472 plus Arsenal 1473).
OUTCOMES = [1209, 1210, 1211, 1212, 1213, 1214, 1215, 1216, 1217, 1251, 2899, 1472, 1473]
DAILY_STRIKE = 77250          # outcome 2899, BTC above 77250 at 2026-09-18 06:00 UTC
DAILY_KALSHI_EVENT = 'KXBTCD-26SEP1817'

def post(body):
    req = urllib.request.Request(HL, data=json.dumps(body).encode(), headers={'content-type': 'application/json', **UA})
    return json.load(urllib.request.urlopen(req, timeout=60))

def get(url):
    req = urllib.request.Request(url, headers=UA)
    return json.load(urllib.request.urlopen(req, timeout=60))

def save(name, data):
    with open(f'{OUT}/{name}.json', 'w') as f:
        json.dump(data, f, indent=1)
    print(name, len(json.dumps(data)), 'bytes')

def strip_keys(obj, keys):
    if isinstance(obj, dict):
        return {k: strip_keys(v, keys) for k, v in obj.items() if k not in keys}
    if isinstance(obj, list):
        return [strip_keys(x, keys) for x in obj]
    return obj

recorded_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

# Hyperliquid
meta = post({'type': 'outcomeMeta'})
save('hl_outcomeMeta', meta)
save('hl_outcomeTemplates', post({'type': 'outcomeTemplates'}))
books = {}
for o in OUTCOMES:
    for side in (0, 1):
        coin = f'#{10 * o + side}'
        books[coin] = post({'type': 'l2Book', 'coin': coin})
save('hl_l2Books', books)
smac = post({'type': 'spotMetaAndAssetCtxs'})
save('hl_spotMetaAndAssetCtxs', [{'universe': [], 'tokens': []}, [c for c in smac[1] if str(c.get('coin', '')).startswith('#')]])
save('hl_allMids', post({'type': 'allMids'}))

# Polymarket gamma: the crypto tag the engine pins for the 'crypto' search term. Keep BTC-titled
# events, at most six markets each, without image URLs.
events = get('https://gamma-api.polymarket.com/events?limit=200&active=true&closed=false&tag_id=21')
btc_events = [dict(e, markets=(e.get('markets') or [])[:6]) for e in events if re.search(r'bitcoin|btc', e.get('title') or '', re.I)]
save('polymarket_events_crypto', strip_keys(btc_events, {'image', 'icon', 'clobRewards', 'umaResolutionStatuses'}))

# Kalshi: the BTC daily event that settles the same day as outcome 2899, rungs within $5k of its
# strike; and the matching price-range event (direction 'range', which the engine must reject).
def kalshi_events(series):
    return get(f'https://external-api.kalshi.com/trade-api/v2/events?limit=100&status=open&with_nested_markets=true&series_ticker={series}').get('events') or []
daily = [e for e in kalshi_events('KXBTCD') if e.get('event_ticker') == DAILY_KALSHI_EVENT]
for e in daily:
    e['markets'] = [m for m in e.get('markets') or [] if abs(float(m.get('floor_strike') or m.get('cap_strike') or 0) - DAILY_STRIKE) <= 5000]
save('kalshi_events_KXBTCD', {'events': daily})
ranges = [e for e in kalshi_events('KXBTC') if e.get('event_ticker') == DAILY_KALSHI_EVENT.replace('KXBTCD', 'KXBTC')]
for e in ranges:
    e['markets'] = (e.get('markets') or [])[:8]
save('kalshi_events_KXBTC', {'events': ranges})

# Deribit: BTC option book summaries, calls only, expiries within 21 days of the recording.
deribit = get('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option')
MONTHS = {m: i for i, m in enumerate(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], 1)}
def expiry_of(name):
    m = re.match(r'^BTC-(\d{1,2})([A-Z]{3})(\d{2})-', name)
    return dt.datetime(2000 + int(m.group(3)), MONTHS[m.group(2)], int(m.group(1)), 8, tzinfo=dt.timezone.utc) if m else None
now = dt.datetime.now(dt.timezone.utc)
rows = [r for r in deribit.get('result') or [] if r.get('instrument_name', '').endswith('-C') and expiry_of(r['instrument_name']) and 0 < (expiry_of(r['instrument_name']) - now).days <= 21]
save('deribit_btc_options', {'jsonrpc': '2.0', 'result': rows})

save('README', {
    'recorded_at': recorded_at,
    'note': 'Recorded with tests/fixtures/record_engine.py; do not edit by hand. Tests freeze Date to recorded_at.',
    'hyperliquid': HL,
    'outcomes': OUTCOMES,
    'trimming': {
        'hl_spotMetaAndAssetCtxs': 'universe/tokens emptied; ctxs kept for outcome coins (#...) only',
        'polymarket_events_crypto': 'gamma /events?tag_id=21, events with bitcoin|btc in the title, first 6 markets each, image fields dropped',
        'kalshi_events_KXBTCD': f'/events?series_ticker=KXBTCD, event {DAILY_KALSHI_EVENT}, rungs within $5,000 of {DAILY_STRIKE}',
        'kalshi_events_KXBTC': 'the matching price-range event, first 8 markets',
        'deribit_btc_options': 'get_book_summary_by_currency BTC options, calls only, expiries within 21 days',
    },
    'routing': 'tests/helpers/fixture-fetch.ts maps every request the engine makes to one of these files or to an empty result (free-text search endpoints, whose live results were unrelated to the recorded markets).',
})
