// list_markets and get_market: the live catalogue for one venue with the settlement rule text
// substituted from the template each market was deployed from.
import type { InfoClient } from './hl/client.js';
import { outcomeAssetId, outcomeCoin, outcomeTokenName } from './hl/encoding.js';
import type { OutcomeMeta, OutcomeMetaOutcome, OutcomeTemplate } from './hl/schemas.js';

export interface MarketSide {
  readonly index: 0 | 1;
  readonly name: string;
  readonly coin: string;
  readonly tokenName: string;
  readonly assetId: number;
}

export interface Market {
  readonly outcome: number;
  readonly venue: string;
  readonly name: string;
  /** Template id when the market was deployed from a template, otherwise null. */
  readonly templateId: string | null;
  /** Raw onchain description, `keyword:value|keyword:value`. */
  readonly description: string;
  readonly keywords: Readonly<Record<string, string>>;
  readonly sides: readonly [MarketSide, MarketSide];
  readonly quoteToken: string;
  readonly deployerFeeScale: string | null;
  /** Human-readable display name with the keyword values substituted, or the raw name. */
  readonly displayName: string;
  /** The template's settlement text with the keyword values substituted; null when unknown. */
  readonly settlementRule: string | null;
  /** The template's semantic restriction, when the template carries one. */
  readonly semanticRestriction: string | null;
  /** Expiry parsed from a `time` or `expiry` keyword (`%Y%m%d-%H%M` UTC), ISO 8601, or null. */
  readonly expiresAt: string | null;
  /** `perp` keyword when present, e.g. BTC or xyz:GOLD. */
  readonly underlying: string | null;
  /** `threshold` keyword when present. */
  readonly threshold: string | null;
  readonly priceDescription: string | null;
  readonly twapSeconds: number | null;
}

export function parseDescription(desc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of desc.split('|')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function parseHlDateTime(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Replace `{keyword}` placeholders with the values a market was deployed with; unknown keywords stay verbatim. */
export function substituteKeywords(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** Split a template description into the rule text and its `metadata=...` tail. */
export function splitTemplateDescription(description: string): { rule: string; metadata: Record<string, string> } {
  const idx = description.indexOf('metadata=');
  if (idx < 0) return { rule: description.trim(), metadata: {} };
  const rule = description.slice(0, idx).trim();
  const metadata = parseDescription(description.slice(idx + 'metadata='.length));
  return { rule, metadata };
}

export function templateIdOf(name: string): string | null {
  return name.startsWith('template:') ? name.slice('template:'.length) : null;
}

export function buildMarket(o: OutcomeMetaOutcome, templates: ReadonlyMap<string, OutcomeTemplate>): Market {
  const templateId = templateIdOf(o.name);
  const keywords = parseDescription(o.description);
  const template = templateId ? templates.get(templateId) : undefined;
  let settlementRule: string | null = null;
  let semanticRestriction: string | null = null;
  let displayName = o.name;
  if (template) {
    const { rule, metadata } = splitTemplateDescription(template.description);
    settlementRule = substituteKeywords(rule, keywords);
    semanticRestriction = metadata.semanticRestriction ?? null;
    displayName = substituteKeywords(template.name, keywords);
  }
  const sides = [0, 1].map((i) => {
    const side = i as 0 | 1;
    const spec = o.sideSpecs[side];
    return {
      index: side,
      name: spec?.name ?? (side === 0 ? 'Yes' : 'No'),
      coin: outcomeCoin(o.outcome, side),
      tokenName: outcomeTokenName(o.outcome, side),
      assetId: outcomeAssetId(o.outcome, side),
    };
  }) as [MarketSide, MarketSide];
  const seconds = keywords.seconds !== undefined ? Number(keywords.seconds) : NaN;
  return {
    outcome: o.outcome,
    venue: o.venue ?? '',
    name: o.name,
    templateId,
    description: o.description,
    keywords,
    sides,
    quoteToken: o.quoteToken,
    deployerFeeScale: o.deployerFeeScale ?? null,
    displayName,
    settlementRule,
    semanticRestriction,
    expiresAt: parseHlDateTime(keywords.time ?? keywords.expiry),
    underlying: keywords.perp ?? keywords.underlying ?? null,
    threshold: keywords.threshold ?? keywords.target ?? null,
    priceDescription: keywords.priceDescription ?? null,
    twapSeconds: Number.isInteger(seconds) ? seconds : null,
  };
}

export interface ListMarketsOptions {
  readonly venue?: string;
  /** Drop the `template fallback` container outcomes of questions. Default true. */
  readonly excludeFallbacks?: boolean;
}

/** The two info responses every market view is built from, fetched once and shared. */
export interface Catalog {
  readonly meta: OutcomeMeta;
  readonly templates: ReadonlyMap<string, OutcomeTemplate>;
}

export async function loadCatalog(client: InfoClient): Promise<Catalog> {
  const [meta, templates] = await Promise.all([client.outcomeMeta(), client.outcomeTemplates()]);
  return { meta, templates: new Map(templates.map((t) => [t.id, t] as const)) };
}

export function marketsFromCatalog(catalog: Catalog, opts: ListMarketsOptions = {}): Market[] {
  const excludeFallbacks = opts.excludeFallbacks ?? true;
  return catalog.meta.outcomes
    .filter((o) => (opts.venue ? o.venue === opts.venue : true))
    .filter((o) => (excludeFallbacks ? o.name !== 'template fallback' : true))
    .map((o) => buildMarket(o, catalog.templates));
}

export function marketFromCatalog(catalog: Catalog, outcome: number): Market | null {
  const o = catalog.meta.outcomes.find((x) => x.outcome === outcome);
  return o ? buildMarket(o, catalog.templates) : null;
}

export async function listMarkets(client: InfoClient, opts: ListMarketsOptions = {}): Promise<Market[]> {
  return marketsFromCatalog(await loadCatalog(client), opts);
}

export async function getMarket(client: InfoClient, outcome: number): Promise<Market | null> {
  return marketFromCatalog(await loadCatalog(client), outcome);
}
