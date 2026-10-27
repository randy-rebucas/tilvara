import type { INestApplication } from '@nestjs/common';
import type { OfflineSale, Snapshot } from '@1pos/sync-protocol';
import { billingMail, exportTables } from '@1pos/database';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, ensurePlanPrices, loginToken, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

/**
 * Audit 2026-10-27 (session 45), database fixes (migrations 0134–0135): count sheets post against the book when
 * counted (#7), terminals of a closed business (#28), API key scopes cut to the creator's (#22), billing (#3, #4,
 * #5, #17–#20), the data export without ops' words (#6) and centavo checks on money tables (#13).
 */
let app: INestApplication;
let owner: pg.Pool;
let worker: pg.Pool;
const http = () => request(app.getHttpServer());
type Headers = Record<string, string>;

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  worker = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 2 });
  await ensurePlanPrices(owner);
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await worker.end();
});

/** A VAT shop: Cola ₱22.40 with 10 on hand at B1, a terminal on R1 and a cashier's shift there. */
async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201)).body.id as string;
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'R1' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const cola = (await http().post('/v1/products').set(auth).send({ name: 'Cola', uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SKU'), price: '22.40' }] }).expect(201)).body.variants[0].id as string;
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId, reason: 'Opening', items: [{ variantId: cola, quantity: '10', unitCost: '15.00' }] }).expect(201);
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const cashier = bearer(await loginToken(app, c.email));
  const session = (await http().post('/v1/cashier-sessions').set(cashier).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
  const term = (await http().post('/v1/terminals').set(auth).send({ registerId, name: 'Till 1' }).expect(201)).body;
  const headers: Headers = { 'x-terminal-id': term.terminal.id, Authorization: `Terminal ${term.credential}` };
  return { t, tenantId: t.tenantId, auth, branchId, registerId, cola, cashier, cashierId: c.userId, session, headers };
}
type S = Awaited<ReturnType<typeof shop>>;

const sql = <T = Record<string, unknown>>(s: { tenantId: string }, q: string, params: unknown[] = []) =>
  asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const onHand = async (s: S) =>
  ((await http().get('/v1/stock/balances').query({ branchId: s.branchId, variantId: s.cola }).set(s.auth).expect(200)).body.data[0]?.quantity as string) ?? '0';
const sell = (s: S, quantity: string) =>
  http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), lines: [{ variantId: s.cola, quantity }], tenders: [{ method: 'CASH', tendered: '1000.00' }] })
    .expect(201);
const openSheet = async (s: S) => (await http().post('/v1/stock/count-sheets').set(s.auth).send({ branchId: s.branchId, variantIds: [s.cola] }).expect(201)).body as { id: string };
const countSheet = (s: S, id: string, countedQuantity: string) =>
  http().put(`/v1/stock/count-sheets/${id}/lines`).set(s.auth).send({ lines: [{ variantId: s.cola, countedQuantity }] }).expect(200);
const postSheet = async (s: S, id: string) =>
  (await http().post(`/v1/stock/count-sheets/${id}/post`).set(s.auth).set('Idempotency-Key', randomUUID()).expect(200)).body as {
    count: { lines: { systemQuantity: string; varianceQuantity: string }[] };
  };
const sheetLine = async (s: S, id: string) =>
  (await http().get(`/v1/stock/count-sheets/${id}`).set(s.auth).expect(200)).body.lines[0] as { expectedQuantity: string; movedSinceFreeze: string; varianceQuantity: string | null };
let seq = 0;
const offlineSale = (s: S, snap: Snapshot, occurredAt: string): OfflineSale => {
  seq += 1;
  return {
    terminalTxnId: randomUUID(), deviceSeq: seq, snapshotId: snap.snapshotId, cashierSessionId: s.session, cashierUserId: s.cashierId,
    occurredAt, localReference: `R1-DB45-${String(seq).padStart(6, '0')}`,
    lines: [{ variantId: s.cola, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '50.00' }], amountDue: '44.80',
  };
};

describe('#7 count sheets post against the book when the line was counted (ADR-0012 amendment 3)', () => {
  it('a sale after the freeze and before the count is deducted once, not again as shrink', async () => {
    const s = await shop('db45-sheet');
    const sheet = await openSheet(s);
    await sell(s, '1');
    await countSheet(s, sheet.id, '9');
    expect(await sheetLine(s, sheet.id)).toMatchObject({ expectedQuantity: '10', movedSinceFreeze: '-1', varianceQuantity: '0' });
    // A sale after the count is the counter's stock leaving later: not in the book compared with the count.
    await sell(s, '1');
    expect(await sheetLine(s, sheet.id)).toMatchObject({ movedSinceFreeze: '-1', varianceQuantity: '0' });
    const posted = await postSheet(s, sheet.id);
    // Nothing to correct: the count agreed with the book (9 when counted), so no movement.
    expect(posted.count.lines.map((l) => [l.systemQuantity, l.varianceQuantity])).toEqual([['9', '0']]);
    expect(await onHand(s)).toBe('8');
  });

  it('a counted difference is posted against the book: frozen 10, 2 sold, counted 7 → −1 → 7 on hand', async () => {
    const s = await shop('db45-sheet-diff');
    const sheet = await openSheet(s);
    await sell(s, '2');
    await countSheet(s, sheet.id, '7');
    const posted = await postSheet(s, sheet.id);
    expect(posted.count.lines.map((l) => [l.systemQuantity, l.varianceQuantity])).toEqual([['8', '-1']]);
    expect(await onHand(s)).toBe('7');
  });

  it('an offline sale rung before the freeze and delivered after it counts in the book (it was never in the frozen figure)', async () => {
    const s = await shop('db45-sheet-offline');
    const snap = (await http().get('/v1/terminal/snapshot').set(s.headers).expect(200)).body as Snapshot;
    const rung = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1500)); // the host and the database clocks differ by a fraction of a second
    const sheet = await openSheet(s); // frozen 10, though the shelf already had 8
    const res = await http().post('/v1/sync/sales').set(s.headers).send({ sales: [offlineSale(s, snap, rung)] }).expect(200);
    expect(res.body.results[0].status).toBe('RECORDED');
    await countSheet(s, sheet.id, '8');
    expect(await sheetLine(s, sheet.id)).toMatchObject({ expectedQuantity: '10', movedSinceFreeze: '-2', varianceQuantity: '0' });
    await postSheet(s, sheet.id);
    expect(await onHand(s)).toBe('8');
  });

  it('an offline sale rung after the count but delivered before the posting is not in the book', async () => {
    const s = await shop('db45-sheet-late');
    const snap = (await http().get('/v1/terminal/snapshot').set(s.headers).expect(200)).body as Snapshot;
    const sheet = await openSheet(s);
    await countSheet(s, sheet.id, '10');
    await new Promise((r) => setTimeout(r, 1500)); // the host and the database clocks differ by a fraction of a second
    await http().post('/v1/sync/sales').set(s.headers).send({ sales: [offlineSale(s, snap, new Date().toISOString())] }).expect(200);
    expect(await sheetLine(s, sheet.id)).toMatchObject({ movedSinceFreeze: '0', varianceQuantity: '0' });
    await postSheet(s, sheet.id);
    expect(await onHand(s)).toBe('8');
  });

  it('the freeze keeps the balance’s movement number; every movement is numbered under the lock', async () => {
    const s = await shop('db45-sheet-seq');
    await sell(s, '1');
    const sheet = await openSheet(s);
    const [line] = await sql<{ frozen_seq: string; seq: string }>(s,
      `SELECT l.frozen_seq::text, b.movement_seq::text AS seq FROM stock_count_sheet_lines l JOIN stock_balances b ON b.variant_id = l.variant_id AND b.branch_id = $2 WHERE l.sheet_id = $1`,
      [sheet.id, s.branchId]);
    expect(line).toEqual({ frozen_seq: '2', seq: '2' });
    const moves = await sql<{ type: string; balance_seq: string }>(s, `SELECT type, balance_seq::text FROM stock_movements WHERE variant_id = $1 ORDER BY balance_seq`, [s.cola]);
    expect(moves).toEqual([{ type: 'ADJUSTMENT', balance_seq: '1' }, { type: 'SALE', balance_seq: '2' }]);
    // A caller cannot pick the number: the trigger sets it.
    await http().post(`/v1/stock/count-sheets/${sheet.id}/cancel`).set(s.auth).send({ reason: 'Test done' }).expect(200);
  });
});

describe('#28 a terminal of a business being closed is refused', () => {
  it('OFFBOARDING or CLOSED: no snapshot (nor any terminal route); SUSPENDED still syncs (its sales follow the read-only rules)', async () => {
    const s = await shop('db45-term');
    const setStatus = (status: string) => sql(s, `UPDATE tenants SET status = $2 WHERE id = $1`, [s.tenantId, status]);
    try {
      for (const status of ['OFFBOARDING', 'CLOSED']) {
        await setStatus(status);
        expect((await http().get('/v1/terminal/snapshot').set(s.headers).expect(401)).body.error.code, status).toBe('BUSINESS_CLOSED');
      }
      await setStatus('SUSPENDED');
      const snap = (await http().get('/v1/terminal/snapshot').set(s.headers).expect(200)).body as Snapshot;
      expect(snap.businessWritable).toBe(false);
    } finally {
      await setStatus('ACTIVE');
    }
    await http().get('/v1/terminal/snapshot').set(s.headers).expect(200);
  });
});

describe('#22 an API key reads only what its creator may read now', () => {
  it('a demoted creator’s key loses the scope the creator lost, and keeps the others', async () => {
    const t = await signup(app, 'db45-key');
    await owner.query(`SELECT platform_set_subscription($1, 'enterprise', 'ACTIVE', null, null)`, [t.tenantId]);
    const admin = await addMember(owner, t.tenantId, 'admin');
    const adminAuth = bearer(await loginToken(app, admin.email));
    const made = (await http().post('/v1/api-keys').set(adminAuth).send({ name: 'Books', scopes: ['org.read', 'catalog.read'] }).expect(201)).body;
    const key = { Authorization: `ApiKey ${made.key}` };
    await http().get('/v1/business').set(key).expect(200);
    await http().get('/v1/products').set(key).expect(200);
    // The admin becomes an inventory officer (catalog.read, no org.read).
    await sql(t, `UPDATE membership_roles SET role_id = (SELECT id FROM roles WHERE tenant_id = $1 AND key = 'inventory_officer') WHERE membership_id = $2`, [t.tenantId, admin.membershipId]);
    expect((await http().get('/v1/business').set(key).expect(403)).body.error.details.missing).toEqual(['org.read']);
    await http().get('/v1/products').set(key).expect(200);
    // Made an admin again: the key reads the business again (it never lost the scope, only its creator's right).
    await sql(t, `UPDATE membership_roles SET role_id = (SELECT id FROM roles WHERE tenant_id = $1 AND key = 'admin') WHERE membership_id = $2`, [t.tenantId, admin.membershipId]);
    await http().get('/v1/business').set(key).expect(200);
  });
});

describe('billing (ADR-0027, audit 45)', () => {
  const bills = async (t: SignedUp) => (await http().get('/v1/subscription/bills').set(bearer(t.access)).expect(200)).body.data as {
    id: string; number: string; kind: string; planCode: string; amount: string; status: string; periodStart: string; periodEnd: string;
  }[];
  const choose = (t: SignedUp, planCode: string) => http().put('/v1/subscription/plan').set(bearer(t.access)).send({ planCode }).expect(200).then((r) => r.body as { effect: string; billId?: string });
  const setSubscription = (t: SignedUp, plan: string, status: string, periodEnd: Date | null) =>
    owner.query('SELECT platform_set_subscription($1, $2, $3, $4, null)', [t.tenantId, plan, status, periodEnd]);
  /** The hourly pass; another run holding it (a parallel test file) only delays this one. */
  const tick = async (): Promise<Record<string, number>> => {
    for (let i = 0; i < 50; i++) {
      const r = (await owner.query<{ r: Record<string, number> }>('SELECT platform_billing_tick() AS r')).rows[0]!.r;
      if (!r.skipped) return r;
      await new Promise((res) => setTimeout(res, 200));
    }
    throw new Error('the billing pass stayed held');
  };
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);
  const openPage = async (t: SignedUp, billId: string) =>
    new URL((await http().post(`/v1/subscription/bills/${billId}/checkout`).set(bearer(t.access)).expect(200)).body.url).searchParams.get('id')!;
  const pay = async (t: SignedUp, billId: string) => {
    const id = await openPage(t, billId);
    await http().post('/v1/billing/dev-checkout/pay').query({ id }).type('form').send({ method: 'GCASH' }).expect(303);
  };

  it('#4 the same upgrade chosen again returns its open bill; another plan cancels it (#3) and closes its page', async () => {
    const t = await signup(app, 'db45-upg');
    await setSubscription(t, 'growth', 'ACTIVE', inDays(15));
    const first = await choose(t, 'enterprise');
    const again = await choose(t, 'enterprise');
    expect(again).toEqual({ effect: 'BILL', billId: first.billId });
    expect((await bills(t)).map((b) => [b.kind, b.status])).toEqual([['UPGRADE', 'OPEN']]);
    const page = await openPage(t, first.billId!);
    await http().get('/v1/billing/dev-checkout').query({ id: page }).expect(200);
    // Starter at renewal: the upgrade is cancelled, and its payment page with it (here, and at PayMongo via the worker).
    expect((await choose(t, 'starter')).effect).toBe('AT_RENEWAL');
    expect((await bills(t))[0]).toMatchObject({ status: 'VOID' });
    const events = await sql<{ payload: { providerCheckoutId: string; provider: string } }>(t, `SELECT payload FROM outbox_events WHERE topic = 'billing.checkout_expired'`);
    expect(events.map((e) => [e.payload.provider, e.payload.providerCheckoutId])).toEqual([['DEV', page]]);
    expect((await http().get('/v1/billing/dev-checkout').query({ id: page }).expect(410)).body.error.code).toBe('CHECKOUT_EXPIRED');
    await http().post('/v1/billing/dev-checkout/pay').query({ id: page }).type('form').send({ method: 'GCASH' }).expect(410);
  });

  it('#18 an upgrade after a renewal paid early pays the rest of this period and the whole paid one after it', async () => {
    const t = await signup(app, 'db45-prorate');
    await setSubscription(t, 'growth', 'ACTIVE', inDays(5));
    await tick();
    const [renewal] = await bills(t);
    expect(renewal).toMatchObject({ kind: 'RENEWAL', status: 'OPEN' });
    await pay(t, renewal!.id);
    const up = await choose(t, 'enterprise');
    const bill = (await bills(t)).find((b) => b.id === up.billId)!;
    // (4999 − 1499) × (5 days of 30 + the paid month) ≈ 3500 × 1.17 ≈ 4083; it was capped at one month (3500) before.
    expect(Number(bill.amount)).toBeGreaterThan(3950);
    expect(Number(bill.amount)).toBeLessThan(4200);
  });

  it('#19 periods end on the anchor’s day of the month in Philippine time', async () => {
    const end = async (anchor: string, start: string) =>
      new Date((await owner.query<{ e: Date }>('SELECT billing_period_end($1::timestamptz, $2::timestamptz) AS e', [anchor, start])).rows[0]!.e).toISOString();
    const a = '2026-01-31T10:00:00+08:00';
    expect(await end(a, a)).toBe('2026-02-28T02:00:00.000Z');
    expect(await end(a, '2026-02-28T10:00:00+08:00')).toBe('2026-03-31T02:00:00.000Z');
    expect(await end(a, '2026-03-31T10:00:00+08:00')).toBe('2026-04-30T02:00:00.000Z');
    expect(await end('2028-01-31T10:00:00+08:00', '2028-01-31T10:00:00+08:00')).toBe('2028-02-29T02:00:00.000Z');
    // Late evening in Manila is still that day (in UTC it is the day before).
    expect(await end('2026-01-31T23:30:00+08:00', '2026-01-31T23:30:00+08:00')).toBe('2026-02-28T15:30:00.000Z');
    // A start off the anchor's days (set by ops) starts a new sequence: a month on from it.
    expect(await end(a, '2026-02-10T10:00:00+08:00')).toBe('2026-03-10T02:00:00.000Z');
    // The renewal follows the anchor: paid until Feb 28 from a Jan 31 start → renewal to Mar 31.
    const t = await signup(app, 'db45-anchor');
    await setSubscription(t, 'growth', 'ACTIVE', inDays(3));
    const paidUntil = inDays(3);
    await sql(t, `UPDATE subscriptions SET current_period_end = $1, billing_anchor_at = $1::timestamptz - interval '1 month'`, [paidUntil]);
    await tick();
    const [renewal] = await bills(t);
    const [expected] = (await owner.query<{ e: Date }>(`SELECT billing_period_end($1::timestamptz - interval '1 month', $1::timestamptz) AS e`, [paidUntil])).rows;
    expect(new Date(renewal!.periodEnd).getTime()).toBe(new Date(expected!.e).getTime());
  });

  it('#20 a trial that lapsed more than a week ago gets no first bill; one that ended this week does', async () => {
    const old = await signup(app, 'db45-trial-old');
    await sql(old, `UPDATE subscriptions SET trial_ends_at = now() - interval '10 days'`);
    const recent = await signup(app, 'db45-trial-new');
    await sql(recent, `UPDATE subscriptions SET trial_ends_at = now() - interval '2 days'`);
    await tick();
    expect(await bills(old)).toEqual([]);
    expect((await bills(recent)).map((b) => b.kind)).toEqual(['START']);
  });

  it('#17 a scheduled cheaper plan the business outgrew is dropped at renewal: billed on its plan, the owners told', async () => {
    const t = await signup(app, 'db45-down');
    await setSubscription(t, 'growth', 'ACTIVE', inDays(20));
    expect((await choose(t, 'starter')).effect).toBe('AT_RENEWAL');
    const auth = bearer(t.access);
    const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Down Corp', vatStatus: 'VAT' }).expect(201)).body.id;
    await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201);
    await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B2', name: 'Two', birBranchCode: '00002' }).expect(201);
    await setSubscription(t, 'growth', 'ACTIVE', inDays(5));
    await tick();
    expect((await bills(t)).map((b) => [b.kind, b.planCode])).toEqual([['RENEWAL', 'growth']]);
    expect((await http().get('/v1/subscription').set(auth).expect(200)).body.scheduledPlan).toBeNull();
    const [event] = await sql<{ payload: Record<string, string> }>(t, `SELECT payload FROM outbox_events WHERE topic = 'billing.downgrade_dropped'`);
    expect(event!.payload).toMatchObject({ plan: 'starter', limit: 'maxBranches' });
    const c = await worker.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
      const mail = await billingMail(c, 'billing.downgrade_dropped', event!.payload);
      expect(mail!.subject).toBe('Your Tilvara plan stays the same: the business no longer fits Starter');
      expect(mail!.text).toContain('more branches than that plan allows');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('#5 the pass runs once at a time and reports the businesses it had to skip', async () => {
    const r = await tick();
    expect(r).toHaveProperty('errors', 0);
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform_billing_tick', 0))`);
      expect((await owner.query<{ r: Record<string, number> }>('SELECT platform_billing_tick() AS r')).rows[0]!.r).toEqual({ skipped: 1 });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('#6 the business’s data export leaves out ops’ own words; the worker cannot read them', async () => {
    const t = await signup(app, 'db45-export');
    const { billId } = await choose(t, 'growth');
    const [b] = await sql<{ slug: string; number: string }>(t, `SELECT t.slug, b.number FROM tenants t JOIN billing_bills b ON b.tenant_id = t.id WHERE b.id = $1`, [billId]);
    await owner.query(`SELECT platform_billing_void_bill($1, $2, 'ops-staff', 'Waived for the pilot', 'T-45')`, [b!.slug, b!.number]);
    const c = await worker.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
      for (const q of ['SELECT void_reason FROM billing_bills', 'SELECT note FROM billing_payments', 'SELECT recorded_by FROM billing_payments']) {
        await c.query('SAVEPOINT s');
        expect(String(await c.query(q).catch((e: Error) => e)), q).toMatch(/permission denied/);
        await c.query('ROLLBACK TO SAVEPOINT s');
      }
      expect((await c.query('SELECT status FROM billing_bills')).rows).toEqual([{ status: 'VOID' }]);
      const tables = await exportTables(c);
      expect(tables.find((x) => x.name === 'billing_bills')!.columns).not.toContain('void_reason');
      expect(tables.find((x) => x.name === 'billing_payments')!.columns).not.toEqual(expect.arrayContaining(['note']));
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('#13 money tables hold centavos only', () => {
  it('sale tenders, cash movements, store credit and payment intents refuse a fraction of a centavo', async () => {
    const { rows } = await owner.query<{ name: string; validated: boolean }>(
      `SELECT conname AS name, convalidated AS validated FROM pg_constraint WHERE conname IN ('sale_tenders_centavos', 'cash_movements_centavos', 'customer_credit_entries_centavos', 'payment_intents_centavos') ORDER BY 1`);
    expect(rows).toEqual([
      { name: 'cash_movements_centavos', validated: true },
      { name: 'customer_credit_entries_centavos', validated: true },
      { name: 'payment_intents_centavos', validated: true },
      { name: 'sale_tenders_centavos', validated: true },
    ]);
    const s = await shop('db45-cents');
    const insert = (amount: string) =>
      sql(s, `INSERT INTO cash_movements (tenant_id, cashier_session_id, type, amount, reason, created_by) VALUES ($1, $2, 'PAY_IN', $3, 'test', $4)`, [s.tenantId, s.session, amount, s.t.userId]);
    expect(String(await insert('10.005').catch((e: Error) => e))).toMatch(/cash_movements_centavos/);
  });
});
