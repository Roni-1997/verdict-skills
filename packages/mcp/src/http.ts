// The streamable HTTP face's request handling, kept out of bin.ts so it can be unit-tested against an
// ephemeral port or no port at all: bin.ts is the process entry point and starts listening on import.
import type { IncomingMessage, ServerResponse } from 'node:http';

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

/** One request's MCP session: a connected server and transport pair. Stateless mode opens one per request. */
export interface RequestSession {
  handleRequest(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface RequestHandlerOptions {
  /** Body of GET /healthz. */
  readonly health: () => unknown;
  /** Open a fresh session for one request; any rejection here or in the session is answered, never thrown. */
  readonly open: () => Promise<RequestSession>;
  /** One line per failure; stderr in bin.ts. */
  readonly log: (line: string) => void;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
/** The answer to a failure inside the handler when nothing has been sent yet. */
export const INTERNAL_ERROR_RESPONSE = JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });

/**
 * The HTTP request listener for --http. Every async step (reading the body, opening the session, the transport's
 * own handling) runs under one rejection handler: a failure is logged and answered exactly once, with HTTP 500 and
 * a JSON-RPC error object when no headers have gone out, or by ending the response when they have, and nothing
 * escapes as an unhandled rejection that would end the process. Closing the session when the response closes is
 * guarded the same way.
 */
export function createRequestHandler(opts: RequestHandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(opts.health()));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const parsed = parseJsonBody(Buffer.concat(chunks).toString('utf8'));
      if (!parsed.ok) {
        res.writeHead(parsed.status, JSON_HEADERS);
        res.end(parsed.response);
        return;
      }
      body = parsed.body;
    }
    const session = await opts.open();
    res.on('close', () => {
      session.close().catch((e: unknown) => opts.log(`verdict-mcp: session close failed: ${describe(e)}`));
    });
    await session.handleRequest(req, res, body);
  }

  return (req, res) => {
    let answered = false;
    const failOnce = (e: unknown): void => {
      opts.log(`verdict-mcp: request failed: ${describe(e)}`);
      if (answered) return;
      answered = true;
      try {
        if (!res.headersSent) {
          res.writeHead(500, JSON_HEADERS);
          res.end(INTERNAL_ERROR_RESPONSE);
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch (inner) {
        opts.log(`verdict-mcp: could not answer the failed request: ${describe(inner)}`);
      }
    };
    handle(req, res).catch(failOnce);
  };
}
