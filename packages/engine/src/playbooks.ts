// Verdict AI route/playbook contracts.
// This is the deterministic policy layer: routes, required evidence, and hard gates.
//
// Strict-typed ES module (plan 03-12). Named types declared and exported here — the domain
// shapes live where the data does, so research-core.ts imports them rather than inferring
// structural shapes from object literals.

export type RouteId =
  | 'strategy_builder'
  | 'trading_setup'
  | 'cross_venue_scanner'
  | 'hedgeability'
  | 'risk_review'
  | 'market_followup'
  | 'opportunity_scan';

export interface HardGates {
  verdictRequired?: boolean;
  minCards?: number;
  actionableRequiresTradePlan?: boolean;
  actionableRequiresPayoffInputs?: boolean;
  noTradeIfMissingPrice?: boolean;
  noTradeIfMissingSpread?: boolean;
  externalComparatorRequired?: boolean;
  allowedComparators?: string[];
  noStandaloneMispricing?: boolean;
}

export interface Playbook {
  id: RouteId;
  title: string;
  intent: string[];
  requiredEvidence: string[];
  optionalEvidence: string[];
  hardGates: HardGates;
  outputContract: string[];
  followups: string[];
}

export const ROUTES = {
  STRATEGY: 'strategy_builder',
  SETUP: 'trading_setup',
  MISPRICING: 'cross_venue_scanner',
  HEDGE: 'hedgeability',
  RISK: 'risk_review',
  FOLLOWUP: 'market_followup',
  OPPORTUNITY: 'opportunity_scan',
} as const satisfies Record<string, RouteId>;

// 'auto' means "no explicit route" — routeFromMode maps it to null, not a Playbook key.
export const ROUTE_ALIASES: Record<string, RouteId | 'auto'> = {
  auto: 'auto',
  strategy: ROUTES.STRATEGY,
  strategy_builder: ROUTES.STRATEGY,
  setup: ROUTES.SETUP,
  trade_setup: ROUTES.SETUP,
  trading_setup: ROUTES.SETUP,
  mispricing: ROUTES.MISPRICING,
  mispricing_scan: ROUTES.MISPRICING,
  cross_venue_scanner: ROUTES.MISPRICING,
  hedge: ROUTES.HEDGE,
  hedge_mapper: ROUTES.HEDGE,
  hedgeability: ROUTES.HEDGE,
  risk: ROUTES.RISK,
  risk_explainer: ROUTES.RISK,
  risk_review: ROUTES.RISK,
  followup: ROUTES.FOLLOWUP,
  market_followup: ROUTES.FOLLOWUP,
  opportunity: ROUTES.OPPORTUNITY,
  opportunity_scan: ROUTES.OPPORTUNITY,
  // Deep research reuses the cross-venue assembly (book + Polymarket/Kalshi + options
  // reference); the report shape is driven by the prompt, not a separate gate.
  deep_research: ROUTES.MISPRICING,
  deep_dive: ROUTES.MISPRICING,
};

export const PLAYBOOKS: Record<RouteId, Playbook> = {
  [ROUTES.SETUP]: {
    id: ROUTES.SETUP,
    title: 'Trading setup',
    intent: ['setup', 'trade setup', 'trade idea', 'position plan', 'entry', 'take profit', 'what should i trade', 'what to trade'],
    requiredEvidence: ['verdict_hl_markets', 'l2_book', 'entry_exit_take_profit', 'payoff_inputs'],
    optionalEvidence: ['hl_spot_perp_reference', 'external_context'],
    hardGates: {
      verdictRequired: true,
      minCards: 1,
      actionableRequiresTradePlan: true,
      actionableRequiresPayoffInputs: true,
      noTradeIfMissingPrice: true,
      noTradeIfMissingSpread: true,
    },
    outputContract: ['exact_market', 'side', 'entry', 'exit_or_reduce', 'take_profit', 'payoff_chart', 'main_risk', 'ticket_action_if_actionable'],
    followups: ['Give setups by event', 'Check hedge risks', 'Compare this to Polymarket', 'Find more liquid setups'],
  },
  [ROUTES.STRATEGY]: {
    id: ROUTES.STRATEGY,
    title: 'Strategy builder',
    intent: ['build strategy', 'what can i build', 'strategy around', 'each listed event', 'per event'],
    requiredEvidence: ['verdict_hl_markets', 'l2_book', 'trade_plan_for_actionable_cards', 'payoff_inputs'],
    optionalEvidence: ['hl_spot_perp_reference', 'event_alternatives'],
    hardGates: {
      verdictRequired: true,
      minCards: 1,
      actionableRequiresTradePlan: true,
      actionableRequiresPayoffInputs: true,
    },
    outputContract: ['market_leg', 'hedge_leg_if_mapped', 'payoff_chart', 'risks', 'ticket_action_if_actionable'],
    followups: ['Give setups by event', 'Check hedge risks', 'Scan mispricings', 'Find more liquid markets'],
  },
  [ROUTES.MISPRICING]: {
    id: ROUTES.MISPRICING,
    title: 'Cross-venue scanner',
    intent: ['mispricing', 'compare', 'polymarket', 'kalshi', 'discrepancy', 'arb'],
    requiredEvidence: ['verdict_hl_markets', 'external_comparator', 'resolution_match_score'],
    optionalEvidence: ['spread_depth_checks', 'external_context'],
    hardGates: {
      verdictRequired: true,
      externalComparatorRequired: true,
      allowedComparators: ['polymarket', 'kalshi'],
      noStandaloneMispricing: true,
    },
    outputContract: ['tradable_hip4_market_first', 'comparator', 'price_gap', 'spread_adjusted_gap', 'match_quality', 'caveats'],
    followups: ['Run Polymarket only', 'Run Kalshi only', 'Show low-confidence matches'],
  },
  [ROUTES.HEDGE]: {
    id: ROUTES.HEDGE,
    title: 'Hedgeability',
    intent: ['hedge', 'perp', 'spot', 'basis', 'delta'],
    requiredEvidence: ['verdict_hl_markets', 'hl_reference_market'],
    optionalEvidence: ['funding_context', 'external_context'],
    hardGates: {
      verdictRequired: true,
      minCards: 1,
      actionableRequiresTradePlan: true,
    },
    outputContract: ['market_leg', 'hedge_leg', 'hedge_direction', 'hedge_limits', 'risks'],
    followups: ['Show only hedgeable BTC markets', 'Explain hedge risks', 'Build a setup'],
  },
  [ROUTES.RISK]: {
    id: ROUTES.RISK,
    title: 'Risk review',
    intent: ['risk', 'why not', 'caveat', 'explain'],
    requiredEvidence: ['verdict_hl_markets', 'rules_or_settlement_text'],
    optionalEvidence: ['hl_reference_market', 'external_context'],
    hardGates: {
      verdictRequired: true,
      minCards: 1,
    },
    outputContract: ['liquidity_risk', 'settlement_risk', 'hedge_risk', 'position_management'],
    followups: ['Build a setup', 'Check hedge risks', 'Compare this to Polymarket'],
  },
  [ROUTES.FOLLOWUP]: {
    id: ROUTES.FOLLOWUP,
    title: 'Setup follow-up',
    intent: ['still valid', 'what changed', 'follow up', 'followup'],
    requiredEvidence: ['current_verdict_hl_markets', 'prior_card_or_active_market'],
    optionalEvidence: ['wallet_position_context'],
    hardGates: {
      verdictRequired: true,
    },
    outputContract: ['changed', 'still_valid', 'new_entry_exit_take_profit', 'invalidate_if_needed'],
    followups: ['Refresh setup', 'Show position actions'],
  },
  [ROUTES.OPPORTUNITY]: {
    id: ROUTES.OPPORTUNITY,
    title: 'Opportunity scan',
    intent: ['best', 'opportunity', 'scan', 'find'],
    requiredEvidence: ['verdict_hl_markets'],
    optionalEvidence: ['external_comparator', 'hl_reference_market'],
    hardGates: {
      verdictRequired: true,
      minCards: 1,
    },
    outputContract: ['ranked_markets', 'why_interesting', 'liquidity_read', 'next_action'],
    followups: ['Build a setup', 'Scan mispricings', 'Find hedgeable trades'],
  },
};

export function routeFromMode(mode: unknown): RouteId | null {
  const value = String(mode || '').trim();
  if (!value) return null;
  const mapped = ROUTE_ALIASES[value] || ROUTE_ALIASES[value.toLowerCase()];
  return mapped === 'auto' || !mapped ? null : mapped;
}

export function getPlaybook(route: RouteId | string | null | undefined): Playbook {
  return (route && (PLAYBOOKS as Record<string, Playbook>)[route]) || PLAYBOOKS[ROUTES.STRATEGY];
}
