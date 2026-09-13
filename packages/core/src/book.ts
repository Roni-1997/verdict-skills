// orderbook and quote: the YES and NO books for a market, and the executable price for a size.
import type { InfoClient } from './hl/client.js';
import type { L2Book, L2Level } from './hl/schemas.js';
import type { Market } from './markets.js';

export interface BookLevel {
  readonly px: number;
  readonly sz: number;
  readonly orders: number;
}

export interface SideBook {
  readonly coin: string;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly mid: number | null;
  readonly time: number;
}

export interface Orderbook {
  readonly outcome: number;
  readonly sides: readonly [SideBook, SideBook];
}

function toLevels(levels: readonly L2Level[]): BookLevel[] {
  return levels.map((l) => ({ px: Number(l.px), sz: Number(l.sz), orders: l.n }));
}

export function sideBookFrom(raw: L2Book): SideBook {
  const bids = toLevels(raw.levels[0]);
  const asks = toLevels(raw.levels[1]);
  const bestBid = bids[0]?.px ?? null;
  const bestAsk = asks[0]?.px ?? null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  return { coin: raw.coin, bids, asks, bestBid, bestAsk, mid, time: raw.time };
}

export async function orderbook(client: InfoClient, market: Market): Promise<Orderbook> {
  const [a, b] = await Promise.all([client.l2Book(market.sides[0].coin), client.l2Book(market.sides[1].coin)]);
  return { outcome: market.outcome, sides: [sideBookFrom(a), sideBookFrom(b)] };
}

export interface QuoteRequest {
  readonly side: 0 | 1;
  readonly action: 'buy' | 'sell';
  /** Size in outcome tokens (each pays 1 quote unit if the side wins). */
  readonly size: number;
}

export interface Quote {
  readonly side: 0 | 1;
  readonly action: 'buy' | 'sell';
  readonly requestedSize: number;
  readonly filledSize: number;
  readonly complete: boolean;
  /** Size-weighted average price of the filled part, in quote units per token. */
  readonly averagePrice: number | null;
  readonly worstPrice: number | null;
  readonly bestPrice: number | null;
  /** Difference between average and best price, in cents per token; positive means worse than the touch. */
  readonly slippageCents: number | null;
  readonly notional: number;
  readonly levelsUsed: number;
}

/** Walk one side of a book for a size. Buys consume asks from the best up; sells consume bids from the best down. */
export function quoteFromBook(book: SideBook, req: QuoteRequest): Quote {
  const levels = req.action === 'buy' ? book.asks : book.bids;
  let remaining = req.size;
  let notional = 0;
  let filled = 0;
  let worst: number | null = null;
  let used = 0;
  for (const lvl of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.sz);
    notional += take * lvl.px;
    filled += take;
    remaining -= take;
    worst = lvl.px;
    used += 1;
  }
  const best = levels[0]?.px ?? null;
  const avg = filled > 0 ? notional / filled : null;
  return {
    side: req.side,
    action: req.action,
    requestedSize: req.size,
    filledSize: filled,
    complete: remaining <= 1e-12,
    averagePrice: avg,
    worstPrice: worst,
    bestPrice: best,
    // Prices are quote units per token, so a price difference of 0.01 is one cent per token. Kept to 4 decimals of a cent.
    slippageCents: avg !== null && best !== null ? Math.round((req.action === 'buy' ? avg - best : best - avg) * 100 * 1e4) / 1e4 : null,
    notional,
    levelsUsed: used,
  };
}

export async function quote(client: InfoClient, market: Market, req: QuoteRequest): Promise<Quote> {
  const raw = await client.l2Book(market.sides[req.side].coin);
  return quoteFromBook(sideBookFrom(raw), req);
}
