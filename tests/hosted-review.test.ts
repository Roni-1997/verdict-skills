import { expect, it } from 'vitest';
import { prepareExecution } from '../packages/core/src/index.js';
import { HostedError, Job } from '../packages/mcp/src/hosted-model.js';
import { reviewContent, resultContent, reviewErrorContent } from '../packages/mcp/src/hosted-review.js';

function job() {
  const proposal = prepareExecution({ validForSeconds: 300, legs: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 5,
    creator: 7, market: 123, title: 'Arsenal · Premier League winner', settlementRule: 'YES if Arsenal wins the stated season.', side: 'yes', action: 'buy',
    shares: '2.8469', limitPrice: '0.7', feeReserveUSDC: '0.007118', tif: 'ioc' }], policy: { maxTotalDebitUSDC: '2', maxLegDebitUSDC: '2' } });
  return Job.parse({ id: '11111111-1111-4111-8111-111111111111', owner: 'a'.repeat(64), bindingHash: 'b'.repeat(64),
    authorization: { kind: 'first_party', grantId: '22222222-2222-4222-8222-222222222222', epoch: 0 },
    purpose: 'submit', proposal, leg: null, state: 'pending', result: null, expiresAt: proposal.payload.expiresAt });
}
it('shows an accurate compact trade with one confirmation, exact shares/price and conservative headline spend', () => {
  const { title, content } = reviewContent(job(), 'browser-csrf');
  const primary = content.split('<details>')[0] ?? '';
  expect(title).toBe('Review trade');
  for (const term of ['Arsenal', 'Buy', 'YES', '2.00', '70¢', '2.8469', '0.007118', 'test funds only']) expect(primary).toContain(term);
  expect(primary.match(/value="confirm"/g)).toHaveLength(1);
  for (const technical of ['Hosted key slot', 'Digest', 'UNSIGNED', 'operator policy', '1.999948']) expect(primary).not.toContain(technical);
  expect(content).toContain('Exact maximum debit'); expect(content).toContain('1.999948 USDC');
});
it('replaces an expired confirmation with quote refresh and preserves saved setup', () => {
  const original = job(); const { title, content } = reviewContent(original, 'csrf', original.expiresAt);
  expect(title).toBe('Quote expired'); expect(content).not.toContain('value="confirm"');
  expect(content).toContain('value="refresh"'); expect(content).toContain('account and key setup are saved');
  expect(content).toContain('new confirmation');
});
it('keeps a retired quote closed to confirmation while allowing its saved refresh to resume', () => {
  const original = job(); const { content } = reviewContent({ ...original, state: 'replaced' }, 'csrf', original.expiresAt + 1);
  expect(content).not.toContain('value="confirm"'); expect(content).toContain('value="refresh"');
});
it.each(['attempted', 'observed', 'declined'] as const)('never offers a fresh trade or confirmation for %s requests', state => {
  const original = job(); const { content } = reviewContent({ ...original, state }, 'csrf', original.expiresAt + 1);
  expect(content).not.toContain('<form'); expect(content).not.toContain('value="refresh"'); expect(content).not.toContain('value="confirm"');
});
it('escapes creator-supplied title/rules and keeps protocol terms in a closed disclosure', () => {
  const original = job(); const leg = original.proposal.payload.legs[0]; if (!leg) throw new Error('Missing leg');
  leg.title = '<img src=x onerror=alert(1)>'; leg.settlementRule = '<script>send()</script>';
  const { content } = reviewContent(original, '"<csrf>');
  expect(content).not.toContain('<img'); expect(content).not.toContain('<script>'); expect(content).not.toContain('value=""<csrf>');
  expect(content).toContain('&lt;img'); expect(content).toContain('&lt;script'); expect(content).toContain('<details><summary>');
});
it('shows uncertain delivery without presenting another submit action', () => {
  const result = resultContent({ state: 'delivery_unknown', digest: 'a'.repeat(64), nextOperation: 'status', automaticRetry: false });
  expect(result.title).toBe('Checking your order'); expect(result.content).toContain('Do not place a replacement'); expect(result.content).not.toContain('<form');
});
it('explains an inactive connection without restarting setup or claiming an uncertain order failed', () => {
  const result = reviewErrorContent(new HostedError(401, 'invalid_token', 'Internal protocol explanation'));
  expect(result.title).toBe('Reconnect to continue'); expect(result.content).toContain('saved account and key setup');
  expect(result.content).toContain('If you already confirmed'); expect(result.content).not.toContain('Internal protocol explanation');
});
