import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';

export async function closeTestPool(pool: { end(): Promise<void> }, connections: Iterable<Promise<void>>): Promise<void> {
  // pg-pool removes clients before their sockets finish closing.
  await pool.end();
  await Promise.all(connections);
}

/** One owner per test suite; database deletion never terminates active connections. */
export class PostgresTestPools {
  private readonly connections = new Map<Pool, Set<Promise<void>>>();
  private readonly closing = new Map<Pool, Promise<void>>();

  create(connectionString: string, max: number): Pool {
    const pool = new Pool({ connectionString, max });
    const connections = new Set<Promise<void>>();
    this.connections.set(pool, connections);
    pool.on('connect', client => {
      const ended = new Promise<void>(resolve => { client.once('end', () => { connections.delete(ended); resolve(); }); });
      connections.add(ended);
    });
    return pool;
  }

  end(pool: Pool | undefined): Promise<void> {
    if (!pool) return Promise.resolve();
    const previous = this.closing.get(pool);
    if (previous) return previous;
    const connections = this.connections.get(pool);
    if (!connections) return Promise.resolve();
    const closing = closeTestPool(pool, connections).then(() => { this.connections.delete(pool); });
    this.closing.set(pool, closing);
    return closing;
  }

  async endAllExcept(keep: Pool | undefined): Promise<void> {
    await Promise.all([...this.connections.keys()].filter(pool => pool !== keep).map(pool => this.end(pool)));
  }

  async dropDatabase(admin: Pool, name: string): Promise<void> {
    if (!/^verdict_mcp_test_(?:jobs|auth|e2e)_[a-f0-9]{32}$/.test(name)) throw new Error('Only owned disposable test databases may be removed.');
    await this.endAllExcept(admin);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const result = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name]);
      if (result.rows[0].count === 0) break;
      if (Date.now() >= deadline) throw new Error('Test PostgreSQL connections did not close before database cleanup.');
      await delay(10);
    }
    await admin.query(`DROP DATABASE ${name}`);
  }
}
