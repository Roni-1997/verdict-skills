import { ExecutionProposal, ExecutionRequest, LighterExecutionLeg, ToolError, executionCapabilities, validateExecution } from '@verdict/core';
import { z } from 'zod';

const Singleton = z.tuple([LighterExecutionLeg]);
const Legs = z.array(LighterExecutionLeg).length(1).transform((legs) => Singleton.parse(legs));
export const LighterExecutionRequest = ExecutionRequest.extend({ legs: Legs, settlementReview: z.null().prefault(null) });
export const LighterExecutionProposal = ExecutionProposal.extend({
  payload: ExecutionProposal.shape.payload.extend({ legs: Legs, settlementReview: z.null() }),
});
export const LighterExecutionCancel = z.object({ proposal: LighterExecutionProposal, leg: z.literal(0) }).strict();

export function requireLighterRequest(value: unknown) {
  const parsed = LighterExecutionRequest.safeParse(value);
  if (!parsed.success) throw new ToolError('Verdict supports one Lighter binary outcome order per request.', 'bad_input');
  return parsed.data;
}

export function requireLighterProposal(value: unknown) {
  const parsed = LighterExecutionProposal.safeParse(value);
  if (!parsed.success) throw new ToolError('Use the unchanged proposal for one Lighter binary outcome order.', 'bad_input');
  return validateExecution(parsed.data);
}

export function lighterExecutionCapabilities() {
  const capabilities = executionCapabilities();
  return { version: capabilities.version, hostedSigning: capabilities.hostedSigning, localBroker: capabilities.localBroker,
    orderApproval: capabilities.orderApproval, executionModes: capabilities.executionModes, defaultMode: capabilities.defaultMode, venues: { lighter: capabilities.venues.lighter }, pairs: [], maxOrdersPerProposal: 1,
    note: 'Verdict agent trading on Lighter binary outcomes through the official SDK. Both approval modes require explicit operator authority. Live funded acceptance is separate from implemented capabilities.' };
}
