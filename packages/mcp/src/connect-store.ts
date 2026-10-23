import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HostedError } from './hosted-model.js';
import { opaque } from './connect-model.js';

type Parser<T> = { parse(value: unknown): T };
const unavailable = () => new HostedError(503, 'authority_storage', 'Authorization state is unavailable. Restore the original private state; never recreate it to recover access.');
function privateFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600) throw unavailable();
  return { dev: stat.dev, ino: stat.ino };
}
function read(path: string): string {
  privateFile(path); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (fstatSync(fd).size > 256) throw unavailable(); return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
function create(path: string, contents: string) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Single-instance durable authority. Only hashes of bearer secrets enter this database. */
export class ConnectStore {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private readonly marker: string;
  private readonly id: string;
  private readonly identity: { dev: number; ino: number };
  private closed = false;

  constructor(private readonly root: string) {
    let db: DatabaseSync | undefined;
    try {
      mkdirSync(root, { mode: 0o700, recursive: true });
      this.path = join(root, 'authority.sqlite'); this.marker = join(root, '.authority-initialized');
      this.directory();
      const existing = existsSync(this.marker);
      if (existing !== existsSync(this.path)) throw unavailable();
      if (!existing) { create(this.marker, opaque()); create(this.path, ''); }
      this.id = read(this.marker); this.identity = privateFile(this.path);
      const sqlite: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite');
      db = new sqlite.DatabaseSync(this.path);
      db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE;');
      // Keep the SQLite file lock for this connection's lifetime. Two authority processes
      // must never interleave revocation with another process's order-claim boundary.
      db.exec('BEGIN EXCLUSIVE; COMMIT;');
      if (!existing) {
        db.exec('BEGIN IMMEDIATE; CREATE TABLE metadata(id TEXT NOT NULL) STRICT; CREATE TABLE records(namespace TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(namespace,key)) STRICT; CREATE TABLE enrollments(subject TEXT PRIMARY KEY,profile TEXT NOT NULL UNIQUE,data TEXT NOT NULL) STRICT;');
        db.prepare('INSERT INTO metadata VALUES (?)').run(this.id); db.exec('COMMIT');
        const fd = openSync(root, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      const metadata = db.prepare('SELECT id FROM metadata').all();
      if (metadata.length !== 1 || metadata[0]?.id !== this.id || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw unavailable();
      this.db = db;
    } catch { try { db?.close(); } catch { /* Preserve storage failure. */ } throw unavailable(); }
  }
  private directory() {
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) throw unavailable();
  }
  private guard() {
    if (this.closed) throw unavailable();
    this.directory(); const identity = privateFile(this.path);
    if (identity.dev !== this.identity.dev || identity.ino !== this.identity.ino || read(this.marker) !== this.id) throw unavailable();
  }
  transaction<T>(operation: () => T): T {
    this.guard(); this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get<T>(namespace: string, key: string, schema: Parser<T>): T | null {
    this.guard(); const row = this.db.prepare('SELECT data FROM records WHERE namespace=? AND key=?').get(namespace, key);
    if (!row) return null;
    try { if (typeof row.data !== 'string' || row.data.length > 1_048_576) throw unavailable(); return schema.parse(JSON.parse(row.data)); } catch { throw unavailable(); }
  }
  all<T>(namespace: string, schema: Parser<T>): T[] {
    this.guard(); const rows = this.db.prepare('SELECT key FROM records WHERE namespace=?').all(namespace);
    return rows.map((row) => { if (typeof row.key !== 'string') throw unavailable(); const value = this.get(namespace, row.key, schema); if (value === null) throw unavailable(); return value; });
  }
  put(namespace: string, key: string, value: unknown, expires: number) {
    this.guard();
    this.db.prepare('DELETE FROM records WHERE expires<?').run(Date.now());
    if (!this.db.prepare('SELECT key FROM records WHERE namespace=? AND key=?').get(namespace, key)) {
      const count = this.db.prepare('SELECT count(*) AS count FROM records WHERE namespace=?').get(namespace)?.count;
      if (typeof count !== 'number' || count >= 1000) throw new HostedError(503, 'authority_capacity', 'Connections are temporarily busy. Try again later.');
    }
    this.db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET data=excluded.data,expires=excluded.expires').run(namespace, key, JSON.stringify(value), expires);
  }
  enrollment<T>(subject: string, schema: Parser<T>): T | null {
    this.guard(); const row = this.db.prepare('SELECT data FROM enrollments WHERE subject=?').get(subject);
    if (!row) return null;
    try { if (typeof row.data !== 'string') throw unavailable(); return schema.parse(JSON.parse(row.data)); } catch { throw unavailable(); }
  }
  enroll(subject: string, profile: string, value: unknown) {
    this.guard(); this.db.prepare('INSERT INTO enrollments VALUES (?,?,?)').run(subject, profile, JSON.stringify(value));
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
