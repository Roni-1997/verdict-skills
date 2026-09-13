// Runtime configuration shared by the CLI and the MCP server. Read from the environment; testnet by default.
import { parseNetwork, type Network } from './network.js';
import type { BuilderCode } from './builder.js';

export interface KitConfig {
  readonly network: Network;
  /** Venue name of the Verdict deployer whose markets the kit lists by default; null lists every deployer. */
  readonly venue: string | null;
  /** Builder code attached to every order the kit builds; null until VERDICT_BUILDER_ADDRESS is set. */
  readonly builder: BuilderCode | null;
}

const ZERO = /^0x0{40}$/;

export function configFromEnv(env: Record<string, string | undefined> = process.env): KitConfig {
  const network = parseNetwork(env.VERDICT_NETWORK);
  const venue = env.VERDICT_VENUE && env.VERDICT_VENUE.trim() !== '' ? env.VERDICT_VENUE.trim() : null;
  const address = env.VERDICT_BUILDER_ADDRESS?.trim();
  let builder: BuilderCode | null = null;
  if (address && /^0x[0-9a-fA-F]{40}$/.test(address) && !ZERO.test(address)) {
    const feeRaw = env.VERDICT_BUILDER_FEE_TENTHS_BP?.trim() ?? '10';
    const fee = Number(feeRaw);
    if (!Number.isInteger(fee) || fee < 0 || fee > 10_000) {
      throw new Error(`VERDICT_BUILDER_FEE_TENTHS_BP must be an integer between 0 and 10000, got ${JSON.stringify(feeRaw)}`);
    }
    builder = { address: address.toLowerCase() as `0x${string}`, feeTenthsBp: fee };
  }
  return { network, venue, builder };
}

export const BUILDER_UNSET_MESSAGE =
  'No builder code is configured. Set VERDICT_BUILDER_ADDRESS (and VERDICT_BUILDER_FEE_TENTHS_BP) so every order carries it; the kit does not build orders without one.';
