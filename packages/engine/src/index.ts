// The only file in this package written for the kit. Everything else in src/ is the Verdict
// app's engine at the commit pinned in UPSTREAM.json (verified by scripts/check-engine-drift.mjs).
// Explicit re-exports: research-core and playbooks both export ROUTES and getPlaybook.
export {
  VENUES,
  ROUTES,
  fmtCents,
  fmtUsd,
  normalizeProbability,
  computeSpread,
  scoreResolutionEquivalence,
  setupExitPlan,
  tradeCallForMarket,
  computeMispricing,
  buildMispricingCard,
  interpolateLadderComparator,
  digitalAboveProb,
  maturityAdjustComparator,
  buildMaturityAdjustedCard,
  findHedgeCandidates,
  getPlaybook,
  normalizeVerdictSnapshot,
  normalizePolymarketMarket,
  normalizeKalshiMarket,
  normalizeOddpoolMarket,
  searchPolymarket,
  searchKalshi,
  searchOddpool,
  deribitImpliedProb,
  classifyRoute,
  buildAgentReply,
  evaluateEvidenceGate,
  opportunityScore,
  selectOpportunityMarkets,
  crossVenueEdgeLine,
  runOpportunity,
  runResearch,
} from './research-core.js';
export type { EquivalenceResult, MispricingResult, DeribitRef, MaturityAdjustResult, HedgeCandidate, ExitPlan, TradeCall } from './research-core.js';
export { PLAYBOOKS, ROUTE_ALIASES, routeFromMode } from './playbooks.js';
export type { HardGates, Playbook, RouteId } from './playbooks.js';
export { bookFullLevels, bookMid, bookTopBidAsk, ctxOutcomeMid, parseDescription, robustOutcomeMid } from './hl-shape.js';
export type { AssetCtx, Book, FullLevels, ParsedMarket, TopOfBook } from './hl-shape.js';
export { ENGINE_UPSTREAM } from './upstream.js';
