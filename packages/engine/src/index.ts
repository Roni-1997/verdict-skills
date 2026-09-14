// The only file in this package written for the kit. Everything else in src/ is the Verdict app's
// engine byte for byte at the commit pinned in UPSTREAM.json (scripts/check-engine-drift.mjs fails on
// any difference). GOAL.md's success criterion counts such a pinned, verified copy as imported and a hand-edited one as not.
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
