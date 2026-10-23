import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { AccountAuthority } from './connect-authority.js';
import { AccountServiceConfig } from './connect-model.js';
import { createHostedHandler } from './hosted-http.js';
import { HostedConfig, HostedError, READ_SCOPE, TRADE_SCOPE } from './hosted-model.js';

export async function readAccountServiceConfig(path: string): Promise<AccountServiceConfig> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.size > 1_048_576) throw new Error();
      return AccountServiceConfig.parse(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  } catch { throw new HostedError(400, 'invalid_configuration', 'Account service requires a private 0600 configuration file (values hidden).'); }
}

/** Standard OAuth SDK routes, product handoff and the existing SDK execution gateway in one writer. */
export async function createAccountService(input: AccountServiceConfig, authorityInput?: AccountAuthority) {
  const config = AccountServiceConfig.parse(input);
  const authority = authorityInput ?? await AccountAuthority.create(config);
  let gateway: Awaited<ReturnType<typeof createHostedHandler>>;
  try {
    gateway = await createHostedHandler(HostedConfig.parse({ publicOrigin: config.publicOrigin, issuer: config.publicOrigin,
      browserClientId: 'first_party', stateDir: config.gatewayJobsDir, bindings: [], allowInsecureLocalhost: config.allowInsecureLocalhost,
      approvalTtlSeconds: config.approvalTtlSeconds }), authority);
  } catch (error) { authority.close(); throw error; }
  authority.setReviewLookup(gateway.reviewJobIdentity);
  const app = express(); app.disable('x-powered-by'); app.set('query parser', 'simple');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (req.headers.host !== new URL(config.publicOrigin).host || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.length > 16_384) { res.status(400).json({ error: 'invalid_host' }); return; }
    next();
  });
  app.post('/connect/app', express.json({ limit: '64kb', strict: true }), async (req, res) => {
    try {
      const result = await authority.app(req.body, { ...(typeof req.headers.authorization === 'string' ? { authorization: req.headers.authorization } : {}),
        ...(typeof req.headers['x-verdict-app-session'] === 'string' ? { session: req.headers['x-verdict-app-session'] } : {}),
        ...(typeof req.headers.origin === 'string' ? { origin: req.headers.origin } : {}) });
      res.json(result);
    } catch (error) { res.status(error instanceof HostedError ? error.status : 400).json({ error: error instanceof HostedError ? error.code : 'invalid_connection', message: error instanceof HostedError ? error.message : 'The connection could not be verified.' }); }
  });
  for (const path of ['/connect/complete', '/connect/cancel']) app.get(path, (req, res) => {
    try {
      if (req.headers.authorization !== undefined) throw new HostedError(403, 'browser_required', 'Use the original connection browser.');
      const url = new URL(req.originalUrl, config.publicOrigin);
      const result = path === '/connect/complete' ? authority.complete(url, req.headers.cookie) : authority.cancel(url, req.headers.cookie);
      res.setHeader('Set-Cookie', result.cookies); res.redirect(303, result.location);
    } catch { res.status(400).json({ error: 'invalid_completion', message: 'Start the connection again from the original agent.' }); }
  });
  app.use(mcpAuthRouter({ provider: authority, issuerUrl: new URL(config.publicOrigin), resourceServerUrl: new URL(authority.resource),
    scopesSupported: [READ_SCOPE, TRADE_SCOPE], resourceName: 'Verdict trading connector' }));
  app.use((req, res) => gateway.handle(req, res));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const tooLarge = typeof error === 'object' && error !== null && 'status' in error && error.status === 413;
    if (!res.headersSent) res.status(tooLarge ? 413 : error instanceof SyntaxError ? 400 : 500).json({ error: 'invalid_request' });
  });
  return { handle: (req: IncomingMessage, res: ServerResponse) => app(req, res), close: () => { gateway.close(); authority.close(); } };
}
