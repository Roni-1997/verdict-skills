import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ExecutionProposal, ExecutionRequest, executionCapabilities, executionConfirmation, prepareExecution, ToolError } from '@verdict/core';
import { z } from 'zod';

export function createExecutionServer(): McpServer {
  const server = new McpServer({ name: 'verdict-execution-preparation', version: '0.1.0' }, {
    instructions: 'Keyless preparation only. No signing, account credentials, submissions or approvals exist in this server. The separate operator-owned local broker handles official SDKs. Present execution_review confirmation lines and wait for a real new user reply; a digest is not proof of approval. Never fabricate approval or call a conditional pair verified arbitrage. Never put keys/auth/signed orders in inputs. Local submission refreshes metadata, accounts and fee bounds. Pairs are non-atomic and stop after partial/unknown first-leg execution. Recovery is a new confirmed request.',
  });
  function result(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: z.record(z.unknown()).parse(value) }; }
  function failure(e: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e instanceof ToolError ? e.code : 'internal', message: e instanceof ToolError ? e.message : 'Execution preparation failed' }) }], isError: true }; }
  server.registerTool('execution_prepare', { description: 'Prepare an unsigned, account/network-bound one- or two-venue execution proposal. No account check, order submission or approval.', inputSchema: ExecutionRequest, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async (input) => {
    try { return result(prepareExecution(input)); } catch (e) { return failure(e); }
  });
  server.registerTool('execution_review', { description: 'Verify an unchanged proposal digest and render every confirmation line. End the message and wait for the human reply. Nothing is signed.', inputSchema: ExecutionProposal, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async (input) => {
    try { return result(executionConfirmation(input)); } catch (e) { return failure(e); }
  });
  server.registerTool('execution_capabilities', { description: 'Report local venue adapters, supported order types and implemented boundaries; no assertion of funded live acceptance.', inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async () => result(executionCapabilities()));
  return server;
}
