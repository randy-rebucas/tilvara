import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, bindDatabase, createTenant, InvalidTenantContextError, tenants, withTenant } from '../../src/index.js';
import { TEST_DATABASE_MIGRATOR_URL, TEST_DATABASE_URL } from './env.js';

const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
const slug = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

/** Drizzle wraps driver errors ("Failed query: …"); return the underlying Postgres error. */
async function pgError(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { cause?: { code?: string; message: string }; code?: string; message: string };
    return err.cause ?? err;
  }
  throw new Error('expected the operation to fail');
}

let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  tenantA = await createTenant(pool, { slug: slug('alpha'), name: 'Alpha Mart' });
  tenantB = await createTenant(pool, { slug: slug('bravo'), name: 'Bravo Cafe' });
});

afterAll(async () => {
  await pool.end();
});

describe('runtime role', () => {
  it('is not a superuser and cannot bypass RLS', async () => {
    const { rows } = await pool.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('tenant isolation (RLS)', () => {
  it('sees no tenant rows without a tenant context (fail closed)', async () => {
    const { rows } = await pool.query('SELECT id FROM tenants');
    expect(rows).toHaveLength(0);
    const audit = await pool.query('SELECT id FROM audit_logs');
    expect(audit.rows).toHaveLength(0);
  });

  it('sees only its own tenant row', async () => {
    const rows = await withTenant(pool, tenantA, (db) => db.select().from(tenants));
    expect(rows.map((r) => r.id)).toEqual([tenantA]);
  });

  it('each transaction gets a database bound to its own connection, cheaply (schema config built once)', async () => {
    // Two transactions at once, each with its own tenant: builder and relational API both see only their own.
    const [a, b] = await Promise.all([
      withTenant(pool, tenantA, async (db) => [(await db.select().from(tenants)).map((r) => r.id), (await db.query.tenants.findMany()).map((r) => r.id)]),
      withTenant(pool, tenantB, async (db) => [(await db.select().from(tenants)).map((r) => r.id), (await db.query.tenants.findMany()).map((r) => r.id)]),
    ]);
    expect([a, b]).toEqual([[[tenantA], [tenantA]], [[tenantB], [tenantB]]]);
    // ADR-0016 slice 5: rebuilding drizzle's relational config per transaction was the API's main CPU
    // cost. Binding must stay far below that (~ms per call for ~90 tables): 2,000 binds in well under a second.
    const fake = {} as pg.PoolClient;
    const t = performance.now();
    for (let i = 0; i < 2000; i++) bindDatabase(fake);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('cannot read another tenant by id', async () => {
    const rows = await withTenant(pool, tenantA, (db) => db.select().from(tenants).where(eq(tenants.id, tenantB)));
    expect(rows).toHaveLength(0);
  });

  it('cannot update another tenant (0 rows affected)', async () => {
    const updated = await withTenant(pool, tenantA, (db) =>
      db.update(tenants).set({ name: 'pwned' }).where(eq(tenants.id, tenantB)).returning(),
    );
    expect(updated).toHaveLength(0);
    const b = await withTenant(pool, tenantB, (db) => db.select().from(tenants));
    expect(b[0]!.name).toBe('Bravo Cafe');
  });

  it('cannot insert tenants directly (provisioning goes through the platform function)', async () => {
    await expect(
      withTenant(pool, tenantA, (db) => db.insert(tenants).values({ slug: slug('rogue'), name: 'Rogue' })),
    ).rejects.toThrow();
  });

  it('cannot write audit rows for another tenant', async () => {
    const err = await pgError(
      withTenant(pool, tenantA, (db) =>
        db.insert(auditLogs).values({ tenantId: tenantB, actorType: 'USER', action: 'x', resourceType: 'y' }),
      ),
    );
    expect(err.message).toMatch(/row-level security/);
  });

  it('only sees its own audit rows (provisioning event recorded per tenant)', async () => {
    const rows = await withTenant(pool, tenantA, (db) => db.select().from(auditLogs));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === tenantA)).toBe(true);
    expect(rows.some((r) => r.action === 'tenant.created')).toBe(true);
  });

  it('rejects a non-UUID tenant context before touching the database', async () => {
    await expect(withTenant(pool, "x' OR 1=1 --", async () => 1)).rejects.toBeInstanceOf(InvalidTenantContextError);
  });
});

describe('connection-pool context leakage', () => {
  it('drops tenant context when the transaction ends, on the same physical connection', async () => {
    const single = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      const inside = await withTenant(single, tenantA, async (_db, client) => {
        const r = await client.query("SELECT current_setting('app.tenant_id', true) AS t, pg_backend_pid() AS pid");
        return r.rows[0] as { t: string; pid: number };
      });
      expect(inside.t).toBe(tenantA);

      const after = await single.query(
        "SELECT coalesce(current_setting('app.tenant_id', true), '') AS t, pg_backend_pid() AS pid",
      );
      expect(after.rows[0].pid).toBe(inside.pid); // same pooled connection
      expect(after.rows[0].t).toBe('');
      const visible = await single.query('SELECT id FROM tenants');
      expect(visible.rows).toHaveLength(0);
    } finally {
      await single.end();
    }
  });

  it('drops tenant context after a rollback too', async () => {
    const single = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      await expect(
        withTenant(single, tenantA, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const visible = await single.query('SELECT id FROM tenants');
      expect(visible.rows).toHaveLength(0);
    } finally {
      await single.end();
    }
  });
});

describe('audit log immutability', () => {
  it('rejects UPDATE and DELETE even within the owning tenant', async () => {
    await withTenant(pool, tenantA, (db) =>
      db.insert(auditLogs).values({ tenantId: tenantA, actorType: 'SYSTEM', action: 'test.event', resourceType: 'test' }),
    );
    // The app role has no UPDATE/DELETE grant at all ...
    const upd = await pgError(
      withTenant(pool, tenantA, (db) => db.update(auditLogs).set({ action: 'tampered' }).where(eq(auditLogs.tenantId, tenantA))),
    );
    expect(upd.message).toMatch(/permission denied/);
    const del = await pgError(withTenant(pool, tenantA, (db) => db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantA))));
    expect(del.message).toMatch(/permission denied/);
  });

  it('blocks UPDATE/DELETE by trigger even for the schema owner', async () => {
    const owner = new pg.Pool({ connectionString: TEST_DATABASE_MIGRATOR_URL, max: 1 });
    try {
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
        await expect(client.query("UPDATE audit_logs SET action = 'tampered'")).rejects.toThrow(/append-only/);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
        await expect(client.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
        await client.query('ROLLBACK');
        await expect(client.query('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
      } finally {
        client.release();
      }
    } finally {
      await owner.end();
    }
  });
});

describe('platform_create_tenant', () => {
  it('rejects duplicate and malformed slugs', async () => {
    const s = slug('dup');
    await createTenant(pool, { slug: s, name: 'One' });
    await expect(createTenant(pool, { slug: s, name: 'Two' })).rejects.toThrow();
    await expect(createTenant(pool, { slug: 'Bad Slug!', name: 'Bad' })).rejects.toThrow();
  });
});
