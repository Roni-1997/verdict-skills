import type { IncomingMessage, ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { AccountAuthority } from './connect-authority.js';
import { LighterProvisioner } from './lighter-provisioner.js';
import { AccountServiceConfig } from './connect-model.js';
import { createAccountService } from './connect-http.js';
import { Binding, HostedError } from './hosted-model.js';
import { PostgresAuthorityStore } from './postgres-authority.js';
import { PostgresHostedJobs } from './postgres-jobs.js';
import { PrivateSignerClient } from './private-signer-client.js';

function verifiedDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) throw new Error();
    // pg connection-string SSL options override the Pool's ssl object. Pin full verification in the URL too.
    url.searchParams.set('sslmode', 'verify-full');
    url.searchParams.delete('uselibpqcompat');
    return url.toString();
  } catch { throw new HostedError(503, 'hosted_configuration', 'The provisioned TLS database connection is unavailable.'); }
}

/** Provisioned public runtime only: neither database administration nor private signing keys are accepted. */
export async function createPostgresAccountService(input: AccountServiceConfig, dependencies: { pool?: Pool; signerTransport?: typeof fetch } = {}) {
  const config = AccountServiceConfig.parse(input);
  if (config.storage.kind !== 'postgres' || config.lighterProvisioner?.kind !== 'hosted_signer' || config.allowInsecureLocalhost
    || config.profiles.some(profile => profile.execution.kind !== 'hosted_signer')) throw new HostedError(503, 'hosted_configuration', 'The public hosted service requires PostgreSQL and a fixed private HTTPS signer.');
  const connectionString = process.env[config.storage.connectionStringEnv];
  if (!dependencies.pool && (!connectionString || connectionString.length > 16_384)) throw new HostedError(503, 'hosted_configuration', 'The provisioned public database connection is unavailable.');
  const pool = dependencies.pool ?? new Pool({ connectionString: verifiedDatabaseUrl(connectionString ?? ''), ssl: { rejectUnauthorized: true }, max: 3,
    connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000, maxLifetimeSeconds: 300, allowExitOnIdle: true });
  const repository = new PostgresAuthorityStore(pool, { deploymentId: config.storage.deploymentId, databaseId: config.storage.databaseId });
  const jobs = new PostgresHostedJobs({ pool, deploymentId: config.storage.deploymentId, databaseId: config.storage.databaseId });
  try {
    // Validate both independently versioned markers at startup. Missing state is never initialized here.
    await repository.read(async () => undefined); await jobs.get('00000000-0000-4000-8000-000000000000');
    const signer = new PrivateSignerClient(config.lighterProvisioner, dependencies.signerTransport);
    const authority = await AccountAuthority.create(config, async (profile, subject) => {
      if (!subject) throw new HostedError(503, 'private_signer_unavailable', 'A verified account subject is required.');
      return (await signer.connect(Binding.parse({ ...profile, subject }))).inspectConnection();
    }, new LighterProvisioner(config.lighterProvisioner, signer), repository);
    const service = await createAccountService(config, authority, { gateway: { jobs, remoteConnect: binding => signer.connect(binding) } });
    return { handle: service.handle, close: async () => { try { await service.close(); } finally { if (!dependencies.pool) await pool.end(); } } };
  } catch (error) { await jobs.close(); await repository.close(); if (!dependencies.pool) await pool.end(); throw error; }
}

let service: Promise<Awaited<ReturnType<typeof createPostgresAccountService>>> | undefined;
function configuredService() {
  if (service) return service;
  const value = process.env.VERDICT_ACCOUNT_SERVICE_CONFIG;
  if (!value || Buffer.byteLength(value) > 1_048_576) throw new HostedError(503, 'hosted_configuration', 'The hosted account service is not configured.');
  const config = AccountServiceConfig.parse(JSON.parse(value));
  service = createPostgresAccountService(config).catch(error => { service = undefined; throw error; });
  return service;
}

/** Vercel Node.js entrypoint. All durable authorization/order state is external PostgreSQL. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try { const runtime = await configuredService(); runtime.handle(req, res); }
  catch {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
    res.end(JSON.stringify({ error: 'hosted_service_unavailable', message: 'The configured account service is unavailable. Keep the original connection or order and check its status.' }));
  }
}
