import type { INestApplication } from '@nestjs/common';
import type { OfflineSale, Snapshot } from '@1pos/sync-protocol';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
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
  await http().post('/v1/stock/adjustments').set(auth).send({ branchId, reason: 'Opening', items: [{ variantId: cola, quantity: '20', unitCost: '15.00' }, { variantId: chips, quantity: '20', unitCost: '20.00' }] }).expect(201);
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
      UPDATE product_prices SET effective_from = effective_from - interval '2 days';
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
});
