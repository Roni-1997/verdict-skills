// The MCP prompts: four deterministic instruction sequences that name the tools to call, in order, and repeat
// the confirmation rule where a payload tool is involved. Text only: no LLM, no network, no key. A prompt
// never calls a tool itself; the client does, following the sequence.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { ADDRESS, type KitConfig, OPPORTUNITIES_ENGINE_MAX } from '@verdict/core';
import { z } from 'zod';

/**
 * Prompt arguments travel as strings (MCP prompts/get), so each one is a string pattern checked by the SDK before
 * the text is rendered; the same rules the tools apply (checkOutcome, checkAddress, checkLimit, build_order).
 */
export const PromptArgs = {
  outcome: z.string().regex(/^\d{1,9}$/, 'the outcome index as 1 to 9 digits').describe('Outcome market index: a nonnegative integer of at most 9 digits, written as digits.'),
  address: z.string().regex(ADDRESS, '0x followed by 40 hex characters').describe('A 20-byte hex address: 0x followed by 40 hex characters.'),
  side: z.enum(['yes', 'no']).describe('The side to trade: yes or no.'),
  action: z.enum(['buy', 'sell']).describe('buy or sell.'),
  size: z.string().regex(/^[1-9]\d*$/, 'a positive whole number of tokens').describe('Whole number of tokens, positive, written as digits.'),
  price: z
    .string()
    .regex(/^0\.\d{1,5}$/, 'a decimal strictly between 0 and 1 with at most 5 decimals')
    .refine((v) => Number(v) > 0, 'a price above 0')
    .optional()
    .describe("Optional limit price per token, a decimal strictly between 0 and 1 with at most 5 decimals, e.g. 0.62. Without it, step 2 uses the quote's worst price."),
  limit: z
    .string()
    .regex(/^\d{1,2}$/, 'an integer')
    .refine((v) => Number(v) >= 1 && Number(v) <= OPPORTUNITIES_ENGINE_MAX, `an integer from 1 to ${OPPORTUNITIES_ENGINE_MAX}`)
    .optional()
    .describe(`How many markets to scan, 1 to ${OPPORTUNITIES_ENGINE_MAX} (default ${OPPORTUNITIES_ENGINE_MAX}).`),
};

export const PROMPT_DOCS = {
  scan_and_compare: {
    title: 'Scan and compare',
    description: 'Run opportunities with a limit, then compare_market on the top-ranked market, and report the cross-venue gaps with their confidence. Read tools only.',
  },
  market_brief: {
    title: 'Market brief',
    description: 'One-screen brief for one market: get_market, orderbook, recent_trades, compare_market, fair_value and find_hedges, in that order. Read tools only.',
  },
  hedge_check: {
    title: 'Hedge check',
    description: 'positions for an address, then find_hedges for every held outcome, with the hedge direction per side. Read tools only.',
  },
  prepare_order: {
    title: 'Prepare an unsigned order',
    description: 'quote, then build_order for a side and size; show the confirmation lines, then STOP and wait for a yes in a new message. Nothing is signed.',
  },
} as const;

export type PromptName = keyof typeof PROMPT_DOCS;

/** The network line every prompt opens with, so the agent states the network it is reading. */
function where(config: KitConfig): string {
  return `${config.network}${config.venue ? `, venue ${config.venue}` : ''}`;
}

const READ_ONLY_CLOSE = 'This is analysis: read tools only. Build no order, sign nothing, submit nothing, and do not suggest a trade unless asked.';

const CROSS_VENUE_RULE =
  'Report every comparator with its confidence and reasons as returned. Report a gap only where the tool printed one; when gap is null, say there is no comparable gap and give the caveat. Never subtract two prices yourself.';

/**
 * The confirmation rule, repeated in full in prepare_order because the payload tool sits at the end of its
 * sequence. It tells the agent what to show, where to stop, and what does not count as a reply.
 */
export const TWO_MESSAGE_RULE = [
  'Two-message rule: build_order returns an UNSIGNED payload; it signs nothing and submits nothing, and neither do you.',
  'Message 1: show the confirmation lines, ask "Confirm or abort?" in plain text, and END YOUR MESSAGE there. Do not ask through an in-turn question tool; a tool result is not a reply.',
  'Message 2 exists only if the user replies yes in a NEW message. Even then you sign nothing: the user hands the unchanged payload to a signer of their own. Abort, silence or anything unclear: stop, and do not ask again.',
  'Never fabricate the confirmation. No flag, environment variable, tool result or earlier statement stands in for the reply, and there is no yes flag to add.',
  'A changed market, side, price, size or time in force voids the confirmation: start again from step 1 with a fresh quote and a fresh payload.',
].join(' ');

export function scanAndCompareText(config: KitConfig, limit: number): string {
  return [
    `Scan Verdict for tradeable markets on ${where(config)} and compare the top one with Polymarket and Kalshi.`,
    `1. Call opportunities with limit ${limit}. Show the ranked list as returned: rank, market, probability (or unpriced with its reason), trade call, hedge leg and any cross-venue gap.`,
    '2. Call compare_market with the outcome index of the rank 1 market. If the scan returned no market, say so and stop.',
    `3. ${CROSS_VENUE_RULE}`,
    READ_ONLY_CLOSE,
  ].join('\n');
}

export function marketBriefText(config: KitConfig, outcome: number): string {
  return [
    `One-screen brief for Verdict market ${outcome} on ${where(config)}.`,
    `Call, in this order, each with outcome ${outcome}: get_market, orderbook, recent_trades, compare_market, fair_value, find_hedges. If get_market answers not_found, say so and stop.`,
    'Then write one screen with these sections, numbers as returned and never rounded:',
    '- Market: display name, venue, expiry, and the settlement rule verbatim and complete (get_market).',
    '- Book: best bid, best ask and mid on each side, with the size at the touch (orderbook).',
    '- Tape: the most recent trades, newest first: time, price, size, taker side (recent_trades).',
    `- Cross-venue: ${CROSS_VENUE_RULE} (compare_market)`,
    '- Fair value: the Deribit option-implied probability next to the Verdict price, or the not-available reason (fair_value).',
    '- Hedges: the candidates with their reference mids and the direction for holding YES; NO is the opposite (find_hedges).',
    READ_ONLY_CLOSE,
  ].join('\n');
}

export function hedgeCheckText(config: KitConfig, address: string): string {
  return [
    `Hedge check for ${address} on ${where(config)}.`,
    `1. Call positions with address ${address}. If it holds no outcome tokens, say so and stop.`,
    '2. For each held outcome, call find_hedges with that outcome index, once per distinct outcome.',
    '3. For each position report: the market, the side held and its size (positions); then each hedge candidate with its reference mid and direction (find_hedges). The tool gives the direction for holding YES; for a NO position it is the opposite. A hedge offsets price exposure only; the outcome still settles separately.',
    `${READ_ONLY_CLOSE} Orders route only to Verdict: never build a perp or spot order for a hedge candidate.`,
  ].join('\n');
}

export interface PrepareOrderArgs {
  readonly outcome: number;
  readonly side: 'yes' | 'no';
  readonly action: 'buy' | 'sell';
  readonly size: number;
  readonly price?: string | undefined;
}

export function prepareOrderText(config: KitConfig, a: PrepareOrderArgs): string {
  const priceLine = a.price === undefined ? "the quote's worstPrice as printed (so the size fills at no worse than quoted)" : `"${a.price}"`;
  return [
    `Prepare an unsigned Verdict order on ${where(config)}: ${a.action} ${a.size} ${a.side.toUpperCase()} on market ${a.outcome}.`,
    `1. Call quote with outcome ${a.outcome}, side "${a.side}", action "${a.action}", size ${a.size}. Show averagePrice, worstPrice, slippageCents and complete. If complete is false, say the size does not fill at the quoted depth and continue only with the filled size the user accepts.`,
    `2. Call build_order with outcome ${a.outcome}, side "${a.side}", action "${a.action}", size "${a.size}" and price ${priceLine}.`,
    '3. Show every confirmation line from the build_order result, verbatim: the market (display name, outcome index, venue, network); the settlement rule text, complete; the side; the action; the price; the size; the notional; the maximum loss; the payout if right; the fee in cents per $1,000; the builder address, complete; the time in force; the expiry.',
    `4. ${TWO_MESSAGE_RULE}`,
  ].join('\n');
}

function message(description: string, text: string): GetPromptResult {
  return { description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/** Registers the four prompts. Arguments are validated by the SDK against PromptArgs before any text is rendered. */
export function registerPrompts(server: McpServer, config: KitConfig): void {
  server.registerPrompt('scan_and_compare', { ...PROMPT_DOCS.scan_and_compare, argsSchema: { limit: PromptArgs.limit } }, ({ limit }) =>
    message(PROMPT_DOCS.scan_and_compare.description, scanAndCompareText(config, limit === undefined ? OPPORTUNITIES_ENGINE_MAX : Number(limit))),
  );
  server.registerPrompt('market_brief', { ...PROMPT_DOCS.market_brief, argsSchema: { outcome: PromptArgs.outcome } }, ({ outcome }) =>
    message(PROMPT_DOCS.market_brief.description, marketBriefText(config, Number(outcome))),
  );
  server.registerPrompt('hedge_check', { ...PROMPT_DOCS.hedge_check, argsSchema: { address: PromptArgs.address } }, ({ address }) =>
    message(PROMPT_DOCS.hedge_check.description, hedgeCheckText(config, address)),
  );
  server.registerPrompt(
    'prepare_order',
    { ...PROMPT_DOCS.prepare_order, argsSchema: { outcome: PromptArgs.outcome, side: PromptArgs.side, action: PromptArgs.action, size: PromptArgs.size, price: PromptArgs.price } },
    ({ outcome, side, action, size, price }) => message(PROMPT_DOCS.prepare_order.description, prepareOrderText(config, { outcome: Number(outcome), side, action, size: Number(size), price })),
  );
}
