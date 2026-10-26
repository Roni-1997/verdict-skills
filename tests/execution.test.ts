import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { executionCapabilities, executionConfirmation, prepareExecution, validateExecution } from '../packages/core/src/execution.js';
import { runCli } from '../packages/cli/src/index.js';

const ACCOUNT = `0x${'1'.repeat(40)}`;
const common = { title: 'Oracle event', settlementRule: 'The specified oracle resolves YES when the closing value exceeds 100.', side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1' };
const hl = { ...common, venue: 'hl', network: 'mainnet', account: ACCOUNT, outcome: 123, tif: 'Ioc', builder: { address: `0x${'2'.repeat(40)}`, feeTenthsBp: 10 }, allInFeeBpsCap: '10' };
const lighter = { ...common, venue: 'lighter', network: 'mainnet', account: 42, apiKeyIndex: 2, market: 4555, creator: 7, tif: 'ioc', side: 'no' };
const polymarket = { ...common, venue: 'polymarket', network: 'polygon', account: ACCOUNT, marketId: '123', assetId: '123', tif: 'FAK', side: 'no' };
const policy = { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' };
const review = { relationship: 'same_event_same_orientation', notes: 'Operator compared both full oracle rules manually.' };
const request = (legs: unknown[] = [hl]) => ({ legs, policy, ...(legs.length === 2 ? { settlementReview: review } : {}) });

describe('unsigned execution domain', () => {
  it('keeps omitted safety defaults in the canonical review and rejects null or oversized requests', () => {
    const now = 1792623100000;
    const minimal = { legs: [hl], policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' } };
    const prepared = prepareExecution(minimal, now, '0189d5e0-1c82-4be1-a667-f5fa7b430171');
    expect(prepared.payload).toMatchObject({ createdAt: now, expiresAt: now + 300_000, settlementReview: null,
      policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5', minConditionalProfitUSDC: '0' } });
    expect(validateExecution(prepared)).toEqual(prepared);
    expect(() => prepareExecution({ ...minimal, validForSeconds: null })).toThrow('Invalid execution');
    expect(() => prepareExecution({ ...minimal, policy: { ...minimal.policy, minConditionalProfitUSDC: null } })).toThrow('Invalid execution');
    for (const legs of [[], [hl, hl, hl]]) expect(() => prepareExecution({ ...minimal, legs })).toThrow('Invalid execution');
  });
  it('preserves explicit Lighter testnet through canonical execution and linked account schemas', () => {
    const p = prepareExecution(request([{ ...lighter, network: 'testnet' }]));
    expect(validateExecution(p).payload.legs[0]).toMatchObject({ venue: 'lighter', network: 'testnet' });
    expect(executionConfirmation(p).confirmation.join('\n')).toContain('lighter testnet');
    expect(executionCapabilities().venues.lighter.networks).toEqual(['devnet', 'testnet', 'mainnet']);
    expect(() => prepareExecution(request([{ ...lighter, network: 'unknown' }]))).toThrow('Invalid execution');
    expect(() => prepareExecution(request([hl, { ...lighter, network: 'testnet' }]))).toThrow('mainnet');
  });
  it.each([hl, lighter, polymarket])('prepares a native $venue single order without credentials', (leg) => {
    const p = prepareExecution(request([leg]));
    expect(validateExecution(p)).toEqual(p);
    expect(executionConfirmation(p).confirmation.join('\n')).toContain('UNSIGNED');
    expect(p).not.toHaveProperty('signature');
  });
  it.each([[hl, lighter], [hl, polymarket], [{ ...lighter, side: 'yes' }, polymarket]])('permits reviewed complementary pairs on distinct venues', (a, b) => {
    expect(prepareExecution(request([a, b])).payload.pairMode).toBe('sequential_full_first');
  });
  it('binds all account/size/rule fields and rejects a modified proposal', () => {
    const p = prepareExecution(request());
    expect(() => validateExecution({ ...p, payload: { ...p.payload, legs: [{ ...p.payload.legs[0], shares: '11' }] } })).toThrow('changed');
  });
  it('rejects unknown credential/approval fields at every nesting boundary', () => {
    expect(() => prepareExecution({ ...request(), approved: true })).toThrow('Invalid execution');
    expect(() => prepareExecution(request([{ ...hl, privateKey: 'do-not-accept' }]))).toThrow('Invalid execution');
    const p = prepareExecution(request());
    expect(() => validateExecution({ ...p, signature: 'do-not-accept' })).toThrow('Invalid execution');
  });
  it.each([
    ['same venue', [hl, { ...hl, side: 'no' }]],
    ['mixed environments', [hl, { ...lighter, network: 'devnet' }]],
    ['different quantities', [hl, { ...lighter, shares: '9' }]],
    ['resting second leg', [hl, { ...lighter, tif: 'gtc' }]],
    ['noncomplementary sides', [hl, { ...lighter, side: 'yes' }]],
    ['sell leg', [hl, { ...lighter, action: 'sell' }]],
  ])('blocks %s pairs', (_name, legs) => expect(() => prepareExecution(request(legs))).toThrow());
  it('requires a real relationship review and a positive worst-limit conditional payoff', () => {
    expect(() => prepareExecution({ ...request([hl, lighter]), settlementReview: null })).toThrow('review');
    expect(() => prepareExecution(request([{ ...hl, limitPrice: '0.6' }, lighter]))).toThrow();
  });
  it('supports reversed rules only with the corresponding same-side pair', () => {
    expect(prepareExecution({ ...request([hl, { ...lighter, side: 'yes' }]), settlementReview: { ...review, relationship: 'same_event_reversed_orientation' } }).payload.legs).toHaveLength(2);
  });
  it('enforces total/leg debit caps and reserves HL fees on improving sell prices', () => {
    expect(() => prepareExecution({ ...request(), policy: { ...policy, maxLegDebitUSDC: '4' } })).toThrow('Leg exceeds');
    expect(() => prepareExecution({ ...request([hl, lighter]), policy: { ...policy, maxTotalDebitUSDC: '8' } })).toThrow('total');
    expect(() => prepareExecution(request([{ ...hl, action: 'sell', feeReserveUSDC: '0.004' }]))).toThrow('fee reserve');
  });
  it('rejects fractional HL shares, malformed assets and invalid GTD expiration presence', () => {
    for (const leg of [{ ...hl, shares: '10.1' }, { ...polymarket, shares: '10.001' }, { ...polymarket, assetId: `${2n ** 256n}` }, { ...polymarket, tif: 'GTD' }, { ...polymarket, expiration: 1793000000 }]) expect(() => prepareExecution(request([leg]))).toThrow();
  });
  it('shows all immutable venue identifiers, fee caps and policy in the approval lines', () => {
    const h = executionConfirmation(prepareExecution(request())).confirmation.join('\n');
    expect(h).toContain('outcome 123'); expect(h).toContain('all-in fee cap 10 bps'); expect(h).toContain('per-leg debit cap 5');
    const l = executionConfirmation(prepareExecution(request([lighter]))).confirmation.join('\n');
    expect(l).toContain('market 4555, creator 7, API key index 2');
    const p = executionConfirmation(prepareExecution(request([{ ...polymarket, tif: 'GTD', expiration: 1793000000 }]))).confirmation.join('\n');
    expect(p).toContain('market 123, asset 123, GTD expiration 1793000000');
  });
  it('bounds timestamps before formatting and decimal sizes before arithmetic', () => {
    expect(() => prepareExecution(request(), Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => prepareExecution(request([{ ...hl, shares: '1000000001' }]))).toThrow();
    expect(() => prepareExecution(request([{ ...hl, limitPrice: '1e-2' }]))).toThrow();
  });
  it('canonicalizes property order, includes Unicode safely, and round-trips across JSON', () => {
    const p = prepareExecution(request([{ ...hl, title: 'Élection 🔥' }]));
    const reordered = { digest: p.digest, payload: Object.fromEntries(Object.entries(p.payload).reverse()), kind: p.kind };
    expect(validateExecution(JSON.parse(JSON.stringify(reordered)))).toEqual(p);
  });
});

it('real CLI prepares/reviews proposals and hides invalid input values', async () => {
  const p = await runCli(['execution', 'prepare', '--input', JSON.stringify(request())]);
  expect(p.exitCode).toBe(0);
  expect((await runCli(['execution', 'review', '--input', p.stdout])).stdout).toContain('Digest');
  const bad = await runCli(['execution', 'prepare', '--input', JSON.stringify({ secret: 'do-not-leak' })]);
  expect(bad.exitCode).toBe(1); expect(bad.stderr).not.toContain('do-not-leak');
});

it('built MCP completes prepare/review over stdio, preserves strict schemas and exposes no execution tool', async () => {
  const bin = fileURLToPath(new URL('../packages/mcp/dist/bin.js', import.meta.url));
  const client = new Client({ name: 'execution-e2e', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, '--execution'], env: { VERDICT_NETWORK: 'bad-ignored-keyless-config' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['execution_prepare', 'execution_review', 'execution_capabilities']);
    expect(JSON.stringify(tools.map((tool) => tool.inputSchema))).not.toMatch(/"items":\[/);
    const prepared = await client.callTool({ name: 'execution_prepare', arguments: { ...request([lighter]), settlementReview: null } });
    expect(prepared.isError).not.toBe(true);
    const p = validateExecution(prepared.structuredContent);
    const checked = await client.callTool({ name: 'execution_review', arguments: p });
    expect(checked.isError).not.toBe(true);
    const bad = await client.callTool({ name: 'execution_prepare', arguments: { ...request(), approved: true } });
    expect(bad.isError).toBe(true);
    const conflict = spawnSync(process.execPath, [bin, '--execution', '--strategy'], { encoding: 'utf8' });
    expect(conflict.status).toBe(1);
  } finally { await client.close(); }
});

it('the checked-in operator example is an executable unsigned request', () => {
  const example: unknown = JSON.parse(readFileSync(new URL('../examples/execution/request.json', import.meta.url), 'utf8'));
  expect(prepareExecution(example).payload.legs).toHaveLength(2);
});
