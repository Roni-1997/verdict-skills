// The compact market view every tool result embeds.
import { z } from 'zod';
import type { Market } from './markets.js';

export const MarketSummary = z.object({
  outcome: z.number().int().nonnegative(),
  venue: z.string(),
  displayName: z.string(),
  templateId: z.string().nullable(),
  underlying: z.string().nullable(),
  threshold: z.string().nullable(),
  expiresAt: z.string().nullable(),
  settlementRule: z.string().nullable(),
  sides: z.array(z.object({ index: z.union([z.literal(0), z.literal(1)]), name: z.string(), coin: z.string(), assetId: z.number().int() })),
  deployerFeeScale: z.string().nullable(),
});
export type MarketSummary = z.infer<typeof MarketSummary>;

export function summarize(m: Market): MarketSummary {
  return {
    outcome: m.outcome,
    venue: m.venue,
    displayName: m.displayName,
    templateId: m.templateId,
    underlying: m.underlying,
    threshold: m.threshold,
    expiresAt: m.expiresAt,
    settlementRule: m.settlementRule,
    sides: m.sides.map((s) => ({ index: s.index, name: s.name, coin: s.coin, assetId: s.assetId })),
    deployerFeeScale: m.deployerFeeScale,
  };
}
