import type { INestApplication } from '@nestjs/common';
import type { OfflineSale, Snapshot } from '@1pos/sync-protocol';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Audit 2026-10-27 (session 45), platform fixes: API keys on routes every member may read (#21), an
 * offline sale re-priced as of its snapshot ignores a tax profile made after it (#12a), held lots drawn
 * by an offline sale at an ALLOW branch are reported (#30), an exchange naming a sale line twice is a
 * validation error (#31), and money that changes hands takes centavos at most (#13).
 */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
type Headers = Record<string, string>;

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

const day = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86_400_000));

/** A VAT shop (no inventory settings: expired stock ALLOW) with a cashier's shift on R1 and a terminal for R1. */
async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201)).body.id as string;
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'R1' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, tracksExpiry = false) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: vat, trackInventory: true, tracksExpiry, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const cashier = bearer(await loginToken(app, c.email));
  const session = (await http().post('/v1/cashier-sessions').set(cashier).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
  const term = (await http().post('/v1/terminals').set(auth).send({ registerId, name: 'Till 1' }).expect(201)).body;
  const headers: Headers = { 'x-terminal-id': term.terminal.id, Authorization: `Terminal ${term.credential}` };
  return { t, tenantId: t.tenantId, auth, le, branchId, registerId, product, cashier, cashierId: c.userId, session, headers };
}
type S = Awaited<ReturnType<typeof shop>>;

const sql = <T = Record<string, unknown>>(s: S, q: string, params: unknown[] = []) => asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const snapshot = async (s: S) => (await http().get('/v1/terminal/snapshot').set(s.headers).expect(200)).body as Snapshot;
let seq = 0;
const offline = (s: S, snap: Snapshot, over: Partial<OfflineSale>): OfflineSale => {
  seq += 1;
  return {
    terminalTxnId: randomUUID(), deviceSeq: seq, snapshotId: snap.snapshotId, cashierSessionId: s.session, cashierUserId: s.cashierId,
    occurredAt: new Date().toISOString(), localReference: `R1-A45-${String(seq).padStart(6, '0')}`, lines: [], tenders: [], amountDue: '0.00', ...over,
  };
};
const stockIn = (s: S, items: Record<string, unknown>[]) =>
  http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Delivery', items: items.map((i) => ({ unitCost: '2.00', ...i })) }).expect(201);

describe('API keys on routes every member reads (#21)', () => {
  it('the business and its branding need org.read from a key; members and support read them as before', async () => {
    const s = await shop('a45-keys');
    await owner.query(`SELECT platform_set_subscription($1, 'enterprise', 'ACTIVE', null, null)`, [s.tenantId]);
    const key = async (scopes: string[]) => ({ Authorization: `ApiKey ${(await http().post('/v1/api-keys').set(s.auth).send({ name: uniq('k'), scopes }).expect(201)).body.key}` });
    const narrow = await key(['customers.read']);
    const org = await key(['org.read']);
    for (const path of ['/v1/business', '/v1/business/branding', '/v1/business/branding/logo', '/v1/business/branding/background']) {
      const refused = (await http().get(path).set(narrow).expect(403)).body.error;
      expect([path, refused.code, refused.details?.missing]).toEqual([path, 'FORBIDDEN', ['org.read']]);
    }
    expect((await http().get('/v1/business').set(org).expect(200)).body.id).toBe(s.tenantId);
    await http().get('/v1/business/branding').set(org).expect(200);
    await http().get('/v1/business/branding/logo').set(org).expect(404); // no logo yet: past the guard
    // A cashier (no org.read) still reads the shop's branding (the browser till does after sign-in).
    await http().get('/v1/business/branding').set(s.cashier).expect(200);
    await http().get('/v1/business').set(s.cashier).expect(200);
  });
});

describe('offline re-pricing as of the snapshot (#12a)', () => {
  it('a tax profile made after the snapshot, back-dated before it, is not used for the sale', async () => {
    const s = await shop('a45-profile');
    const cola = await s.product('Cola', '22.40');
    await stockIn(s, [{ variantId: cola, quantity: '10' }]);
    const snap = await snapshot(s);
    // The snapshot cut 20 s ago (the prices and the first profile were made a day before it).
    await sql(s, `
      ALTER TABLE product_prices DISABLE TRIGGER product_prices_append_only;
      ALTER TABLE tax_profiles DISABLE TRIGGER tax_profiles_append_only;
      ALTER TABLE terminal_snapshots DISABLE TRIGGER terminal_snapshots_append_only;
      UPDATE product_prices SET effective_from = effective_from - interval '1 day', created_at = created_at - interval '1 day';
      UPDATE tax_profiles SET effective_from = effective_from - interval '1 day', created_at = created_at - interval '1 day';
      UPDATE terminal_snapshots SET as_of = now() - interval '20 seconds' WHERE id = '${snap.snapshotId}';
      ALTER TABLE product_prices ENABLE TRIGGER product_prices_append_only;
      ALTER TABLE tax_profiles ENABLE TRIGGER tax_profiles_append_only;
      ALTER TABLE terminal_snapshots ENABLE TRIGGER terminal_snapshots_append_only;`);
    const [vatProfile] = await sql<{ id: string }>(s, `SELECT id FROM tax_profiles WHERE legal_entity_id = $1`, [s.le]);
    // Now the entity leaves VAT, back-dated 40 s (inside the minute allowed): before the snapshot.
    const back = (await sql<{ at: Date }>(s, `SELECT now() - interval '40 seconds' AS at`))[0]!.at;
    await http().post(`/v1/legal-entities/${s.le}/tax-profiles`).set(s.auth).send({ vatStatus: 'NON_VAT', effectiveFrom: back.toISOString() }).expect(201);

    // Rung on the till with its snapshot's VAT profile: recorded with that profile, flagged PRICE_CHANGED.
    const r = (await http().post('/v1/sync/sales').set(s.headers).send({ sales: [offline(s, snap, {
      lines: [{ variantId: cola, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '50.00' }], amountDue: '44.80',
    })] }).expect(200)).body.results[0];
    expect([r.status, r.flags]).toEqual(['RECORDED', ['PRICE_CHANGED']]);
    const [sale] = await sql<{ tax_profile_id: string; vat_amount: string }>(s, `SELECT tax_profile_id, vat_amount::text FROM sales WHERE id = $1`, [r.saleId]);
    expect(sale).toEqual({ tax_profile_id: vatProfile!.id, vat_amount: '4.8000' });
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });
});

describe('held lots drawn offline at an ALLOW branch (#30)', () => {
  it('the sale is recorded, the keepers are told and the audit row counts the lots', async () => {
    const s = await shop('a45-held');
    const tea = await s.product('Green tea', '5.50', true);
    await stockIn(s, [{ variantId: tea, quantity: '3', expiresOn: day(200), lotCode: 'REC-1' }]);
    await http().post('/v1/stock/lot-holds').set(s.auth).set('Idempotency-Key', randomUUID()).send({ variantId: tea, lotCode: 'REC-1', reason: 'Supplier recall' }).expect(201);
    const snap = await snapshot(s);
    const r = (await http().post('/v1/sync/sales').set(s.headers).send({ sales: [offline(s, snap, {
      lines: [{ variantId: tea, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '11.00' }], amountDue: '11.00',
    })] }).expect(200)).body.results[0];
    expect(r.status).toBe('RECORDED');
    const events = await sql<{ payload: { saleId: string; lots: number } }>(s, `SELECT payload FROM outbox_events WHERE topic = 'stock.expired_sold'`);
    expect(events.map((e) => [e.payload.saleId, e.payload.lots])).toEqual([[r.saleId, 1]]);
    const [row] = await sql<{ metadata: { expiredStockLots?: number } }>(s, `SELECT metadata FROM audit_logs WHERE action = 'sale.completed' AND resource_id = $1`, [r.saleId]);
    expect(row!.metadata.expiredStockLots).toBe(1);
  });
});

describe('exchanges and money inputs (#31, #13)', () => {
  it('an exchange naming a sale line twice is refused as a validation error, not a 500', async () => {
    const s = await shop('a45-exch');
    const id = randomUUID();
    const res = await http().post('/v1/exchanges').set(s.cashier).set('Idempotency-Key', randomUUID()).send({
      cashierSessionId: s.session, saleId: randomUUID(), reason: 'Size',
      returnLines: [{ saleLineId: id, quantity: '1', disposition: 'RESTOCK' }, { saleLineId: id, quantity: '1', disposition: 'RESTOCK' }],
      sale: { clientTransactionId: randomUUID(), lines: [{ variantId: randomUUID(), quantity: '1' }] },
    }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('tenders, payment intents, pay in/out, the float and the count take at most two decimal places', async () => {
    const s = await shop('a45-money');
    const cola = await s.product('Cola', '22.40');
    const refused = async (req: request.Test) => expect((await req.expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    await refused(http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), lines: [{ variantId: cola, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '22.405' }] }));
    await refused(http().post('/v1/payment-intents').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), method: 'CARD', amount: '10.005' }));
    await refused(http().post(`/v1/cashier-sessions/${s.session}/movements`).set(s.cashier).set('Idempotency-Key', randomUUID()).send({ type: 'PAY_IN', amount: '5.125', reason: 'Change fund' }));
    await refused(http().post(`/v1/cashier-sessions/${s.session}/close`).set(s.cashier).set('Idempotency-Key', randomUUID()).send({ countedCash: '1000.001' }));
    await refused(http().post('/v1/cashier-sessions').set(s.auth).send({ registerId: s.registerId, openingFloat: '100.0001' }));
    // Two places are fine, as before.
    await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), lines: [{ variantId: cola, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '22.40' }] }).expect(201);
    expect(await sql(s, `SELECT count(*)::int AS n FROM cash_movements WHERE type IN ('PAY_IN', 'PAY_OUT')`)).toEqual([{ n: 0 }]);
  });
});
