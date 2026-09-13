// positions: outcome-token balances for an address, read only.
import type { InfoClient } from './hl/client.js';
import { decodeOutcomeToken } from './hl/encoding.js';

export interface OutcomePosition {
  readonly outcome: number;
  readonly side: 0 | 1;
  readonly tokenName: string;
  readonly total: number;
  readonly hold: number;
}

export async function positions(client: InfoClient, user: string): Promise<OutcomePosition[]> {
  const state = await client.spotClearinghouseState(user);
  const out: OutcomePosition[] = [];
  for (const b of state.balances) {
    const decoded = decodeOutcomeToken(b.coin);
    if (!decoded) continue;
    const total = Number(b.total);
    if (!(total > 0)) continue;
    out.push({ outcome: decoded.outcome, side: decoded.side, tokenName: b.coin, total, hold: Number(b.hold) });
  }
  return out;
}
