import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AuthoritySchemas, Enrollment, type AuthorityRecords } from './connect-model.js';
import { AUTHORITY_LOCK, type AuthorityNamespace, type AuthorityRepository, type ConnectReadTx, type ConnectWriteTx } from './connect-store.js';
import { HostedError } from './hosted-model.js';

/** Privileged migration only. Runtime never creates missing authorization state. */
export const POSTGRES_AUTHORITY_DDL = `
CREATE SCHEMA IF NOT EXISTS verdict_mcp;
CREATE TABLE IF NOT EXISTS verdict_mcp.authority_metadata (
  deployment_id UUID PRIMARY KEY, database_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version=1)
);
CREATE TABLE IF NOT EXISTS verdict_mcp.authority_records (
  deployment_id UUID NOT NULL REFERENCES verdict_mcp.authority_metadata(deployment_id),
  namespace TEXT NOT NULL, key TEXT NOT NULL, data JSONB NOT NULL, expires BIGINT NOT NULL,
  PRIMARY KEY(deployment_id,namespace,key), CHECK(jsonb_typeof(data)='object'), CHECK(expires BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE IF NOT EXISTS verdict_mcp.authority_enrollments (
  deployment_id UUID NOT NULL REFERENCES verdict_mcp.authority_metadata(deployment_id),
  subject TEXT NOT NULL, profile TEXT NOT NULL, data JSONB NOT NULL,
  PRIMARY KEY(deployment_id,subject), UNIQUE(deployment_id,profile), CHECK(jsonb_typeof(data)='object')
);`;
const Config = z.object({ deploymentId: z.string().uuid(), databaseId: z.string().uuid() }).strict();
const Marker = z.object({ database_id: z.string().uuid(), version: z.literal(1) }).strict();
const Row = z.object({ data: z.unknown() }).strict();
const Tables = z.object({ records: z.literal(true), enrollments: z.literal(true) }).strict();
const unavailable = () => new HostedError(503, 'authority_storage', 'Authorization state is unavailable. Restore the original private state; never recreate it to recover access.');
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try { if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw unavailable(); return schema.parse(value); } catch { throw unavailable(); }
}
function record<K extends AuthorityNamespace>(namespace: K, value: unknown): AuthorityRecords[K] {
  // The immutable schema registry is the authoritative namespace-to-value mapping.
  return parse(AuthoritySchemas[namespace], value) as AuthorityRecords[K];
}

/** Borrowed Pool; each callback has one guarded connection and owns its complete transaction. */
export class PostgresAuthorityStore implements AuthorityRepository {
  private readonly deploymentId: string;
  private readonly databaseId: string;
  private readonly scope = new AsyncLocalStorage<boolean>();
  private closed = false;
  constructor(private readonly pool: Pool, config: { deploymentId: string; databaseId: string }) {
    const value = Config.safeParse(config); if (!value.success) throw unavailable();
    this.deploymentId = value.data.deploymentId; this.databaseId = value.data.databaseId;
  }
  private async run<T>(write: boolean, keys: readonly string[], body: (tx: ConnectWriteTx) => Promise<T>): Promise<T> {
    if (this.closed || this.scope.getStore()) throw unavailable();
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch { throw unavailable(); }
    let active = true;
    const guard = () => { if (!active) throw unavailable(); };
    const writable = () => { guard(); if (!write) throw unavailable(); };
    const borrowed = new Proxy(client, { get(target, property) {
      if (property === 'query') return (...args: Parameters<PoolClient['query']>) => { guard(); return Reflect.apply(target.query, target, args); };
      if (property === 'release') return () => { throw unavailable(); };
      guard(); return Reflect.get(target, property, target);
    } });
    const query = async (text: string, values: unknown[] = []) => {
      guard(); try { return await client.query(text, values); } catch { throw unavailable(); }
    };
    const tx: ConnectWriteTx = {
      transaction: { kind: 'postgres', client: borrowed, deploymentId: this.deploymentId, databaseId: this.databaseId },
      get: async (namespace, key) => {
        const rows = await query(`SELECT data FROM verdict_mcp.authority_records WHERE deployment_id=$1 AND namespace=$2 AND key=$3${write ? ' FOR UPDATE' : ''}`, [this.deploymentId, namespace, key]);
        return rows.rowCount === 0 ? null : record(namespace, Row.parse(rows.rows[0]).data);
      },
      all: async (namespace) => {
        const rows = await query(`SELECT data FROM verdict_mcp.authority_records WHERE deployment_id=$1 AND namespace=$2${write ? ' FOR UPDATE' : ''}`, [this.deploymentId, namespace]);
        return rows.rows.map((row: unknown) => record(namespace, Row.parse(row).data));
      },
      enrollment: async (subject) => {
        const rows = await query(`SELECT data FROM verdict_mcp.authority_enrollments WHERE deployment_id=$1 AND subject=$2${write ? ' FOR UPDATE' : ''}`, [this.deploymentId, subject]);
        return rows.rowCount === 0 ? null : parse(Enrollment, Row.parse(rows.rows[0]).data);
      },
      put: async (namespace, key, value, expires) => {
        writable(); const data = JSON.stringify(record(namespace, value));
        if (!Number.isSafeInteger(expires) || expires < 0) throw unavailable();
        await query('DELETE FROM verdict_mcp.authority_records WHERE deployment_id=$1 AND expires<$2', [this.deploymentId, Date.now()]);
        const count = await query('SELECT count(*)::integer AS count FROM verdict_mcp.authority_records WHERE deployment_id=$1 AND namespace=$2 AND key<>$3', [this.deploymentId, namespace, key]);
        if (z.object({ count: z.number().int().nonnegative() }).parse(count.rows[0]).count >= 1000) throw new HostedError(503, 'authority_capacity', 'Connections are temporarily busy. Try again later.');
        await query(`INSERT INTO verdict_mcp.authority_records(deployment_id,namespace,key,data,expires) VALUES($1,$2,$3,$4::jsonb,$5)
          ON CONFLICT(deployment_id,namespace,key) DO UPDATE SET data=excluded.data,expires=excluded.expires`, [this.deploymentId, namespace, key, data, expires]);
      },
      enroll: async (subject, profile, value) => { writable(); await query('INSERT INTO verdict_mcp.authority_enrollments(deployment_id,subject,profile,data) VALUES($1,$2,$3,$4::jsonb)', [this.deploymentId, subject, profile, JSON.stringify(parse(Enrollment, value))]); },
      replaceEnrollment: async (subject, profile, value) => { writable(); await query(`INSERT INTO verdict_mcp.authority_enrollments(deployment_id,subject,profile,data) VALUES($1,$2,$3,$4::jsonb)
        ON CONFLICT(deployment_id,subject) DO UPDATE SET profile=excluded.profile,data=excluded.data`, [this.deploymentId, subject, profile, JSON.stringify(parse(Enrollment, value))]); },
    };
    try {
      await query(write ? 'BEGIN' : 'BEGIN READ ONLY'); await query("SET LOCAL statement_timeout='5s'"); await query("SET LOCAL lock_timeout='5s'");
      // Shared readers and every writer coordinate on the same deployment fence, including absent identities.
      for (const key of [...new Set([AUTHORITY_LOCK, ...keys])].sort()) await query(`SELECT pg_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended($1,0))`, [JSON.stringify([this.deploymentId, key])]);
      const marker = await query('SELECT database_id,version FROM verdict_mcp.authority_metadata WHERE deployment_id=$1', [this.deploymentId]);
      if (marker.rowCount !== 1 || parse(Marker, marker.rows[0]).database_id !== this.databaseId) throw unavailable();
      const tables = await query("SELECT to_regclass('verdict_mcp.authority_records') IS NOT NULL AS records,to_regclass('verdict_mcp.authority_enrollments') IS NOT NULL AS enrollments"); parse(Tables, tables.rows[0]);
      const result = await this.scope.run(true, () => body(tx)); await query('COMMIT'); return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure; never recreate authority. */ }
      throw error;
    } finally { active = false; client.release(); }
  }
  read<T>(body: (tx: ConnectReadTx) => Promise<T>): Promise<T> { return this.run(false, [], body); }
  write<T>(keys: readonly string[], body: (tx: ConnectWriteTx) => Promise<T>): Promise<T> { return this.run(true, keys, body); }
  async close(): Promise<void> { this.closed = true; }
}
