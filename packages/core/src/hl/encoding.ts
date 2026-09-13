// HIP-4 outcome asset encoding (Hyperliquid docs, "Asset IDs"; same as the Verdict app,
// src/live/live-hl.ts):
//   encoding = 10 * outcome + side      side 0 = first sideSpec, side 1 = second
//   coin     = "#" + encoding           l2Book and websocket subscriptions
//   token    = "+" + encoding           spot balances
//   assetId  = 100_000_000 + encoding   order actions
export type SideIndex = 0 | 1;

export const OUTCOME_ASSET_BASE = 100_000_000;

export function outcomeEncoding(outcome: number, side: SideIndex): number {
  if (!Number.isInteger(outcome) || outcome < 0) throw new Error(`invalid outcome index ${outcome}`);
  return 10 * outcome + side;
}

export function outcomeCoin(outcome: number, side: SideIndex): string {
  return `#${outcomeEncoding(outcome, side)}`;
}

export function outcomeTokenName(outcome: number, side: SideIndex): string {
  return `+${outcomeEncoding(outcome, side)}`;
}

export function outcomeAssetId(outcome: number, side: SideIndex): number {
  return OUTCOME_ASSET_BASE + outcomeEncoding(outcome, side);
}

/** Inverse of the token or coin encoding: "+113510" or "#113510" to { outcome: 11351, side: 0 }. */
export function decodeOutcomeToken(name: string): { outcome: number; side: SideIndex } | null {
  const m = /^[+#](\d+)$/.exec(name);
  if (!m) return null;
  const enc = Number(m[1]);
  const side = enc % 10;
  if (side !== 0 && side !== 1) return null;
  return { outcome: (enc - side) / 10, side };
}
