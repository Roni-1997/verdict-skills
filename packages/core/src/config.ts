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

export function configFromEnv(env: Record<string, string | undefined> = process.env): KitConfig {
  const network = parseNetwork(env.VERDICT_NETWORK);
  const venue = env.VERDICT_VENUE && env.VERDICT_VENUE.trim() !== '' ? env.VERDICT_VENUE.trim() : null;
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

/** Hosts that may be reached over plain http: a test server on the loopback interface, nothing else. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate a hosted API base URL: https only (or http on localhost, for tests), no trailing slash, no query, no
 * fragment, no credentials in the URL. Returns the URL as written, or null when the value is unset or blank (embedded
 * mode). `name` is the setting being parsed, for the error message: the environment variable or the CLI flag.
 */
export function parseApiUrl(value: string | undefined, name = 'VERDICT_API_URL'): string | null {
  if (value === undefined) return null;
  const raw = value.trim();
  if (raw === '') return null;
  // The value is echoed so a typo is easy to spot, except when it carries credentials: those never reach a log line.
  const shown = raw.includes('@') ? '[not shown: the URL carries credentials]' : JSON.stringify(value);
  const fail = (why: string): never => {
    throw new Error(`${name} must be an https:// URL without a trailing slash, query or fragment (http:// only for localhost), e.g. https://hyperverdict.xyz/api/v1; ${why}, got ${shown}`);
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
  return raw;
}

export const BUILDER_UNSET_MESSAGE =
  'No builder code is configured. Set VERDICT_BUILDER_ADDRESS (and VERDICT_BUILDER_FEE_TENTHS_BP) so every order carries it; the kit does not build orders without one.';
