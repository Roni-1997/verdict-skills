// Request-body parsing for the streamable HTTP face. Kept out of bin.ts so it can be unit-tested
// without binding a port: bin.ts is the process entry point and starts listening on import.

export type ParsedBody = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly status: 400; readonly response: string };

/**
 * Parse a POST body for the MCP transport. An empty body is a valid absent body (GET-style requests
 * carry none). Anything that is not JSON is answered with HTTP 400 and a JSON-RPC parse-error object
 * (code -32700), so one malformed request cannot take the server down.
 */
export function parseJsonBody(text: string): ParsedBody {
  if (text === '') return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 400, response: JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: `Parse error: ${message}` }, id: null }) };
  }
}
