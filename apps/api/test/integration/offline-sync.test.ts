import type { INestApplication } from '@nestjs/common';
import type { OfflineSale, Snapshot } from '@1pos/sync-protocol';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { SyncService } from '../../src/sync/sync.service.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/** Offline cash sales and sync (ADR-0015 — Phase 5 slice 1): terminal auth, snapshot, sync, quarantine. */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

type Headers = Record<string, string>;

/** A VAT shop with Cola ₱22.40 (stocked) on R1, a terminal for R1, and a cashier's shift opened online. */
async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const register = async (code: string) => (await http().post('/v1/registers').set(auth).send({ branchId, code, name: code }).expect(201)).body.id as string;
  const [r1, r2] = [await register('R1'), await register('R2')];
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const cola = await product('Cola', '22.40');
  const chips = await product('Chips', '35.00');
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId, reason: 'Opening', items: [{ variantId: cola, quantity: '20', unitCost: '15.00' }, { variantId: chips, quantity: '20', unitCost: '20.00' }] }).expect(201);
  const terminal = async (registerId: string) => {
    const res = (await http().post('/v1/terminals').set(auth).send({ registerId, name: `Till ${registerId.slice(-4)}` }).expect(201)).body;
    return { id: res.terminal.id as string, headers: { 'x-terminal-id': res.terminal.id, Authorization: `Terminal ${res.credential}` } as Headers };
  };
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const cashier = bearer(await loginToken(app, c.email));
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: branchId });
  const manager = bearer(await loginToken(app, m.email));
  const session = (await http().post('/v1/cashier-sessions').set(cashier).send({ registerId: r1, openingFloat: '1000.00' }).expect(201)).body;
  return { tenantId: t.tenantId, auth, branchId, r1, r2, cola, chips, cashier, cashierId: c.userId, cashierMembership: c.membershipId, manager, session, t1: await terminal(r1), t2: await terminal(r2) };
}
type S = Awaited<ReturnType<typeof shop>>;

const sql = <T = Record<string, unknown>>(s: S, q: string, params: unknown[] = []) => asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const snapshot = async (s: S, t = s.t1) => (await http().get('/v1/terminal/snapshot').set(t.headers).expect(200)).body as Snapshot;
const sync = (t: S['t1'], sales: OfflineSale[]) => http().post('/v1/sync/sales').set(t.headers).send({ sales });
let seq = 0;
function sale(s: S, snap: Snapshot, over: Partial<OfflineSale> = {}): OfflineSale {
  seq += 1;
  return {
    terminalTxnId: randomUUID(), deviceSeq: seq, snapshotId: snap.snapshotId, cashierSessionId: s.session.id, cashierUserId: s.cashierId,
    occurredAt: new Date().toISOString(), localReference: `R1-T${snap.terminal.credentialHint}-${String(seq).padStart(6, '0')}`,
    lines: [{ variantId: s.cola, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '50.00' }], amountDue: '44.80', ...over,
  };
}
const audit = (s: S) => asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c));

describe('terminal authentication and snapshot', () => {
  it('a registered terminal gets its register’s priced items, tax profile and open shift; a wrong or revoked credential gets nothing', async () => {
    const s = await shop('off-snap');
    const snap = await snapshot(s);
    expect(snap).toMatchObject({ register: { id: s.r1, code: 'R1' }, currency: 'PHP', taxProfile: { vatStatus: 'VAT', vatRate: '0.12', roundingMode: 'HALF_UP' }, openSession: { id: s.session.id, openedBy: s.cashierId } });
    expect(snap.items.map((i) => [i.name, i.unitPrice, i.priceIncludesTax, i.vatTreatment, i.wholeUnits, i.trackInventory]).sort()).toEqual([
      ['Chips', '35.0000', true, 'VATABLE', true, true], ['Cola', '22.4000', true, 'VATABLE', true, true],
    ]);
    expect(new Date(snap.validUntil).getTime() - new Date(snap.asOf).getTime()).toBe(24 * 3_600_000);
    expect(await sql(s, `SELECT count(*)::int AS n FROM terminal_snapshots WHERE id = $1 AND terminal_id = $2`, [snap.snapshotId, s.t1.id])).toEqual([{ n: 1 }]);
    // R2's terminal sees no shift (it is on R1).
    expect((await snapshot(s, s.t2)).openSession).toBeNull();

    await http().get('/v1/terminal/snapshot').expect(401);
    await http().get('/v1/terminal/snapshot').set({ ...s.t1.headers, Authorization: 'Terminal tpk_wrong' }).expect(401);
    await http().get('/v1/terminal/snapshot').set({ ...s.t1.headers, 'x-terminal-id': 'not-a-uuid' }).expect(401);
    await http().get('/v1/terminal/snapshot').set({ Authorization: s.t1.headers.Authorization!, 'x-terminal-id': s.t2.id }).expect(401); // another terminal's id
    await http().get('/v1/terminal/snapshot').set(s.cashier).expect(401); // a user token is not a terminal
    await http().post(`/v1/terminals/${s.t2.id}/revoke`).set(s.auth).send({ reason: 'Stolen' }).expect(200);
    const revoked = await http().get('/v1/terminal/snapshot').set(s.t2.headers).expect(401);
    expect(revoked.body.error.code).toBe('TERMINAL_REVOKED');
    expect((await sync(s.t2, [sale(s, snap)]).expect(401)).body.error.code).toBe('TERMINAL_REVOKED');
  });
});

describe('snapshot pages (ADR-0016 slice 5)', () => {
  it('a large catalogue comes in bounded pages, all priced as of the first page; the whole list is unchanged without pageSize', async () => {
    const s = await shop('off-page');
    const pc = ((await http().get('/v1/uoms').set(s.auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
    const vat = ((await http().get('/v1/tax-categories').set(s.auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
    const prefix = uniq('PG');
    const made: string[] = [];
    for (const [from, n] of [[0, 100], [100, 100], [200, 50]] as const) {
      const variants = Array.from({ length: n }, (_, i) => ({ sku: `${prefix}-${String(from + i).padStart(3, '0')}`, name: `size ${from + i}`, price: '10.00' }));
      made.push(...(await http().post('/v1/products').set(s.auth).send({ name: `Pack ${from}`, uomId: pc, taxCategoryId: vat, variants }).expect(201)).body.variants.map((v: { id: string }) => v.id));
    }
    const whole = await snapshot(s);
    expect(whole.items.length).toBe(252);
    expect(whole).not.toHaveProperty('nextPage');

    const first = (await http().get('/v1/terminal/snapshot').query({ pageSize: 100 }).set(s.t1.headers).expect(200)).body as Snapshot;
    expect([first.items.length, typeof first.nextPage]).toEqual([100, 'string']);
    // A price raised after the first page must not show on later pages: every page is as of `asOf`.
    const lastVariant = made[made.length - 1]!;
    const lists = (await http().get('/v1/price-lists').set(s.auth).expect(200)).body.data as { id: string; isDefault: boolean }[];
    await http().post(`/v1/price-lists/${lists.find((l) => l.isDefault)!.id}/prices`).set(s.auth).send({ items: [{ variantId: lastVariant, amount: '99.00' }] }).expect(201);
    const items = [...first.items];
    const sizes: number[] = [first.items.length];
    for (let after = first.nextPage; after; ) {
      const page = (await http().get(`/v1/terminal/snapshot/${first.snapshotId}/items`).query({ pageSize: 100, after }).set(s.t1.headers).expect(200)).body;
      expect(page.snapshotId).toBe(first.snapshotId);
      items.push(...page.items);
      sizes.push(page.items.length);
      after = page.nextPage;
    }
    expect(sizes).toEqual([100, 100, 52]);
    expect(items).toEqual(whole.items); // same order, same prices, nothing repeated or skipped
    expect(items.find((i) => i.variantId === lastVariant)!.unitPrice).toBe('10.0000');
    expect((await snapshot(s)).items.find((i) => i.variantId === lastVariant)!.unitPrice).toBe('99.0000');

    // Another till's snapshot, a made-up cursor, a page size out of range.
    const page = (after: string, t = s.t1) => http().get(`/v1/terminal/snapshot/${first.snapshotId}/items`).query({ pageSize: 100, after }).set(t.headers);
    expect((await page(first.nextPage!, s.t2).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await page('not-a-cursor').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    await http().get('/v1/terminal/snapshot').query({ pageSize: 50 }).set(s.t1.headers).expect(400);
    await http().get(`/v1/terminal/snapshot/${first.snapshotId}/items`).set(s.t1.headers).expect(400); // no cursor
  });
});

describe('sync time budget (ADR-0016 slice 5)', () => {
  it('a server out of time answers the oldest part of a batch and the rest arrives on the next call, nothing twice', async () => {
    const s = await shop('off-budget');
    const snap = await snapshot(s);
    const tight = await createApp({ SYNC_BATCH_BUDGET_MS: 0 }); // one envelope per call
    try {
      const batch = [sale(s, snap), sale(s, snap), sale(s, snap)];
      const send = () => request(tight.getHttpServer()).post('/v1/sync/sales').set(s.t1.headers).send({ sales: batch }).expect(200);
      const first = (await send()).body.results;
      expect(first.map((r: { deviceSeq: number; status: string }) => [r.deviceSeq, r.status])).toEqual([[batch[0]!.deviceSeq, 'RECORDED']]);
      const second = (await send()).body.results; // the till resends what was not answered, plus the answered one replays
      expect(second.map((r: { replayed: boolean }) => r.replayed)).toEqual([true]);
      // The engine sends only what is unanswered: the rest, one per call.
      for (const env of batch.slice(1)) {
        const r = (await request(tight.getHttpServer()).post('/v1/sync/sales').set(s.t1.headers).send({ sales: batch.slice(batch.indexOf(env)) }).expect(200)).body.results;
        expect(r.map((x: { deviceSeq: number; status: string; replayed: boolean }) => [x.deviceSeq, x.status, x.replayed])).toEqual([[env.deviceSeq, 'RECORDED', false]]);
      }
      expect(await sql(s, `SELECT count(*)::int AS n FROM sales WHERE origin = 'OFFLINE' AND terminal_id = $1`, [s.t1.id])).toEqual([{ n: 3 }]);
    } finally {
      await tight.close();
    }
  });

  it('counts the budget from when the request arrived: time lost waiting before the first sale counts', async () => {
    const s = await shop('off-arrival');
    const snap = await snapshot(s);
    const service = app.get(SyncService);
    const headers = Object.fromEntries(Object.entries(s.t1.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const terminal = await service.authenticate((h) => headers[h.toLowerCase()], 'budget-arrival-test');
    const batch = [sale(s, snap), sale(s, snap), sale(s, snap)];
    // Arrived 10 s ago (e.g. a pool wait): past the 8 s budget, so only the oldest is delivered now.
    const late = await service.syncSales(terminal, batch, performance.now() - 10_000);
    expect(late.map((r) => r.deviceSeq)).toEqual([batch[0]!.deviceSeq]);
    // Just arrived: the whole batch fits.
    const fresh = await service.syncSales(terminal, batch, performance.now());
    expect(fresh.map((r) => [r.deviceSeq, r.replayed])).toEqual(batch.map((b, i) => [b.deviceSeq, i === 0]));
  });
});

describe('sync', () => {
  it('records offline sales in device order, on the day they happened, once — retries replay; a reused id with new content is rejected', async () => {
    const s = await shop('off-sync');
    const snap = await snapshot(s);
    const occurred = new Date(new Date(s.session.openedAt).getTime() + 1).toISOString(); // early in the shift, while offline (the host clock may run ahead of the DB's)
    const a = sale(s, snap, { occurredAt: occurred });
    const b = sale(s, snap, { lines: [{ variantId: s.chips, quantity: '1' }, { variantId: s.cola, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }], amountDue: '57.40' });
    const res = (await sync(s.t1, [b, a]).expect(200)).body.results; // sent out of order: processed by deviceSeq
    expect(res.map((r: { deviceSeq: number; status: string; saleNumber: number; reference: string; flags: string[]; replayed: boolean }) => [r.deviceSeq, r.status, r.saleNumber, r.reference, r.flags, r.replayed]))
      .toEqual([[a.deviceSeq, 'RECORDED', 1, 'R1-000001', [], false], [b.deviceSeq, 'RECORDED', 2, 'R1-000002', [], false]]);

    const [row] = await sql<{ origin: string; terminal_id: string; offline_reference: string; completed_at: Date; cashier_user_id: string; amount_due: string }>(s,
      `SELECT origin, terminal_id, offline_reference, completed_at, cashier_user_id, amount_due::text FROM sales WHERE id = $1`, [res[0].saleId]);
    expect(row).toMatchObject({ origin: 'OFFLINE', terminal_id: s.t1.id, offline_reference: a.localReference, cashier_user_id: s.cashierId, amount_due: '44.8000' });
    expect(row!.completed_at.toISOString()).toBe(occurred);
    // Drawer, stock and books like any sale.
    const shift = (await http().get(`/v1/cashier-sessions/${s.session.id}`).set(s.cashier).expect(200)).body;
    expect(shift.expectedCash).toBe('1102.20');
    expect(await sql(s, `SELECT variant_id, sum(quantity)::text AS q FROM stock_movements WHERE type = 'SALE' GROUP BY 1 ORDER BY 2`)).toEqual(
      [{ variant_id: s.cola, q: '-3.0000' }, { variant_id: s.chips, q: '-1.0000' }].sort((x, y) => x.q.localeCompare(y.q)),
    );
    expect(await sql(s, `SELECT count(*)::int AS n FROM journal_entries WHERE source_type = 'SALE'`)).toEqual([{ n: 2 }]);
    const receipt = (await http().get(`/v1/sales/${res[0].saleId}/receipt`).set(s.cashier).expect(200)).body;
    expect(receipt.transaction.reference).toBe('R1-000001');

    // The terminal never heard back and sends the same batch again: same answers, nothing new.
    const again = (await sync(s.t1, [a, b]).expect(200)).body.results;
    expect(again.map((r: { saleId: string; replayed: boolean }) => [r.saleId, r.replayed])).toEqual(res.map((r: { saleId: string }) => [r.saleId, true]));
    // Two sync loops at once (e.g. a retry racing a slow first attempt): one sale each.
    const c = sale(s, snap);
    const both = await Promise.all([sync(s.t1, [c]), sync(s.t1, [c])]);
    expect(both.map((x) => x.body.results[0].status)).toEqual(['RECORDED', 'RECORDED']);
    expect(new Set(both.map((x) => x.body.results[0].saleId)).size).toBe(1);
    expect(await sql(s, `SELECT count(*)::int AS n FROM sales`)).toEqual([{ n: 3 }]);
    // Same id, different content: refused, not recorded, not overwritten.
    const forged = (await sync(s.t1, [{ ...a, amountDue: '0.00', tenders: [{ method: 'CASH', tendered: '0.00' }] }]).expect(200)).body.results[0];
    expect([forged.status, forged.code]).toEqual(['REJECTED', 'TXN_ID_REUSED']);
    // Another terminal cannot deliver R1's shift.
    const other = (await sync(s.t2, [sale(s, await snapshot(s, s.t2))]).expect(200)).body.results[0];
    expect([other.status, other.code]).toEqual(['QUARANTINED', 'WRONG_REGISTER']);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('flags, never refuses: a price changed while offline (sold at the snapshot price) and a device clock ahead or behind', async () => {
    const s = await shop('off-flags');
    const snap = await snapshot(s);
    const prices = (await http().get(`/v1/price-lists`).set(s.auth).expect(200)).body.data;
    const raised = await http().post(`/v1/price-lists/${prices[0].id}/prices`).set(s.auth).send({ items: [{ variantId: s.cola, amount: '25.00' }] });
    expect(raised.status).toBeLessThan(300);
    // Sold after the rise by the DB clock: the host clock may run behind the DB's by more than the
    // moment between the two calls, which would date the sale before the new price (correctly unflagged).
    const at = (await sql<{ at: Date }>(s, `SELECT clock_timestamp() + interval '1 millisecond' AS at`))[0]!.at;
    const changed = (await sync(s.t1, [sale(s, snap, { occurredAt: at.toISOString() })]).expect(200)).body.results[0];
    expect([changed.status, changed.flags]).toEqual(['RECORDED', ['PRICE_CHANGED']]);
    expect((await http().get(`/v1/sales/${changed.saleId}`).set(s.cashier).expect(200)).body.amountDue).toBe('44.80'); // what the customer paid

    const fresh = await snapshot(s);
    const ahead = (await sync(s.t1, [sale(s, fresh, { occurredAt: new Date(Date.now() + 3_600_000).toISOString(), amountDue: '50.00' })]).expect(200)).body.results[0];
    expect([ahead.status, ahead.flags]).toEqual(['RECORDED', ['CLOCK_ADJUSTED']]);
    const behind = (await sync(s.t1, [sale(s, fresh, { occurredAt: '2020-01-01T00:00:00Z', amountDue: '50.00' })]).expect(200)).body.results[0];
    // Clamped to the shift's opening, when Cola still cost ₱22.40: the snapshot's ₱25.00 differs.
    expect(behind.flags).toEqual(['CLOCK_ADJUSTED', 'PRICE_CHANGED']);
    const [when] = await sql<{ completed_at: Date; opened_at: Date }>(s, `SELECT s.completed_at, c.opened_at FROM sales s JOIN cashier_sessions c ON c.id = s.cashier_session_id WHERE s.id = $1`, [behind.saleId]);
    expect(when!.completed_at.getTime()).toBe(when!.opened_at.getTime()); // never before the shift opened
    expect(await sql(s, `SELECT offline_flags FROM sales ORDER BY sale_number`)).toEqual([{ offline_flags: ['PRICE_CHANGED'] }, { offline_flags: ['CLOCK_ADJUSTED'] }, { offline_flags: ['CLOCK_ADJUSTED', 'PRICE_CHANGED'] }]);
    // Managers see the flags on the recorded deliveries.
    const recorded = (await http().get('/v1/sync/transactions?status=RECORDED').set(s.manager).expect(200)).body.data;
    expect(recorded.map((x: { saleNumber: number; flags: string[] }) => [x.saleNumber, x.flags]).sort()).toEqual([[1, ['PRICE_CHANGED']], [2, ['CLOCK_ADJUSTED']], [3, ['CLOCK_ADJUSTED', 'PRICE_CHANGED']]]);
  });

  it('a price or promotion made after the snapshot, back-dated before it, was not on the till: recorded at the snapshot price, flagged PRICE_CHANGED (audit 2026-10-21)', async () => {
    const s = await shop('off-backdated');
    const snap = await snapshot(s);
    // The snapshot cut 20 s ago (the shop's prices and tax profile made a day before it, so they were on it).
    await sql(s, `
      ALTER TABLE product_prices DISABLE TRIGGER product_prices_append_only;
      ALTER TABLE tax_profiles DISABLE TRIGGER tax_profiles_append_only;
      ALTER TABLE terminal_snapshots DISABLE TRIGGER terminal_snapshots_append_only;
      UPDATE product_prices SET effective_from = effective_from - interval '1 day', created_at = created_at - interval '1 day';
      UPDATE tax_profiles SET effective_from = effective_from - interval '1 day';
      UPDATE terminal_snapshots SET as_of = now() - interval '20 seconds' WHERE id = '${snap.snapshotId}';
      ALTER TABLE product_prices ENABLE TRIGGER product_prices_append_only;
      ALTER TABLE tax_profiles ENABLE TRIGGER tax_profiles_append_only;
      ALTER TABLE terminal_snapshots ENABLE TRIGGER terminal_snapshots_append_only;`);
    // Now: Cola to ₱25.00 and Chips two for ₱50.00, both back-dated 40 s (inside the minute allowed), so before the snapshot.
    const back = (await sql<{ at: Date }>(s, `SELECT now() - interval '40 seconds' AS at`))[0]!.at;
    const lists = (await http().get('/v1/price-lists').set(s.auth).expect(200)).body.data;
    await http().post(`/v1/price-lists/${lists[0].id}/prices`).set(s.auth).send({ items: [{ variantId: s.cola, amount: '25.00', effectiveFrom: back.toISOString() }] }).expect(201);
    await http().post('/v1/promotions').set(s.auth).send({ name: 'Two chips for 50', kind: 'MULTI_BUY', quantity: 2, price: '50.00', variantIds: [s.chips], startsAt: back.toISOString() }).expect(201);

    // Rung on the till at its snapshot prices: Cola 2 × 22.40 + Chips 2 × 35.00, no promotion.
    const r = (await sync(s.t1, [sale(s, snap, {
      lines: [{ variantId: s.cola, quantity: '2' }, { variantId: s.chips, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '200.00' }], amountDue: '114.80',
    })]).expect(200)).body.results[0];
    expect([r.status, r.flags]).toEqual(['RECORDED', ['PRICE_CHANGED']]);
    const recorded = (await http().get(`/v1/sales/${r.saleId}`).set(s.cashier).expect(200)).body;
    expect(recorded.amountDue).toBe('114.80');
    expect(await sql(s, `SELECT promotion_id FROM sale_lines WHERE sale_id = $1 ORDER BY line_no`, [r.saleId])).toEqual([{ promotion_id: null }, { promotion_id: null }]);
    // Online the new price and promotion apply at once (unchanged): 2 × 25.00 + 50.00.
    const quote = (await http().post('/v1/tax/quote').set(s.cashier).send({ branchId: s.branchId, lines: [{ variantId: s.cola, quantity: '2' }, { variantId: s.chips, quantity: '2' }] }).expect(200)).body;
    expect(quote.totals.amountDue).toBe('100.00');
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('flags, never refuses, a sale priced from a snapshot older than the offline window (24 h)', async () => {
    const s = await shop('off-expired');
    const inside = await snapshot(s);
    const outside = await snapshot(s);
    // Age the snapshots without a clock: move the shop's prices and tax profile back two days so they
    // were already in force, then date the snapshots 23 h and 25 h ago. The append-only triggers are
    // switched off only inside this transaction (ALTER TABLE holds an exclusive lock until COMMIT).
    await sql(s, `
      ALTER TABLE product_prices DISABLE TRIGGER product_prices_append_only;
      ALTER TABLE tax_profiles DISABLE TRIGGER tax_profiles_append_only;
      ALTER TABLE terminal_snapshots DISABLE TRIGGER terminal_snapshots_append_only;
      UPDATE product_prices SET effective_from = effective_from - interval '2 days', created_at = created_at - interval '2 days';
      UPDATE tax_profiles SET effective_from = effective_from - interval '2 days';
      UPDATE terminal_snapshots SET as_of = now() - interval '23 hours' WHERE id = '${inside.snapshotId}';
      UPDATE terminal_snapshots SET as_of = now() - interval '25 hours' WHERE id = '${outside.snapshotId}';
      ALTER TABLE product_prices ENABLE TRIGGER product_prices_append_only;
      ALTER TABLE tax_profiles ENABLE TRIGGER tax_profiles_append_only;
      ALTER TABLE terminal_snapshots ENABLE TRIGGER terminal_snapshots_append_only;`);

    const res = (await sync(s.t1, [sale(s, inside), sale(s, outside)]).expect(200)).body.results;
    expect(res.map((r: { status: string; flags: string[] }) => [r.status, r.flags])).toEqual([['RECORDED', []], ['RECORDED', ['SNAPSHOT_EXPIRED']]]);
    expect((await http().get(`/v1/sales/${res[1].saleId}`).set(s.cashier).expect(200)).body.amountDue).toBe('44.80'); // what the customer paid
    expect(await sql(s, `SELECT offline_flags FROM sales ORDER BY sale_number`)).toEqual([{ offline_flags: [] }, { offline_flags: ['SNAPSHOT_EXPIRED'] }]);
    expect(await audit(s)).toEqual(CLEAN);
  });
});

describe('a business that lapsed or was suspended while the till was offline (session 21 decision)', () => {
  const setSubscription = (s: S, status: string) => owner.query(`SELECT platform_set_subscription($1, 'growth', $2, null, null)`, [s.tenantId, status]);
  const setTenantStatus = (s: S, status: string) => sql(s, `UPDATE tenants SET status = $2 WHERE id = $1`, [s.tenantId, status]);
  const stamped = (s: S, snap: Snapshot) => sql<{ business_writable: boolean }>(s, `SELECT business_writable FROM terminal_snapshots WHERE id = $1`, [snap.snapshotId]);

  it('a lapse: sales rung on a snapshot issued while active are recorded and audited; later snapshots and an expired one wait until renewal', async () => {
    const s = await shop('off-lapse');
    const active = await snapshot(s);
    const old = await snapshot(s);
    // `old` was issued while active but more than the offline window (24 h) ago (prices back-dated as above).
    await sql(s, `
      ALTER TABLE product_prices DISABLE TRIGGER product_prices_append_only;
      ALTER TABLE tax_profiles DISABLE TRIGGER tax_profiles_append_only;
      ALTER TABLE terminal_snapshots DISABLE TRIGGER terminal_snapshots_append_only;
      UPDATE product_prices SET effective_from = effective_from - interval '2 days', created_at = created_at - interval '2 days';
      UPDATE tax_profiles SET effective_from = effective_from - interval '2 days';
      UPDATE terminal_snapshots SET as_of = now() - interval '25 hours' WHERE id = '${old.snapshotId}';
      ALTER TABLE product_prices ENABLE TRIGGER product_prices_append_only;
      ALTER TABLE tax_profiles ENABLE TRIGGER tax_profiles_append_only;
      ALTER TABLE terminal_snapshots ENABLE TRIGGER terminal_snapshots_append_only;`);
    await setSubscription(s, 'CANCELED');
    const lapsed = await snapshot(s);
    expect(await stamped(s, active)).toEqual([{ business_writable: true }]);
    expect(await stamped(s, lapsed)).toEqual([{ business_writable: false }]);

    const [onActive, onLapsed, onOld] = [sale(s, active), sale(s, lapsed), sale(s, old)];
    const res = (await sync(s.t1, [onActive, onLapsed, onOld]).expect(200)).body.results;
    expect(res.map((r: { status: string; code?: string }) => [r.status, r.code])).toEqual([
      ['RECORDED', undefined], ['QUARANTINED', 'SUBSCRIPTION_READ_ONLY'], ['QUARANTINED', 'SUBSCRIPTION_READ_ONLY'],
    ]);
    expect(await sql(s, `SELECT resource_id, metadata->>'reason' AS reason FROM audit_logs WHERE action = 'offline_sale.recorded_while_read_only'`))
      .toEqual([{ resource_id: res[0].saleId, reason: 'SUBSCRIPTION_READ_ONLY' }]);
    // A retry while still lapsed is refused; after renewal both are recorded.
    const waiting = (await http().get('/v1/sync/transactions?status=QUARANTINED').set(s.manager).expect(200)).body.data as { id: string; localReference: string }[];
    expect(waiting.map((w) => w.localReference).sort()).toEqual([onLapsed.localReference, onOld.localReference].sort());
    expect((await http().post(`/v1/sync/transactions/${waiting[0]!.id}/retry`).set(s.manager).expect(409)).body.error.details.code).toBe('SUBSCRIPTION_READ_ONLY');
    await setSubscription(s, 'ACTIVE');
    for (const w of waiting) expect((await http().post(`/v1/sync/transactions/${w.id}/retry`).set(s.manager).expect(200)).body.status).toBe('RECORDED');
    expect(await sql(s, `SELECT count(*)::int AS n FROM sales`)).toEqual([{ n: 3 }]);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('a suspension: the snapshot issued before it still records; one issued after waits, and cannot be retried until the business is active', async () => {
    const s = await shop('off-suspend');
    const before = await snapshot(s);
    await setTenantStatus(s, 'SUSPENDED');
    try {
      const after = await snapshot(s);
      expect(await stamped(s, after)).toEqual([{ business_writable: false }]);
      const res = (await sync(s.t1, [sale(s, before), sale(s, after)]).expect(200)).body.results;
      expect(res.map((r: { status: string; code?: string }) => [r.status, r.code])).toEqual([['RECORDED', undefined], ['QUARANTINED', 'TENANT_SUSPENDED']]);
      const [q] = await sql<{ id: string }>(s, `SELECT id FROM terminal_transactions WHERE status = 'QUARANTINED'`);
      expect((await http().post(`/v1/sync/transactions/${q!.id}/retry`).set(s.manager).expect(403)).body.error.code).toBe('TENANT_SUSPENDED');
      await setTenantStatus(s, 'ACTIVE');
      expect((await http().post(`/v1/sync/transactions/${q!.id}/retry`).set(s.manager).expect(200)).body.status).toBe('RECORDED');
      expect(await audit(s)).toEqual(CLEAN);
    } finally {
      await setTenantStatus(s, 'ACTIVE');
    }
  });
});

describe('till health', () => {
  it('managers see when each till was last heard from; a till gone quiet during an open shift is reported silent', async () => {
    const s = await shop('off-health');
    const health = async (who: Record<string, string>) => (await http().get('/v1/sync/terminals').set(who).expect(200)).body;
    await snapshot(s);
    await sync(s.t1, [sale(s, await snapshot(s), { amountDue: '40.00', tenders: [{ method: 'CASH', tendered: '40.00' }] })]).expect(200); // quarantined
    const h = await health(s.manager);
    expect(h.silenceMinutes).toBe(30);
    const t1 = h.data.find((x: { terminalId: string }) => x.terminalId === s.t1.id);
    expect(t1).toMatchObject({ register: { id: s.r1, code: 'R1' }, quarantined: 1, silent: false, shiftOpenedAt: expect.any(String) });
    expect(t1.lastContactAt).toBe(t1.lastDeliveryAt);
    // R2's till never called and R2 has no shift: unknown, but not silent.
    expect(h.data.find((x: { terminalId: string }) => x.terminalId === s.t2.id)).toMatchObject({ lastContactAt: null, shiftOpenedAt: null, silent: false });
    // A cashier (no cash.reconcile) sees no tills.
    expect((await health(s.cashier)).data).toEqual([]);

    // R1's till goes quiet for 40 minutes during the shift (dated back as if it happened; the shift opened before).
    await sql(s, `
      ALTER TABLE terminal_snapshots DISABLE TRIGGER terminal_snapshots_append_only;
      ALTER TABLE terminal_transactions DISABLE TRIGGER USER;
      ALTER TABLE cashier_sessions DISABLE TRIGGER USER;
      UPDATE terminal_snapshots SET as_of = now() - interval '40 minutes';
      UPDATE terminal_transactions SET received_at = now() - interval '40 minutes';
      UPDATE cashier_sessions SET opened_at = now() - interval '2 hours';
      ALTER TABLE terminal_snapshots ENABLE TRIGGER terminal_snapshots_append_only;
      ALTER TABLE terminal_transactions ENABLE TRIGGER USER;
      ALTER TABLE cashier_sessions ENABLE TRIGGER USER;`);
    expect((await health(s.manager)).data.find((x: { terminalId: string }) => x.terminalId === s.t1.id).silent).toBe(true);
    // It calls again: no longer silent. A revoked till is no longer listed.
    await snapshot(s);
    expect((await health(s.manager)).data.find((x: { terminalId: string }) => x.terminalId === s.t1.id).silent).toBe(false);
    await http().post(`/v1/terminals/${s.t2.id}/revoke`).set(s.auth).send({ reason: 'Replaced' }).expect(200);
    expect((await health(s.auth)).data.map((x: { terminalId: string }) => x.terminalId)).toEqual([s.t1.id]);
  });
});

describe('quarantine', () => {
  it('tills learn the catalog changed: the version moves with every catalog edit, a scheduled change is announced, sales do not move it', async () => {
    const s = await shop('off-version');
    const other = await shop('off-version-b');
    const version = async (t = s.t1) => (await http().get('/v1/terminal/catalog-version').set(t.headers).expect(200)).body as { version: number; nextChangeAt: string | null };
    const snap = await snapshot(s);
    expect(snap.catalogVersion).toBeGreaterThan(0);
    expect(snap.nextChangeAt).toBeNull();
    expect(await version()).toEqual({ version: snap.catalogVersion, nextChangeAt: null });
    // A sale (online or offline) is not a catalog change.
    await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session.id, clientTransactionId: randomUUID(), lines: [{ variantId: s.cola, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '50.00' }] }).expect(201);
    expect((await sync(s.t1, [sale(s, snap)]).expect(200)).body.results[0].status).toBe('RECORDED');
    expect((await version()).version).toBe(snap.catalogVersion);
    // Another business's edits do not reach this till.
    await http().patch(`/v1/products/${(await http().get('/v1/products').set(other.auth).expect(200)).body.data[0].id}`).set(other.auth).send({ name: 'Renamed elsewhere' }).expect(200);
    expect((await version()).version).toBe(snap.catalogVersion);
    // A rename moves it; so does a price scheduled for later, which is also announced.
    const product = (await http().get('/v1/products').set(s.auth).expect(200)).body.data.find((x: { name: string }) => x.name === 'Cola');
    await http().patch(`/v1/products/${product.id}`).set(s.auth).send({ name: 'Cola 290ml' }).expect(200);
    const renamed = await version();
    expect(renamed.version).toBeGreaterThan(snap.catalogVersion!);
    const at = new Date(Date.now() + 3_600_000);
    at.setUTCMilliseconds(0);
    const list = ((await http().get('/v1/price-lists').set(s.auth).expect(200)).body.data as { id: string; isDefault: boolean }[]).find((l) => l.isDefault)!;
    await http().post(`/v1/price-lists/${list.id}/prices`).set(s.auth).send({ items: [{ variantId: s.cola, amount: '25.00', effectiveFrom: at.toISOString() }] }).expect(201);
    const scheduled = await version();
    expect(scheduled.version).toBeGreaterThan(renamed.version);
    expect(scheduled.nextChangeAt).toBe(at.toISOString());
    const fresh = await snapshot(s);
    expect([fresh.catalogVersion, fresh.nextChangeAt]).toEqual([scheduled.version, at.toISOString()]);
    expect(fresh.items.find((i) => i.variantId === s.cola)!.unitPrice).toBe('22.4000'); // not yet in force
    expect(fresh.lastDeviceSeq).toBe(seq); // the offline sale synced above was the last one this terminal numbered
    // A revoked till learns nothing.
    await http().post(`/v1/terminals/${s.t2.id}/revoke`).set(s.auth).send({ reason: 'Stolen' }).expect(200);
    await http().get('/v1/terminal/catalog-version').set(s.t2.headers).expect(401);
  });

  it('a till revoked and set up again on its register delivers what it rang up under the old credential; nobody else can', async () => {
    const s = await shop('off-recover');
    const snap = await snapshot(s);
    const delivered = sale(s, snap);
    const stranded = sale(s, snap);
    const foreign = sale(s, snap);
    expect((await sync(s.t1, [delivered]).expect(200)).body.results[0].status).toBe('RECORDED');
    // The till is revoked (say its credential leaked) and paired again: a new terminal on the same register.
    await http().post(`/v1/terminals/${s.t1.id}/revoke`).set(s.auth).send({ reason: 'Credential shown on a screenshot' }).expect(200);
    await http().post('/v1/sync/sales').set(s.t1.headers).send({ sales: [stranded] }).expect(401);
    const res = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.r1, name: 'Till again' }).expect(201)).body;
    const again = { id: res.terminal.id as string, headers: { 'x-terminal-id': res.terminal.id, Authorization: `Terminal ${res.credential}` } };
    const results = (await sync(again, [delivered, stranded]).expect(200)).body.results;
    // Delivered before the revocation: the original answer. Stranded: recorded now, once.
    const first = (await sql<{ sale_id: string }>(s, `SELECT sale_id FROM terminal_transactions WHERE terminal_txn_id = $1`, [delivered.terminalTxnId]))[0]!.sale_id;
    expect(results.map((r: { status: string; replayed: boolean; saleId: string }) => [r.status, r.replayed])).toEqual([['RECORDED', true], ['RECORDED', false]]);
    expect(results[0].saleId).toBe(first);
    expect(await sql(s, `SELECT count(*)::int AS n FROM sales WHERE client_transaction_id = ANY($1::text[])`, [[delivered.terminalTxnId, stranded.terminalTxnId]])).toEqual([{ n: 2 }]);
    const recovered = await sql<{ metadata: Record<string, string> }>(s, `SELECT metadata FROM audit_logs WHERE action = 'offline_sale.recovered'`);
    expect(recovered).toEqual([{ metadata: expect.objectContaining({ terminalId: again.id, revokedTerminalId: s.t1.id, localReference: stranded.localReference }) }]);
    expect((await sync(again, [stranded]).expect(200)).body.results[0]).toMatchObject({ status: 'RECORDED', replayed: true });
    // A till on another register cannot deliver the revoked till's sales.
    const r = (await sync(s.t2, [foreign]).expect(200)).body.results[0];
    expect([r.status, r.code]).toEqual(['QUARANTINED', 'UNKNOWN_SNAPSHOT']);
    // Nor can a till deliver with the snapshot of another till that is still active on its register.
    const active = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.r1, name: 'Second till' }).expect(201)).body;
    const activeSnap = (await http().get('/v1/terminal/snapshot').set({ 'x-terminal-id': active.terminal.id, Authorization: `Terminal ${active.credential}` }).expect(200)).body as Snapshot;
    const borrowed = (await sync(again, [sale(s, activeSnap)]).expect(200)).body.results[0];
    expect([borrowed.status, borrowed.code]).toEqual(['QUARANTINED', 'UNKNOWN_SNAPSHOT']);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('a sale whose month was closed while the till was offline is quarantined (PERIOD_CLOSED), and recorded once the month reopens', async () => {
    const s = await shop('off-period');
    const snap = await snapshot(s);
    const offline = sale(s, snap);
    // The books of the sale's month are closed meanwhile. The API closes only months that have ended, so
    // the drill writes the closed period itself: the database guard on postings is what is exercised.
    const [period] = await sql<{ le: string; month: string }>(s,
      `SELECT b.legal_entity_id AS le, to_char(now() AT TIME ZONE b.timezone, 'YYYY-MM-01') AS month FROM branches b WHERE b.id = $1`, [s.branchId]);
    const { le, month } = period!;
    await sql(s, `INSERT INTO accounting_periods (tenant_id, legal_entity_id, starts_on, status, closed_by, closed_at)
                  VALUES ($1, $2, $3, 'CLOSED', $4, now())
                  ON CONFLICT (tenant_id, legal_entity_id, starts_on) DO UPDATE SET status = 'CLOSED', closed_by = EXCLUDED.closed_by, closed_at = now()`,
      [s.tenantId, le, month, s.cashierId]);
    const before = await sql(s, `SELECT count(*)::int AS n FROM sales`);
    const r = (await sync(s.t1, [offline]).expect(200)).body.results[0];
    expect([r.status, r.code]).toEqual(['QUARANTINED', 'PERIOD_CLOSED']);
    expect(await sql(s, `SELECT count(*)::int AS n FROM sales`)).toEqual(before); // nothing half-recorded
    const q = (await http().get('/v1/sync/transactions?status=QUARANTINED').set(s.manager).expect(200)).body.data[0];
    expect(q).toMatchObject({ errorCode: 'PERIOD_CLOSED', localReference: offline.localReference });
    // Still closed: a retry is refused and counted.
    expect((await http().post(`/v1/sync/transactions/${q.id}/retry`).set(s.manager).expect(409)).body.error).toMatchObject({ code: 'STILL_QUARANTINED', details: { code: 'PERIOD_CLOSED' } });
    // The accountant reopens the month (with a reason, through the API); the manager retries: recorded once.
    await http().post('/v1/accounting/periods/reopen').set(s.auth).send({ legalEntityId: le, month: month.slice(0, 7), reason: 'An offline till synced late' }).expect(200);
    const retried = (await http().post(`/v1/sync/transactions/${q.id}/retry`).set(s.manager).expect(200)).body;
    expect([retried.status, retried.attempts]).toEqual(['RECORDED', 3]);
    expect((await sync(s.t1, [offline]).expect(200)).body.results[0]).toMatchObject({ status: 'RECORDED', saleId: retried.saleId, replayed: true });
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('what cannot be recorded waits for a manager, blocks the close, and is retried or dismissed', async () => {
    const s = await shop('off-quarantine');
    const snap = await snapshot(s);
    const before = await sql(s, `SELECT count(*)::int AS n FROM sales`);
    const wrongTotal = sale(s, snap, { amountDue: '40.00', tenders: [{ method: 'CASH', tendered: '40.00' }] });
    const suspended = sale(s, snap);
    const unknownSnap = sale(s, snap, { snapshotId: randomUUID() });
    const notOwner = sale(s, snap, { cashierUserId: (await addMember(owner, s.tenantId, 'cashier', { type: 'BRANCH', id: s.branchId })).userId });

    const r1 = (await sync(s.t1, [wrongTotal, unknownSnap, notOwner]).expect(200)).body.results;
    expect(r1.map((r: { status: string; code: string }) => [r.status, r.code])).toEqual([['QUARANTINED', 'TOTAL_MISMATCH'], ['QUARANTINED', 'UNKNOWN_SNAPSHOT'], ['QUARANTINED', 'NOT_SESSION_OWNER']]);
    await http().post(`/v1/members/${s.cashierMembership}/suspend`).set(s.auth).expect(200);
    const r2 = (await sync(s.t1, [suspended]).expect(200)).body.results[0];
    expect([r2.status, r2.code]).toEqual(['QUARANTINED', 'CASHIER_NOT_AUTHORIZED']);
    expect(await sql(s, `SELECT count(*)::int AS n FROM sales`)).toEqual(before); // nothing recorded
    // A replay answers the quarantine without trying again.
    expect((await sync(s.t1, [wrongTotal]).expect(200)).body.results[0]).toMatchObject({ status: 'QUARANTINED', code: 'TOTAL_MISMATCH', replayed: true });

    // The manager sees them; the cashier does not (no cash.reconcile).
    const list = (await http().get('/v1/sync/transactions?status=QUARANTINED').set(s.manager).expect(200)).body.data;
    expect(list.map((x: { errorCode: string }) => x.errorCode)).toEqual(['TOTAL_MISMATCH', 'UNKNOWN_SNAPSHOT', 'NOT_SESSION_OWNER', 'CASHIER_NOT_AUTHORIZED']);
    expect((await http().get('/v1/sync/transactions?status=QUARANTINED').set(s.auth).expect(200)).body.data).toHaveLength(4);
    const byCode = (c: string) => list.find((x: { errorCode: string }) => x.errorCode === c);
    expect(byCode('TOTAL_MISMATCH')).toMatchObject({ amountDue: '40.00', localReference: wrongTotal.localReference, cashierSessionId: s.session.id, errorDetail: { details: { charged: '40.00', expected: '44.80' } } });

    // The shift cannot close over them.
    await http().post(`/v1/members/${s.cashierMembership}/reactivate`).set(s.auth).expect(200);
    const blocked = await http().post(`/v1/cashier-sessions/${s.session.id}/close`).set(s.cashier).send({ countedCash: '1000.00' }).expect(409);
    expect(blocked.body.error.code).toBe('OFFLINE_SALES_UNRESOLVED');

    // The cashier is active again: retrying records it, as the cashier, with the next number.
    const retried = (await http().post(`/v1/sync/transactions/${byCode('CASHIER_NOT_AUTHORIZED').id}/retry`).set(s.manager).expect(200)).body;
    expect([retried.status, retried.attempts]).toEqual(['RECORDED', 2]);
    expect((await http().get(`/v1/sales/${retried.saleId}`).set(s.manager).expect(200)).body).toMatchObject({ saleNumber: 1, cashierUserId: s.cashierId, amountDue: '44.80' });
    expect((await sync(s.t1, [suspended]).expect(200)).body.results[0]).toMatchObject({ status: 'RECORDED', saleId: retried.saleId, replayed: true });
    // A wrong total stays wrong: retry refused and counted; dismissing needs a reason.
    const still = await http().post(`/v1/sync/transactions/${byCode('TOTAL_MISMATCH').id}/retry`).set(s.manager).expect(409);
    expect(still.body.error).toMatchObject({ code: 'STILL_QUARANTINED', details: { code: 'TOTAL_MISMATCH' } });
    expect((await http().get(`/v1/sync/transactions/${byCode('TOTAL_MISMATCH').id}`).set(s.manager).expect(200)).body.attempts).toBe(2);
    await http().post(`/v1/sync/transactions/${byCode('TOTAL_MISMATCH').id}/dismiss`).set(s.manager).send({ reason: '' }).expect(400);
    await http().post(`/v1/sync/transactions/${byCode('TOTAL_MISMATCH').id}/retry`).set(s.cashier).expect(403);
    for (const c of ['TOTAL_MISMATCH', 'UNKNOWN_SNAPSHOT', 'NOT_SESSION_OWNER']) {
      expect((await http().post(`/v1/sync/transactions/${byCode(c).id}/dismiss`).set(s.manager).send({ reason: 'Counted in the drawer variance' }).expect(200)).body.status).toBe('DISMISSED');
    }
    expect((await http().post(`/v1/sync/transactions/${byCode('TOTAL_MISMATCH').id}/dismiss`).set(s.manager).send({ reason: 'again' }).expect(409)).body.error.code).toBe('NOT_QUARANTINED');
    expect((await sync(s.t1, [wrongTotal]).expect(200)).body.results[0]).toMatchObject({ status: 'DISMISSED', replayed: true });

    // Now the shift closes; the wrongly-charged ₱40.00 is a drawer overage for a person to explain.
    const closed = (await http().post(`/v1/cashier-sessions/${s.session.id}/close`).set(s.cashier).send({ countedCash: '1084.80' }).expect(200)).body;
    expect(closed.reconciliation).toMatchObject({ expectedCash: '1044.80', variance: '40.00' });
    // A sale for a closed shift is quarantined, not recorded.
    const late = (await sync(s.t1, [sale(s, snap)]).expect(200)).body.results[0];
    expect([late.status, late.code]).toEqual(['QUARANTINED', 'SESSION_NOT_OPEN']);
    // The database keeps deliveries: no deletes, final states stay final.
    await expect(sql(s, `DELETE FROM terminal_transactions`)).rejects.toThrow();
    await expect(sql(s, `UPDATE terminal_transactions SET status = 'QUARANTINED', error_code = 'X' WHERE status = 'RECORDED'`)).rejects.toThrow(/cannot become/);
    await expect(sql(s, `UPDATE terminal_snapshots SET as_of = now()`)).rejects.toThrow();
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('one envelope the server cannot read is quarantined alone (VALIDATION_FAILED), never blocking the batch; only dismissing resolves it', async () => {
    const s = await shop('off-unreadable');
    const snap = await snapshot(s);
    const a = sale(s, snap);
    // An older or faulty till: money as a number, no lines; and one with nothing usable but its head.
    const bad = { ...sale(s, snap), amountDue: 44.8, lines: undefined } as unknown as OfflineSale;
    const junk = { terminalTxnId: randomUUID(), deviceSeq: (seq += 1), cashierUserId: 'nobody', cashierSessionId: 'not-a-session', occurredAt: 'yesterday' } as unknown as OfflineSale;
    const c = sale(s, snap);
    const res = (await sync(s.t1, [c, junk, bad, a]).expect(200)).body.results;
    expect(res.map((r: { deviceSeq: number; status: string; code?: string }) => [r.deviceSeq, r.status, r.code])).toEqual([
      [a.deviceSeq, 'RECORDED', undefined], [bad.deviceSeq, 'QUARANTINED', 'VALIDATION_FAILED'], [junk.deviceSeq, 'QUARANTINED', 'VALIDATION_FAILED'], [c.deviceSeq, 'RECORDED', undefined],
    ]);
    // Stored as received; linked to the shift only through a session id that is one (so it blocks the close).
    const [stored] = await sql<{ payload: Record<string, unknown>; cashier_session_id: string | null; error_detail: { details: { issues: { path: string }[] } } }>(s,
      `SELECT payload, cashier_session_id, error_detail FROM terminal_transactions WHERE terminal_txn_id = $1`, [bad.terminalTxnId]);
    expect(stored).toMatchObject({ payload: { amountDue: 44.8, localReference: bad.localReference }, cashier_session_id: s.session.id });
    expect(stored!.error_detail.details.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['lines', 'amountDue']));
    expect(await sql(s, `SELECT cashier_session_id FROM terminal_transactions WHERE terminal_txn_id = $1`, [junk.terminalTxnId])).toEqual([{ cashier_session_id: null }]);
    // Sent again unchanged: the same answer; changed under the same id: rejected.
    expect((await sync(s.t1, [bad]).expect(200)).body.results[0]).toMatchObject({ status: 'QUARANTINED', code: 'VALIDATION_FAILED', replayed: true });
    expect((await sync(s.t1, [{ ...bad, amountDue: '44.80' } as OfflineSale]).expect(200)).body.results[0]).toMatchObject({ status: 'REJECTED', code: 'TXN_ID_REUSED' });
    // Without even a head it is not a till's batch.
    await http().post('/v1/sync/sales').set(s.t1.headers).send({ sales: [{ ...sale(s, snap), terminalTxnId: 'x' }] }).expect(400);
    await http().post('/v1/sync/sales').set(s.t1.headers).send({ sales: ['x'] }).expect(400);

    // The manager's list and detail read whatever the payload holds (no cast fails on a non-uuid cashier).
    const list = (await http().get('/v1/sync/transactions?status=QUARANTINED').set(s.manager).expect(200)).body.data as {
      id: string; terminalTxnId: string; localReference: string | null; occurredAt: string | null; amountDue: string | null; cashierName: string | null;
    }[];
    const byTxn = (id: string) => list.find((x) => x.terminalTxnId === id)!;
    expect(byTxn(junk.terminalTxnId)).toMatchObject({ localReference: null, occurredAt: null, amountDue: null, cashierName: null });
    expect(byTxn(bad.terminalTxnId)).toMatchObject({ localReference: bad.localReference, amountDue: null });
    await http().get(`/v1/sync/transactions/${byTxn(junk.terminalTxnId).id}`).set(s.manager).expect(200);
    // A retry cannot make it readable: refused and counted; dismissing resolves it and the shift can close.
    const still = await http().post(`/v1/sync/transactions/${byTxn(bad.terminalTxnId).id}/retry`).set(s.manager).expect(409);
    expect(still.body.error).toMatchObject({ code: 'STILL_QUARANTINED', details: { code: 'VALIDATION_FAILED' } });
    expect((await http().get(`/v1/sync/transactions/${byTxn(bad.terminalTxnId).id}`).set(s.manager).expect(200)).body.attempts).toBe(2);
    expect((await http().post(`/v1/cashier-sessions/${s.session.id}/close`).set(s.cashier).send({ countedCash: '1089.60' }).expect(409)).body.error.code).toBe('OFFLINE_SALES_UNRESOLVED');
    for (const id of [bad.terminalTxnId, junk.terminalTxnId]) {
      expect((await http().post(`/v1/sync/transactions/${byTxn(id).id}/dismiss`).set(s.manager).send({ reason: 'Till sent an unreadable sale' }).expect(200)).body.status).toBe('DISMISSED');
    }
    expect((await http().post(`/v1/cashier-sessions/${s.session.id}/close`).set(s.cashier).send({ countedCash: '1089.60' }).expect(200)).body.reconciliation).toMatchObject({ expectedCash: '1089.60' });
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('a retry follows the delivery rule for snapshots: a revoked till’s on the same register is recovered (audited), another active till’s never', async () => {
    const s = await shop('off-retry-snap');
    const snap = await snapshot(s);
    const stranded = sale(s, snap);
    await http().post(`/v1/terminals/${s.t1.id}/revoke`).set(s.auth).send({ reason: 'Replaced' }).expect(200);
    const paired = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.r1, name: 'Till again' }).expect(201)).body;
    const again = { id: paired.terminal.id as string, headers: { 'x-terminal-id': paired.terminal.id, Authorization: `Terminal ${paired.credential}` } };
    // Quarantined for a reason that passes (the cashier was suspended meanwhile), then retried.
    await http().post(`/v1/members/${s.cashierMembership}/suspend`).set(s.auth).expect(200);
    expect((await sync(again, [stranded]).expect(200)).body.results[0]).toMatchObject({ status: 'QUARANTINED', code: 'CASHIER_NOT_AUTHORIZED' });
    await http().post(`/v1/members/${s.cashierMembership}/reactivate`).set(s.auth).expect(200);
    const [q] = await sql<{ id: string }>(s, `SELECT id FROM terminal_transactions WHERE terminal_txn_id = $1`, [stranded.terminalTxnId]);
    const retried = (await http().post(`/v1/sync/transactions/${q!.id}/retry`).set(s.manager).expect(200)).body;
    expect(retried.status).toBe('RECORDED');
    expect(await sql(s, `SELECT resource_id, metadata->>'revokedTerminalId' AS revoked FROM audit_logs WHERE action = 'offline_sale.recovered'`))
      .toEqual([{ resource_id: retried.saleId, revoked: s.t1.id }]);

    // A second, active till on the register: its snapshot is not the new till's to use, at delivery or on retry.
    const second = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.r1, name: 'Second till' }).expect(201)).body;
    const secondSnap = (await http().get('/v1/terminal/snapshot').set({ 'x-terminal-id': second.terminal.id, Authorization: `Terminal ${second.credential}` }).expect(200)).body as Snapshot;
    const borrowed = sale(s, secondSnap);
    expect((await sync(again, [borrowed]).expect(200)).body.results[0]).toMatchObject({ status: 'QUARANTINED', code: 'UNKNOWN_SNAPSHOT' });
    const [b] = await sql<{ id: string }>(s, `SELECT id FROM terminal_transactions WHERE terminal_txn_id = $1`, [borrowed.terminalTxnId]);
    expect((await http().post(`/v1/sync/transactions/${b!.id}/retry`).set(s.manager).expect(409)).body.error).toMatchObject({ code: 'STILL_QUARANTINED', details: { code: 'UNKNOWN_SNAPSHOT' } });
    expect(await sql(s, `SELECT count(*)::int AS n FROM sales WHERE client_transaction_id = $1`, [borrowed.terminalTxnId])).toEqual([{ n: 0 }]);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('flags CLOCK_ADJUSTED a sale the till says it rang before it was given the snapshot it was priced from', async () => {
    const s = await shop('off-before-snap');
    const snap = await snapshot(s);
    // The snapshot dated ten minutes after the device's time of sale (inside the shift, by the DB clock).
    await sql(s, `
      ALTER TABLE terminal_snapshots DISABLE TRIGGER terminal_snapshots_append_only;
      UPDATE terminal_snapshots SET as_of = clock_timestamp() + interval '10 minutes' WHERE id = '${snap.snapshotId}';
      ALTER TABLE terminal_snapshots ENABLE TRIGGER terminal_snapshots_append_only;`);
    const at = (await sql<{ at: Date }>(s, `SELECT clock_timestamp() AS at`))[0]!.at;
    const r = (await sync(s.t1, [sale(s, snap, { occurredAt: at.toISOString() })]).expect(200)).body.results[0];
    expect([r.status, r.flags]).toEqual(['RECORDED', ['CLOCK_ADJUSTED']]);
    // An ordinary sale on a fresh snapshot is not flagged.
    const ok = (await sync(s.t1, [sale(s, await snapshot(s))]).expect(200)).body.results[0];
    expect([ok.status, ok.flags]).toEqual(['RECORDED', []]);
  });
});

describe('reports date an offline sale’s cost with its revenue', () => {
  it('gross profit and the stock movements report count a late-delivered sale on the day it was rung, as the ledger does', async () => {
    const s = await shop('off-report-day');
    const snap = await snapshot(s);
    const r = (await sync(s.t1, [sale(s, snap)]).expect(200)).body.results[0];
    expect(r.status).toBe('RECORDED');
    // Delivered two days later: its movements are written then (the sale keeps the day it happened).
    await sql(s, `
      ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_append_only;
      UPDATE stock_movements SET created_at = created_at + interval '2 days' WHERE sale_id = '${r.saleId}';
      ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_append_only;`);
    const [{ day, later }] = await sql<{ day: string; later: string }>(s,
      `SELECT (s.completed_at AT TIME ZONE b.timezone)::date::text AS day, ((s.completed_at + interval '2 days') AT TIME ZONE b.timezone)::date::text AS later
         FROM sales s JOIN branches b ON b.id = s.branch_id WHERE s.id = $1`, [r.saleId]) as [{ day: string; later: string }];
    const report = (name: string, on: string) => http().get(`/v1/reports/${name}`).query({ branchId: s.branchId, from: on, to: on }).set(s.auth).expect(200);

    // Revenue 44.80 incl. VAT = 40.00; two colas at 15.00 cost 30.00, all on the day of the sale.
    const products = (await report('by-product', day)).body.data as { variantId: string; revenueExVat: string; cogs: string; grossProfit: string }[];
    expect(products.find((p) => p.variantId === s.cola)).toMatchObject({ revenueExVat: '40.00', cogs: '30.00', grossProfit: '10.00' });
    expect(((await report('by-product', later)).body.data as unknown[])).toEqual([]);
    const categories = (await report('by-category', day)).body.data as { cogs: string }[];
    expect(categories.reduce((a, c) => a + Number(c.cogs), 0)).toBe(30);
    // Stock: the sale's movement is in that day's movements (with the opening stock taken that day), and the closing counts it.
    const moves = (await report('stock-movements', day)).body.data as { variantId: string; opening: { quantity: string }; movements: Record<string, { quantity: string; value: string }>; closing: { quantity: string } }[];
    expect(moves.find((m) => m.variantId === s.cola)).toMatchObject({ opening: { quantity: '0' }, movements: { SALE: { quantity: '-2', value: '-30.00' } }, closing: { quantity: '18' } });
    const after = (await report('stock-movements', later)).body.data as { variantId: string; opening: { quantity: string }; movements: Record<string, unknown> }[];
    expect(after.find((m) => m.variantId === s.cola)).toMatchObject({ opening: { quantity: '18' }, movements: {} });
  });
});
