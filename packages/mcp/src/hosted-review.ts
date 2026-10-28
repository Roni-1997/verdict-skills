import { LighterBuyIntent, lighterTicks } from '@verdict/core';
import type { HostedError, HostedMutation, Job } from './hosted-model.js';

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const decimal = (value: bigint) => {
  const digits = value.toString().padStart(13, '0');
  return `${digits.slice(0, -12)}.${digits.slice(-12)}`.replace(/\.?0+$/, '');
};
const row = (label: string, value: string) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
const scale = 1_000_000_000_000n;
const displayCeiling = (value: bigint) => {
  const cents = ((value + scale / 100n - 1n) / (scale / 100n)).toString().padStart(3, '0');
  return `${cents.slice(0, -2)}.${cents.slice(-2)}`;
};

export function canRefreshReview(job: Job, now = Date.now()): boolean {
  const leg = job.proposal.payload.legs[0];
  return (job.state === 'replaced' || (job.state === 'pending' && job.expiresAt <= now)) && job.purpose === 'submit' && job.authorization !== null
    && job.proposal.payload.legs.length === 1 && leg?.venue === 'lighter' && leg.action === 'buy' && leg.tif === 'ioc'
    && LighterBuyIntent.shape.maxSpendUSDC.safeParse(job.proposal.payload.policy.maxTotalDebitUSDC).success
    && LighterBuyIntent.shape.maxSpendUSDC.safeParse(job.proposal.payload.policy.maxLegDebitUSDC).success;
}

export function reviewContent(job: Job, csrf: string, now = Date.now()): { title: string; content: string } {
  const leg = job.proposal.payload.legs[0];
  if (!leg || leg.venue !== 'lighter') throw new Error('A single Lighter review is required');
  const expired = job.state === 'replaced' || (job.state === 'pending' && job.expiresAt <= now);
  const active = job.state === 'pending' && !expired;
  const title = expired ? 'Quote expired' : job.state === 'declined' ? 'Trade declined' : job.state !== 'pending' ? 'Trade status' : job.purpose === 'cancel' ? 'Cancel this order?' : 'Review trade';
  const testnet = leg.network !== 'mainnet';
  const notional = (lighterTicks(leg.shares, 12) * lighterTicks(leg.limitPrice, 12) + scale - 1n) / scale;
  const maximum = (leg.action === 'buy' ? notional : 0n) + lighterTicks(leg.feeReserveUSDC, 12);
  const summary = `<p class="network">Lighter ${escapeHtml(leg.network)}${testnet ? ' · test funds only' : ' · real funds'}</p><h2>${escapeHtml(leg.title)}</h2><p class="trade-side">${job.purpose === 'cancel' ? 'Cancel' : leg.action === 'buy' ? 'Buy' : 'Sell'} <strong>${leg.side.toUpperCase()}</strong></p>`;
  const csrfField = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  const form = (buttons: string) => `<form method="post" action="/review/${job.id}">${csrfField}${buttons}</form>`;
  const action = active ? form(`<button name="decision" value="confirm">${job.purpose === 'submit' ? 'Confirm this order' : 'Confirm cancellation'}</button><button class="secondary" name="decision" value="decline">Decline</button>`)
    : expired ? `${canRefreshReview(job, now) ? form('<button name="decision" value="refresh">Refresh quote</button>') : '<p>Ask your agent for a fresh review of this order.</p>'}<p class="hint">This review sent no order. Your account and key setup are saved. A fresh quote needs a new confirmation.</p>`
      : job.state === 'declined' ? '<p>You declined this request. No order will be retried.</p>'
        : '<p>This request has already been processed. Ask your agent for its status; do not submit a replacement.</p>';
  const details = `<details><summary>Settlement rules and order details</summary><h3>Settlement</h3><p class="rules">${escapeHtml(leg.settlementRule)}</p><dl>${row('Exact maximum debit', `${decimal(maximum)} USDC`)}${row('Account', `${leg.account}`)}${row('Market', `${leg.market}`)}${row('Creator', `${leg.creator}`)}${row('Hosted key slot', `${leg.apiKeyIndex}`)}${row('Order type', leg.tif === 'ioc' ? 'Immediate or cancel' : leg.tif)}${row('Review expires', new Date(job.expiresAt).toISOString())}${row('Request', job.proposal.payload.requestId)}</dl><p class="hint">The headline amount is rounded up to the next cent. Verdict holds the trading key. The broker enforces your existing limits and checks current venue data before signing. The fee reserve is an estimate. Lighter keys have broader venue powers than trading.</p><p class="digest">${escapeHtml(job.proposal.digest)}</p></details>`;
  return { title, content: `<section class="review-card">${summary}<div class="amount"><span>${leg.action === 'buy' ? 'Maximum spend' : 'Maximum fee reserve'}</span><strong>${displayCeiling(maximum)}<small> USDC</small></strong></div><dl class="terms">${row('Shares', leg.shares)}${row('Limit price', `${decimal(lighterTicks(leg.limitPrice, 12) * 100n)}¢`)}${row('Fee estimate · included', `${leg.feeReserveUSDC} USDC`)}</dl>${leg.action === 'sell' ? '<p class="notice">A sell can open the opposite side if you do not hold enough shares.</p>' : ''}${active ? '<p class="hint">No wallet signature. Confirm once to send this exact order within your existing limits.</p>' : ''}${action}</section>${details}` };
}

export function resultContent(result: HostedMutation, progress?: { statusUrl: string; automatic: boolean }): { title: string; content: string } {
  const complete = result.state === 'complete';
  const title = complete ? 'Trade complete' : result.state === 'review_updated' ? 'Quote updated' : result.state === 'approval_required' ? 'Confirmation needed' : 'Checking your order';
  const message = complete ? 'Return to your agent to see the fill and updated position.'
    : result.state === 'review_updated' ? 'Your quote was refreshed. Your agent can track the new review without placing another order.'
      : result.state === 'review_refreshing' ? 'A fresh review is being prepared. Keep this original request for status.'
    : result.state === 'approval_required' ? 'Review the order before it can be sent.'
      : 'Keep this request. Your agent can check its status safely. Do not place a replacement while delivery is uncertain.';
  const status = progress ? `<p class="hint">${progress.automatic ? 'This page checks the original order automatically for a short time.' : 'Automatic checks have paused. You can check the original order again.'} Checking status never sends another order.</p><p><a href="${escapeHtml(progress.statusUrl)}">Check status</a></p>` : '';
  return { title, content: `<section class="review-card"><p>${message}</p>${'legs' in result ? `<dl>${result.legs.map(leg => row(`Order ${leg.leg + 1}`, `${leg.state}${leg.filled === null ? '' : ` · ${leg.filled} shares filled`}`)).join('')}</dl>` : ''}${status}</section><details><summary>Execution details</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre></details>` };
}

export function reviewErrorContent(error: HostedError): { title: string; content: string } {
  const reconnect = ['invalid_token', 'invalid_connection', 'account_not_linked', 'profile_unavailable', 'binding_changed', 'account_not_ready'].includes(error.code);
  return { title: reconnect ? 'Reconnect to continue' : 'Review unavailable', content: `<section class="review-card"><p>${reconnect
    ? 'This trading connection is no longer active. Return to your agent and reconnect; Verdict will check your saved account and key setup.'
    : 'This review could not be completed. Ask your agent to check the original request before preparing another order.'}</p><p class="hint">If you already confirmed, keep the original request for status. Do not submit a replacement while delivery is uncertain.</p></section><details><summary>Technical details</summary><p>${escapeHtml(error.code)}</p></details>` };
}

export const REVIEW_STYLES = `:root{color-scheme:light dark;--bg:#0c1112;--card:#141c1d;--text:#eff5f4;--muted:#9eafad;--line:#2b3839;--accent:#b6f4d9;--ink:#10271d}*{box-sizing:border-box}body{font:16px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:36px 20px 60px}main{max-width:520px;margin:auto}.brand{font-size:12px;font-weight:750;letter-spacing:.2em;color:var(--muted);margin:0 0 26px}h1{font-size:30px;line-height:1.15;letter-spacing:-.04em;margin:0 0 24px}h2{font-size:21px;line-height:1.3;letter-spacing:-.02em;margin:14px 0 10px;overflow-wrap:anywhere}h3{font-size:16px}.review-card{border:1px solid var(--line);border-radius:18px;padding:24px;background:var(--card)}.network{font-size:12px;font-weight:650;letter-spacing:.02em;margin:0;color:var(--muted)}.trade-side{font-size:14px;color:var(--muted);margin:0}.trade-side strong{color:var(--accent)}.amount{border-block:1px solid var(--line);padding:20px 0;margin:22px 0 12px}.amount span{display:block;font-size:13px;color:var(--muted);margin-bottom:5px}.amount strong{font-size:32px;font-weight:650;letter-spacing:-.04em;overflow-wrap:anywhere}.amount small{font-size:14px;letter-spacing:0;font-weight:500;color:var(--muted)}dl{margin:0}dl>div{display:flex;justify-content:space-between;gap:20px;padding:6px 0;font-size:14px}dt{color:var(--muted)}dd{margin:0;text-align:right;overflow-wrap:anywhere;min-width:0}.hint{font-size:13px;color:var(--muted);margin:20px 0 0}.notice{font-size:14px;border-left:2px solid #d3a76e;padding-left:12px}form{display:flex;gap:10px;margin-top:22px;flex-wrap:wrap}button{font:inherit;font-weight:650;border:1px solid transparent;border-radius:10px;padding:13px 16px;cursor:pointer;background:var(--accent);color:var(--ink);flex:1;min-width:160px}button.secondary{flex:0;background:transparent;color:var(--muted);border-color:var(--line);min-width:85px}button:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}button:hover{filter:brightness(.95)}details{margin:20px 0;color:var(--muted);font-size:13px}summary{cursor:pointer;padding:8px 0}.rules,pre{white-space:pre-wrap;overflow-wrap:anywhere}pre,.digest{font:12px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}.digest{padding-top:14px;border-top:1px solid var(--line)}a{color:var(--accent)}@media(prefers-color-scheme:light){:root{--bg:#f5f7f6;--card:#fff;--text:#172725;--muted:#61716e;--line:#dde5e2;--accent:#1e7251;--ink:#fff}.trade-side strong{color:#1e7251}}@media(max-width:420px){body{padding:24px 14px}.review-card{padding:20px}h1{font-size:28px}.amount strong{font-size:29px}dl>div{gap:12px}}`;
