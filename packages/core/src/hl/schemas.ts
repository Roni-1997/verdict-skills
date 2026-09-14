// Zod schemas for every Hyperliquid info response the kit reads. Upstream drift becomes a
// typed error here, never a wrong number downstream. Shapes verified against recorded
// fixtures from testnet and mainnet on 2026-09-13 (tests/fixtures).
import { z } from 'zod';

export const HexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte hex address');

const DecimalString = z.string().regex(/^\d+(\.\d+)?$/, 'expected a nonnegative decimal string');

export const SideSpec = z.object({ name: z.string() }).passthrough();

export const OutcomeMetaOutcome = z
  .object({
    outcome: z.number().int().nonnegative(),
    name: z.string(),
    description: z.string().default(''),
    sideSpecs: z.array(SideSpec).length(2),
    quoteToken: z.string(),
    /** Absent on Hyperliquid's own (non-deployer) outcomes; a venue name on deployer markets. */
    venue: z.string().nullable().optional(),
    deployerFeeScale: DecimalString.optional(),
  })
  .passthrough();

export const OutcomeMetaDeployer = z
  .object({
    deployer: HexAddress,
    venue: z.string(),
    subDeployers: z.array(z.tuple([z.string(), z.array(HexAddress)])).optional(),
  })
  .passthrough()
  .nullable();

/** A multi-outcome question: named children plus an optional fallback ("none of the above") outcome. */
export const OutcomeMetaQuestion = z
  .object({
    question: z.number().int().nonnegative(),
    name: z.string(),
    description: z.string().default(''),
    namedOutcomes: z.array(z.number().int().nonnegative()),
    fallbackOutcome: z.number().int().nonnegative().nullable().optional(),
    settledNamedOutcomes: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const OutcomeMeta = z
  .object({
    outcomes: z.array(OutcomeMetaOutcome),
    questions: z.array(OutcomeMetaQuestion),
    deployers: z.array(OutcomeMetaDeployer),
    feeScale: z.unknown().optional(),
  })
  .passthrough();
export type OutcomeMeta = z.infer<typeof OutcomeMeta>;
export type OutcomeMetaOutcome = z.infer<typeof OutcomeMetaOutcome>;
export type OutcomeMetaQuestion = z.infer<typeof OutcomeMetaQuestion>;

export const OutcomeTemplate = z
  .object({
    id: z.string(),
    role: z.unknown(),
    name: z.string(),
    description: z.string(),
    keywords: z.array(z.tuple([z.string(), z.string()])).nullable(),
  })
  .passthrough();
export const OutcomeTemplates = z.array(OutcomeTemplate);
export type OutcomeTemplate = z.infer<typeof OutcomeTemplate>;

export const L2Level = z.object({ px: DecimalString, sz: DecimalString, n: z.number().int().nonnegative() });
export const L2Book = z.object({
  coin: z.string(),
  time: z.number(),
  levels: z.tuple([z.array(L2Level), z.array(L2Level)]),
});
export type L2Book = z.infer<typeof L2Book>;
export type L2Level = z.infer<typeof L2Level>;

/** `maxBuilderFee` returns the approved maximum in tenths of a basis point (1 = 0.001%). */
export const MaxBuilderFee = z.number().int().nonnegative();

export const SpotBalance = z
  .object({
    coin: z.string(),
    /** Absent on some outcome-token balances (seen as `o<id>` coins on testnet). */
    token: z.number().int().nonnegative().optional(),
    hold: DecimalString,
    total: DecimalString,
    entryNtl: DecimalString.optional(),
  })
  .passthrough();
export const SpotClearinghouseState = z.object({ balances: z.array(SpotBalance) }).passthrough();
export type SpotClearinghouseState = z.infer<typeof SpotClearinghouseState>;

/**
 * `spotMetaAndAssetCtxs` returns `[spotMeta, ctxs]`. Outcome coins appear in ctxs as `#<encoding>`;
 * `markPx` is Hyperliquid's robust fair value once the coin has traded today, `midPx` the raw
 * book midpoint (null on an empty book), `dayNtlVlm` the 24h notional volume.
 */
export const SpotAssetCtx = z
  .object({
    coin: z.string(),
    dayNtlVlm: DecimalString,
    markPx: DecimalString.optional(),
    midPx: DecimalString.nullable().optional(),
    prevDayPx: DecimalString.optional(),
  })
  .passthrough();
export const SpotMetaAndAssetCtxs = z.tuple([z.object({ universe: z.array(z.unknown()), tokens: z.array(z.unknown()) }).passthrough(), z.array(SpotAssetCtx)]);
export type SpotAssetCtx = z.infer<typeof SpotAssetCtx>;
export type SpotMetaAndAssetCtxs = z.infer<typeof SpotMetaAndAssetCtxs>;

/** `allMids`: coin name to mid price for every perp and spot coin, including outcome coins. */
export const AllMids = z.record(z.string(), DecimalString);
export type AllMids = z.infer<typeof AllMids>;
