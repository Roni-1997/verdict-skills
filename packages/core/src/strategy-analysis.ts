import type { z } from 'zod';
import { amount, ceilDivide, type PairedSnapshot, SCALE, STRATEGY_INPUTS, strategyInput, type StrategySide, units } from './strategy-model.js';

type AssessInput = z.output<typeof STRATEGY_INPUTS.assess_pair>;
type Levels = PairedSnapshot['hl']['asks']['yes'];
type Venue = 'hl' | 'lighter';
type DirectionId = 'hl_yes' | 'hl_no';
type Relationship = AssessInput['assumptions']['relationship'];

function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
function opposite(side: StrategySide): StrategySide { return side === 'yes' ? 'no' : 'yes'; }
function lighterSide(hl: StrategySide, relationship: Relationship): StrategySide {
  return relationship === 'same_event_reversed_orientation' ? hl : opposite(hl);
}
function total(levels: Levels): bigint { return levels.reduce((sum, level) => sum + units(level.shares), 0n); }

function walk(snapshot: PairedSnapshot, venue: Venue, side: StrategySide, wanted: bigint, hlFeeBps: string | undefined) {
  const levels = snapshot[venue].asks[side];
  let remaining = wanted; let notional = 0n; let fee = 0n; let worstPrice: string | null = null; let levelsUsed = 0;
  for (const level of levels) {
    if (remaining <= 0n) break;
    const size = min(remaining, units(level.shares)); const price = units(level.price);
    notional += ceilDivide(size * price, SCALE);
    if (venue === 'lighter') fee += ceilDivide(size * price * (SCALE - price) * units(snapshot.lighter.takerFeePercent), SCALE ** 3n * 100n);
    else if (hlFeeBps !== undefined) fee += ceilDivide(size * price * units(hlFeeBps), SCALE ** 2n * 10_000n);
    remaining -= size; worstPrice = level.price; levelsUsed++;
  }
  const known = venue === 'lighter' || hlFeeBps !== undefined;
  return {
    filled: wanted - remaining, notional, fee: known ? fee : null,
    cost: known ? notional + fee : null,
    result: { venue, side, requestedShares: amount(wanted), filledShares: amount(wanted - remaining), complete: remaining === 0n,
      notionalUSDC: amount(notional), feeUSDC: known ? amount(fee) : null, allInUSDC: known ? amount(notional + fee) : null, worstPrice, levelsUsed },
  };
}

function snapshotReasons(s: PairedSnapshot, input: AssessInput): string[] {
  const reasons: string[] = []; const { at, policy, assumptions } = input;
  if (at < s.capturedAt) reasons.push('evaluation_precedes_capture');
  for (const venue of ['hl', 'lighter'] as const) {
    const clock = s[venue].clock;
    if (at < clock.requestedAt || at - clock.requestedAt > policy.maxAgeMs) reasons.push(`${venue}_observation_outside_age_budget`);
  }
  for (const side of ['yes', 'no'] as const) {
    const source = s.hl.sourceAt[side];
    if (source > at || at - source > policy.maxAgeMs) reasons.push(`hl_${side}_source_outside_age_budget`);
    if (source > s.hl.clock.receivedAt) reasons.push(`hl_${side}_source_in_future_at_receipt`);
  }
  const clocks = [s.hl.sourceAt.yes, s.hl.sourceAt.no, s.lighter.clock.requestedAt];
  if (Math.max(...clocks) - Math.min(...clocks) > policy.maxSkewMs) reasons.push('book_clock_skew_exceeds_budget');
  if ((s.hl.network === 'mainnet') !== (s.lighter.network === 'mainnet')) reasons.push('mixed_mainnet_and_test_networks');
  if (s.hl.quoteToken !== 'USDC') reasons.push('incompatible_or_unknown_quote_currency');
  if (s.hl.expiresAt === null) reasons.push('hl_expiry_unknown');
  else {
    if (at >= s.hl.expiresAt) reasons.push('hl_expired');
    if (s.hl.expiresAt !== s.lighter.expiresAt) reasons.push('different_expiry_or_trading_end');
  }
  if (!s.lighter.active || at < s.lighter.startsAt || at >= s.lighter.expiresAt) reasons.push('lighter_outside_active_trading_window');
  if (!s.hl.rule?.trim() || /\{[^}]+\}/.test(s.hl.rule)) reasons.push('hl_settlement_rule_missing_or_incomplete');
  if (!s.lighter.rule?.trim()) reasons.push('lighter_settlement_rule_missing');
  if (!/^(yes|up)$/i.test(s.hl.sideNames[0].replace(/^template:/i, '')) || !/^(no|down)$/i.test(s.hl.sideNames[1].replace(/^template:/i, ''))) reasons.push('hl_binary_side_mapping_requires_review');
  if (assumptions.relationship === 'unreviewed') reasons.push('settlement_relationship_unreviewed');
  if (assumptions.hlAllInTakerBpsCap === undefined) reasons.push('hl_all_in_fee_unknown');
  else if (s.hl.knownBuilderBps !== null && units(assumptions.hlAllInTakerBpsCap) < units(s.hl.knownBuilderBps)) reasons.push('hl_fee_cap_below_configured_builder_fee');
  return reasons;
}

function direction(s: PairedSnapshot, input: AssessInput, hlSide: StrategySide, commonReasons: string[]) {
  const id: DirectionId = hlSide === 'yes' ? 'hl_yes' : 'hl_no';
  const otherSide = lighterSide(hlSide, input.assumptions.relationship);
  const desired = units(input.shares); const fees = input.assumptions.hlAllInTakerBpsCap; const extra = units(input.assumptions.extraCostUSDC);
  const available = min(total(s.hl.asks[hlSide]), total(s.lighter.asks[otherSide])) / SCALE;
  const upper = min(desired / SCALE, available);
  const costs = (whole: bigint) => {
    const q = whole * SCALE;
    const hl = walk(s, 'hl', hlSide, q, fees); const lighter = walk(s, 'lighter', otherSide, q, fees);
    return { hl, lighter, total: hl.cost !== null && lighter.cost !== null ? hl.cost + lighter.cost + extra : null };
  };
  let low = 0n; let high = upper;
  if (fees === undefined) high = 0n;
  // Capital and each independent leg's debit increase with size. Profit is checked separately.
  while (low < high) {
    const mid = (low + high + 1n) / 2n; const c = costs(mid);
    if (c.total !== null && c.hl.cost !== null && c.lighter.cost !== null && c.total <= units(input.policy.maxCapitalUSDC)
      && c.hl.cost + extra <= units(input.policy.maxUnhedgedLossUSDC) && c.lighter.cost + extra <= units(input.policy.maxUnhedgedLossUSDC)) low = mid;
    else high = mid - 1n;
  }
  const q = low * SCALE; const c = costs(low);
  const relationshipAssumed = input.assumptions.relationship !== 'unreviewed';
  const net = c.total !== null && relationshipAssumed && q > 0n ? q - c.total : null;
  const reasons = [...commonReasons];
  if (available === 0n) reasons.push('no_common_whole_share_depth');
  if (q === 0n) reasons.push('no_size_within_capital_and_leg_loss_limits');
  if (net !== null && (net <= 0n || net * 100n * SCALE < units(input.policy.minNetCentsPerShare) * q)) reasons.push('net_edge_below_required_threshold');
  const requestedQuotes = { hl: walk(s, 'hl', hlSide, desired, fees).result, lighter: walk(s, 'lighter', otherSide, desired, fees).result };
  return {
    net,
    result: {
      id, kind: reasons.length ? 'blocked' as const : 'conditional_plan' as const, reasons,
      requestedShares: input.shares, plannedShares: amount(q), availableWholeShares: available.toString(),
      reducedSize: q < desired, requestedQuotes, legs: { hl: c.hl.result, lighter: c.lighter.result },
      grossCostUSDC: amount(c.hl.notional + c.lighter.notional), allInCostUSDC: q > 0n && c.total !== null ? amount(c.total) : null,
      conditionalPayoutUSDC: relationshipAssumed && q > 0n ? amount(q) : null,
      conditionalNetUSDC: net === null ? null : amount(net),
      conditionalNetCentsPerShare: net === null ? null : amount(net * 100n * SCALE / q),
      reservedExtraCostUSDC: input.assumptions.extraCostUSDC,
      hlOnlyMaxLossUSDC: q > 0n && c.hl.cost !== null ? amount(c.hl.cost + extra) : null,
      lighterOnlyMaxLossUSDC: q > 0n && c.lighter.cost !== null ? amount(c.lighter.cost + extra) : null,
      independentSettlementMaxLossUSDC: q > 0n && c.total !== null ? amount(c.total) : null,
    },
  };
}

export function assessPair(value: unknown) {
  const p = strategyInput(STRATEGY_INPUTS.assess_pair, value); const s = p.snapshot;
  if (s.kind === 'reference') return { kind: 'reference_only' as const, network: s.network, comparison: s.comparison, liveReady: false as const, note: 'Polymarket/Kalshi reference evidence only; no paired depth, fee cap, plan or orders.' };
  const reasons = snapshotReasons(s, p);
  const directions = [direction(s, p, 'yes', reasons), direction(s, p, 'no', reasons)];
  const eligible = directions.filter((d) => d.result.kind === 'conditional_plan').sort((a, b) => a.net === b.net ? 0 : a.net !== null && (b.net === null || a.net > b.net) ? -1 : 1);
  const selected = eligible[0]?.result.id ?? null;
  return {
    kind: selected ? 'conditional_plan' as const : 'blocked' as const, liveReady: false as const, pair: s.pair,
    networks: { hl: s.hl.network, lighter: s.lighter.network }, evaluatedAt: p.at,
    expiresAt: Math.min(s.hl.clock.requestedAt + p.policy.maxAgeMs, s.lighter.clock.requestedAt + p.policy.maxAgeMs,
      s.hl.sourceAt.yes + p.policy.maxAgeMs, s.hl.sourceAt.no + p.policy.maxAgeMs, s.hl.expiresAt ?? p.at, s.lighter.expiresAt),
    selectedDirection: selected, directions: directions.map((d) => d.result), assumptions: p.assumptions, policy: p.policy,
    settlementVerification: 'not_verified' as const,
    notes: [
      'Payout and net values are conditional on the caller-assumed event, side orientation, oracle, window, boundary and void rules being equivalent.',
      'Prefunded separate accounts assumed. No balances, permissions, minimum order eligibility or actual fills checked. This is not an executable order.',
      'Lighter source timestamp is unavailable; observation recency does not establish exchange-source freshness.',
      'HL fee cap is caller supplied and must include all trading, deployer and builder fees. Lighter uses its undiscounted market taker fee; no integrator fee configured.',
      'Size is the largest whole-share size within fetched depth and capital/leg-loss limits, not a profit-maximizing search. Snapshot depth does not guarantee fills.',
    ],
  };
}

export function paperPair(value: unknown) {
  const p = strategyInput(STRATEGY_INPUTS.paper_pair, value);
  const assessment = assessPair({ snapshot: p.snapshot, at: p.at, shares: p.shares, policy: p.policy, assumptions: p.assumptions });
  if (assessment.kind === 'reference_only') throw new Error('paired snapshot required');
  const plan = assessment.directions.find((d) => d.id === p.direction);
  if (plan?.kind !== 'conditional_plan') return { kind: 'paper_blocked' as const, paper: true as const, assessment };
  const hlSide: StrategySide = p.direction === 'hl_yes' ? 'yes' : 'no';
  const other = lighterSide(hlSide, p.assumptions.relationship); const q = units(plan.plannedShares);
  const hl = walk(p.snapshot, 'hl', hlSide, min(q, units(p.fills.hl) / SCALE * SCALE), p.assumptions.hlAllInTakerBpsCap);
  const lighterLot = 10n ** BigInt(12 - p.snapshot.lighter.sizeDecimals);
  const lighter = walk(p.snapshot, 'lighter', other, min(q, units(p.fills.lighter) / lighterLot * lighterLot), p.assumptions.hlAllInTakerBpsCap);
  if (hl.cost === null || lighter.cost === null) throw new Error('assessed paper plan must have fee evidence');
  const cost = hl.cost + lighter.cost + ((hl.filled || lighter.filled) ? units(p.assumptions.extraCostUSDC) : 0n);
  const matched = min(hl.filled, lighter.filled);
  const inventory = {
    hl: { yes: hlSide === 'yes' ? amount(hl.filled) : '0', no: hlSide === 'no' ? amount(hl.filled) : '0' },
    lighter: { yes: other === 'yes' ? amount(lighter.filled) : '0', no: other === 'no' ? amount(lighter.filled) : '0' },
  };
  const yesPayout = (hlSide === 'yes' ? hl.filled : 0n) + ((p.assumptions.relationship === 'same_event_reversed_orientation' ? other === 'no' : other === 'yes') ? lighter.filled : 0n);
  const noPayout = hl.filled + lighter.filled - yesPayout;
  return {
    kind: 'paper_result' as const, paper: true as const, liveReady: false as const, pair: p.snapshot.pair, networks: assessment.networks,
    direction: p.direction, plannedShares: plan.plannedShares, fills: { hl: hl.result, lighter: lighter.result }, inventory,
    pairedShares: amount(matched), strandedShares: { hl: amount(hl.filled - matched), lighter: amount(lighter.filled - matched) },
    allInCostUSDC: amount(cost), conditionalSettlement: {
      hlYes: { payoutUSDC: amount(yesPayout), pnlUSDC: amount(yesPayout - cost) },
      hlNo: { payoutUSDC: amount(noPayout), pnlUSDC: amount(noPayout - cost) },
      floorPnlUSDC: amount(min(yesPayout, noPayout) - cost),
    },
    independentSettlementMaxLossUSDC: amount(cost), assumptions: p.assumptions,
    note: 'Deterministic hypothetical fills capped by the plan and visible depth. Fill caps round down to venue size lots. No queue/latency model, actual trades or realized P&L. Conditional payoff assumes identical settlement; otherwise the full debit can be lost.',
  };
}

export function reconcilePair(value: unknown) {
  const p = strategyInput(STRATEGY_INPUTS.reconcile_pair, value);
  const differences: { venue: Venue; side: StrategySide; observedMinusExpectedShares: string }[] = []; const reasons: string[] = [];
  for (const venue of ['hl', 'lighter'] as const) {
    const at = p.observed[venue].observedAt;
    if (at > p.at || p.at - at > p.maxAgeMs) reasons.push(`${venue}_observation_outside_age_budget`);
    for (const side of ['yes', 'no'] as const) {
      const delta = units(p.observed[venue][side]) - units(p.expected[venue][side]);
      if (delta !== 0n) differences.push({ venue, side, observedMinusExpectedShares: amount(delta) });
    }
  }
  if ((p.networks.hl === 'mainnet') !== (p.networks.lighter === 'mainnet')) reasons.push('mixed_mainnet_and_test_networks');
  const hlNet = units(p.observed.hl.yes) - units(p.observed.hl.no);
  const lighterNet = units(p.observed.lighter.yes) - units(p.observed.lighter.no);
  return {
    kind: 'inventory_reconciliation' as const, pair: p.pair, networks: p.networks, evaluatedAt: p.at,
    reconciled: differences.length === 0 && reasons.length === 0, differences, reasons,
    conditionalNetHlYesShares: p.relationship === 'unreviewed' || reasons.length ? null : amount(hlNet + (p.relationship === 'same_event_reversed_orientation' ? -lighterNet : lighterNet)),
    relationship: p.relationship, evidence: 'caller_supplied_absolute_inventory' as const,
    note: 'Position differences do not identify missing trades, order status or realized P&L. Do not resend uncertain orders or infer a hedge is safe from this report. No repairs or orders are submitted.',
  };
}
