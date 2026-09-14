// Runtime configuration shared by the CLI and the MCP server. Read from the environment; testnet by default.
import { parseNetwork, type Network } from './network.js';
import type { BuilderCode } from './builder.js';

export interface KitConfig {
  readonly network: Network;
  /** Venue name of the Verdict deployer whose markets the kit lists by default; null lists every deployer. */
  readonly venue: string | null;
  /** Builder code attached to every order the kit builds; null until VERDICT_BUILDER_ADDRESS is set. */
  readonly builder: BuilderCode | null;
  /**
   * Base URL of the hosted Verdict API (VERDICT_API_URL, e.g. https://hyperverdict.xyz/api/v1). When set, list_markets,
   * get_market, compare_market, fair_value, find_hedges and opportunities are answered by the API (remote.ts); null,
   * the default, runs the embedded engine. The other tools run locally either way.
   */
  readonly apiUrl: string | null;
}

const ZERO = /^0x0{40}$/;

/** The venue name rule the API applies to its `venue` parameter (VenueParam in the app): 1 to 32 letters, digits, _ or -. */
export const VENUE_NAME = /^[A-Za-z0-9_-]{1,32}$/;
/** The API's own words for a name outside VENUE_NAME, reused by the kit so both modes refuse it identically. */
export const VENUE_MESSAGE = 'venue must be 1 to 32 letters, digits, _ or -';

/**
 * The venue a value names, read the way the API reads its `venue` parameter: unset, blank and `all` (in any case)
 * mean every deployer and come back as null; anything else is the trimmed venue name, unchecked. Shared by
 * configFromEnv (VERDICT_VENUE) and the tools (`venue` inputs, checkVenue in tools.ts), so the embedded engine and
 * the hosted API give one value one meaning.
 */
export function normalizeVenue(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const v = value.trim();
  if (v === '' || v.toLowerCase() === 'all') return null;
  return v;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): KitConfig {
  const network = parseNetwork(env.VERDICT_NETWORK);
  const venue = normalizeVenue(env.VERDICT_VENUE);
  // The value is not repeated: the message reaches stderr and hosted deployment logs, and a token pasted into the
  // wrong variable is exactly what a malformed venue name looks like.
  if (venue !== null && !VENUE_NAME.test(venue)) throw new Error(`VERDICT_VENUE ${VENUE_MESSAGE}, got ${HIDDEN}`);
  const address = env.VERDICT_BUILDER_ADDRESS?.trim();
  // The fee is validated whenever it is set, not only once an address is configured, so a bad value is
  // reported the moment an operator writes it rather than later when the address arrives.
  const feeRaw = env.VERDICT_BUILDER_FEE_TENTHS_BP?.trim() ?? '10';
  const fee = Number(feeRaw);
  if (!/^\d+$/.test(feeRaw) || !Number.isInteger(fee) || fee < 0 || fee > 10_000) {
    throw new Error(`VERDICT_BUILDER_FEE_TENTHS_BP must be an integer between 0 and 10000, got ${JSON.stringify(feeRaw)}`);
  }
  let builder: BuilderCode | null = null;
  if (address && /^0x[0-9a-fA-F]{40}$/.test(address) && !ZERO.test(address)) {
    builder = { address: address.toLowerCase() as `0x${string}`, feeTenthsBp: fee };
  }
  const apiUrl = parseApiUrl(env.VERDICT_API_URL);
  return { network, venue, builder, apiUrl };
}

/** Hosts that may be reached over plain http: a test server on the loopback interface (localhost, 127.0.0.1, [::1]), nothing else. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Stands in for a rejected setting value in every configuration error message; no part of the value is ever repeated. */
export const HIDDEN = '[value hidden]';

/**
 * Validate a hosted API base URL: https only (or http on the loopback interface, for tests), written in its normal
 * form (lowercase scheme and host, no default port, no `.` or `..` segments, no backslash, no percent-encoding), with
 * no trailing slash, no query, no fragment and no credentials. Returns the URL as written, or null when the value is
 * unset or blank (embedded mode). `name` is the setting being parsed, for the error message: the environment variable
 * or the CLI flag.
 *
 * The error message reaches stderr and hosted deployment logs, so it names the setting and the rule that failed and
 * repeats no part of the value: not the path (where a URL of another service keeps a token), not the userinfo, query
 * or fragment, not the host, and not the scheme either, since a KEY:SECRET paste parses as a URL whose scheme is the
 * key. The value is shown as HIDDEN whatever the rule that refused it.
 */
export function parseApiUrl(value: string | undefined, name = 'VERDICT_API_URL'): string | null {
  if (value === undefined) return null;
  const raw = value.trim();
  if (raw === '') return null;
  const fail = (why: string): never => {
    throw new Error(`${name} must be an https:// URL without a trailing slash, query or fragment (http:// only on localhost, 127.0.0.1 or [::1]), e.g. https://hyperverdict.xyz/api/v1; ${why}, got ${HIDDEN}`);
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('not a URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return fail('scheme not allowed');
  if (url.username !== '' || url.password !== '') return fail('credentials in the URL');
  if (url.search !== '' || raw.includes('?')) return fail('query string');
  if (url.hash !== '' || raw.includes('#')) return fail('fragment');
  if (raw.endsWith('/')) return fail('trailing slash');
  if (/\s/.test(raw)) return fail('whitespace');
  if (url.pathname.includes('%')) return fail('percent-encoding in the path');
  // The URL parser lowercases the scheme and host, drops a default port, resolves . and .. segments and turns a
  // backslash into a slash; a value that differs from that normal form is refused rather than silently requested
  // as something else.
  const normal = url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`;
  if (raw !== normal) return fail('not in normal form (lowercase scheme and host, no default port, no . or .. segments, no backslash)');
  return raw;
}

export const BUILDER_UNSET_MESSAGE =
  'No builder code is configured. Set VERDICT_BUILDER_ADDRESS (and VERDICT_BUILDER_FEE_TENTHS_BP) so every order carries it; the kit does not build orders without one.';
