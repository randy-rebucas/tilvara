import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Packs and pieces (tingi, ADR-0020 §2): links between a pack and the piece sold from it, opening packs
 * by hand, and a sale short of pieces opening packs by itself, in its own transaction.
 */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
type Auth = { Authorization: string };

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

async function store(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  await http().patch('/v1/business').set(auth).send({ businessType: 'GROCERY' }).expect(200);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Store`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'Counter 1' }).expect(201)).body.id as string;
  const register2 = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R2', name: 'Counter 2' }).expect(201)).body.id as string;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const uoms = Object.fromEntries(((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).map((u) => [u.code, u.id]));
  const product = async (name: string, price: string, extra: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: uoms.PC, taxCategoryId: taxes.VAT, ...extra, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const c2 = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: branchId });
  return {
    tenantId: t.tenantId, auth, branchId, registerId, register2, product, uoms,
    cashier: bearer(await loginToken(app, c.email)),
    cashier2: bearer(await loginToken(app, c2.email)),
    manager: bearer(await loginToken(app, m.email)),
  };
}
type Store = Awaited<ReturnType<typeof store>>;

const stockIn = (s: Store, variantId: string, quantity: string, unitCost = '200.00') =>
  http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Delivery', items: [{ variantId, quantity, unitCost }] }).expect(201);
const link = (s: Store, packVariantId: string, pieceVariantId: string, piecesPerPack = '20', extra: Record<string, unknown> = {}, auth: Auth = s.auth) =>
  http().post('/v1/pack-conversions').set(auth).send({ packVariantId, pieceVariantId, piecesPerPack, ...extra });
const openSession = async (s: Store, auth: Auth = s.cashier, registerId = s.registerId) =>
  (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
const sell = (s: Store, sessionId: string, lines: { variantId: string; quantity: string }[], auth: Auth = s.cashier) =>
  http()
    .post('/v1/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: sessionId, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '1000.00' }] });
const balance = async (s: Store, variantId: string) =>
  ((await http().get('/v1/stock/balances').query({ branchId: s.branchId, variantId }).set(s.auth).expect(200)).body.data[0] as { quantity: string; value: string; avgCost: string } | undefined) ?? { quantity: '0', value: '0.00', avgCost: '0.0000' };
const onHand = async (s: Store, variantId: string) => (await balance(s, variantId)).quantity;
const setPolicy = (s: Store, negativeStockPolicy: string) =>
  http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).send({ negativeStockPolicy, lowStockAlerts: true }).expect(200);
const q = <T = Record<string, unknown>>(s: Store, text: string, params: unknown[] = []) =>
  asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(text, params)).rows as T[]);

/** A pack of 20 sticks at ₱200 a pack (₱10 a stick at cost), sold at ₱240 a pack or ₱13 a stick. */
async function cigarettes(s: Store) {
  const pack = await s.product('Cigarettes (pack of 20)', '240.00', { trackInventory: true });
  const stick = await s.product('Cigarette stick', '13.00', { trackInventory: true });
  const res = await link(s, pack, stick).expect(201);
  return { pack, stick, linkId: res.body.id as string };
}

describe('pack links', () => {
  it('are set by catalog.manage, read by anyone with the catalog, one pack per piece, never in a loop', async () => {
    const s = await store('pk-links');
    const pack = await s.product('Coffee (tie of 10)', '85.00');
    const sachet = await s.product('Coffee sachet', '9.00');
    expect((await link(s, pack, sachet, '10', {}, s.cashier).expect(403)).body.error.code).toBe('FORBIDDEN');
    const made = (await link(s, pack, sachet, '10').expect(201)).body;
    expect(made).toMatchObject({ pack: { variantId: pack, name: 'Coffee (tie of 10)' }, piece: { variantId: sachet, name: 'Coffee sachet' }, piecesPerPack: '10', autoOpen: true, archivedAt: null });
    // The cashier's catalog is branch-scoped: still readable.
    expect((await http().get('/v1/pack-conversions').query({ variantId: sachet }).set(s.cashier).expect(200)).body.data.map((l: { id: string }) => l.id)).toEqual([made.id]);

    const other = await s.product('Coffee (box of 10)', '84.00');
    expect((await link(s, other, sachet, '10').expect(409)).body.error.code).toBe('PIECE_HAS_PACK');
    // A case of 12 ties is fine; the tie back into the case is a loop.
    const box = await s.product('Coffee case (12 ties)', '990.00');
    await link(s, box, pack, '12').expect(201);
    expect((await link(s, sachet, box, '2').expect(422)).body.error.code).toBe('PACK_LOOP');
    expect((await link(s, pack, pack, '2').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await link(s, other, await s.product('Loose', '1.00'), '1').expect(400)).body.error.code).toBe('VALIDATION_FAILED');

    // Pieces counted whole: a pack of 2.5 is refused; a kilo unit takes a sack of 25.5.
    expect((await link(s, other, await s.product('Candy', '1.00'), '2.5').expect(422)).body.error.code).toBe('FRACTIONAL_PIECES');
    const sack = await s.product('Rice sack', '1300.00');
    const kilo = await s.product('Rice per kilo', '55.00', { uomId: s.uoms.KG, soldBy: 'WEIGHT' });
    expect((await link(s, sack, kilo, '25.5').expect(201)).body.piecesPerPack).toBe('25.5');
    const untracked = await s.product('Service fee', '5.00', { trackInventory: false });
    expect((await link(s, other, untracked, '10').expect(422)).body.error.code).toBe('NOT_TRACKED');

    // Turn automatic opening off; archive; a new link with a new count takes its place.
    expect((await http().patch(`/v1/pack-conversions/${made.id}`).set(s.auth).send({ autoOpen: false }).expect(200)).body.autoOpen).toBe(false);
    await http().post(`/v1/pack-conversions/${made.id}/archive`).set(s.auth).expect(200);
    expect((await http().post(`/v1/pack-conversions/${made.id}/archive`).set(s.auth).expect(409)).body.error.code).toBe('ARCHIVED');
    await link(s, other, sachet, '10').expect(201);
    expect((await q<{ action: string }>(s, `SELECT action FROM audit_logs WHERE resource_type = 'pack_conversion' ORDER BY occurred_at`)).map((r) => r.action)).toEqual([
      'pack_link.created', 'pack_link.created', 'pack_link.created', 'pack_link.updated', 'pack_link.archived', 'pack_link.created',
    ]);

    // DB guards: the count never changes, an archived link stays archived, nothing is deleted.
    for (const sql of [
      `UPDATE pack_conversions SET pieces_per_pack = 12 WHERE id = '${made.id}'`,
      `UPDATE pack_conversions SET archived_at = NULL WHERE id = '${made.id}'`,
      `DELETE FROM pack_conversions WHERE id = '${made.id}'`,
    ]) {
      await expect(q(s, sql)).rejects.toThrow();
    }
  });
});

describe('opening packs', () => {
  it('by hand moves packs out and pieces in at the pack cost, posts nothing, and is audited', async () => {
    const s = await store('pk-open');
    const { pack, stick, linkId } = await cigarettes(s);
    await stockIn(s, pack, '3');
    const open = (body: Record<string, unknown>, auth: Auth = s.auth) =>
      http().post('/v1/stock/pack-openings').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, conversionId: linkId, packs: '1', reason: 'Shelf', ...body });
    expect((await open({}, s.cashier).expect(403)).body.error.code).toBe('FORBIDDEN');
    expect((await open({ packs: '1.5' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    const opening = (await open({}, s.manager).expect(201)).body;
    expect(opening).toMatchObject({ packs: '1', pieces: '20', packsValue: '200.00', piecesValue: '200.00', saleId: null, reason: 'Shelf', pack: { variantId: pack }, piece: { variantId: stick } });
    expect(await balance(s, pack)).toMatchObject({ quantity: '2', value: '400.00' });
    expect(await balance(s, stick)).toMatchObject({ quantity: '20', value: '200.00', avgCost: '10.0000' });
    expect(await q(s, `SELECT 1 FROM journal_entries WHERE source_type = 'PACK_OPENING'`)).toEqual([]);
    expect((await q<{ action: string }>(s, `SELECT action FROM audit_logs WHERE resource_type = 'pack_opening'`)).map((r) => r.action)).toEqual(['stock.pack_opened']);
    expect((await http().get('/v1/stock/pack-openings').query({ branchId: s.branchId }).set(s.manager).expect(200)).body.data.map((o: { id: string }) => o.id)).toEqual([opening.id]);
    expect((await http().get(`/v1/stock/pack-openings/${opening.id}`).set(s.cashier).expect(403)).body.error.code).toBe('FORBIDDEN');
    const moved = await q<{ type: string; quantity: string; value: string }>(s, `SELECT type, quantity::text, value::text FROM stock_movements WHERE pack_opening_id = $1 ORDER BY type`, [opening.id]);
    expect(moved).toEqual([{ type: 'UNPACK_IN', quantity: '20.0000', value: '200.0000' }, { type: 'UNPACK_OUT', quantity: '-1.0000', value: '-200.0000' }]);

    // Under BLOCK, never more packs than are there.
    await setPolicy(s, 'BLOCK');
    expect((await open({ packs: '3' }).expect(409)).body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { lines: [{ available: '2', requested: '3' }] } });
    expect(await onHand(s, pack)).toBe('2');

    // DB guards: openings are append-only; movements must match their opening.
    await expect(q(s, `UPDATE pack_openings SET reason = 'x' WHERE id = '${opening.id}'`)).rejects.toThrow();
    await expect(q(s, `INSERT INTO pack_openings (tenant_id, branch_id, conversion_id, packs, pieces, reason, created_by) VALUES ('${s.tenantId}', '${s.branchId}', '${linkId}', 1, 19, 'x', '${opening.createdBy}')`)).rejects.toThrow(/packs × the link/);
    await expect(
      q(s, `INSERT INTO stock_movements (tenant_id, branch_id, variant_id, quantity, unit_cost, type, pack_opening_id, created_by) VALUES ('${s.tenantId}', '${s.branchId}', '${stick}', 20, 10, 'UNPACK_IN', '${opening.id}', '${opening.createdBy}')`),
    ).rejects.toThrow(/does not match its opening/);
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('a sale short of pieces opens just enough packs, in its own transaction, and the books still tie', async () => {
    const s = await store('pk-sale');
    const { pack, stick } = await cigarettes(s);
    await stockIn(s, pack, '2');
    const session = await openSession(s);
    const sale = (await sell(s, session, [{ variantId: stick, quantity: '3' }]).expect(201)).body;
    expect(await onHand(s, pack)).toBe('1');
    expect(await balance(s, stick)).toMatchObject({ quantity: '17', value: '170.00' });
    const openings = await q<{ sale_id: string; packs: string; pieces: string; created_by: string }>(s, `SELECT sale_id, packs::text, pieces::text, created_by FROM pack_openings`);
    expect(openings).toEqual([expect.objectContaining({ sale_id: sale.id, packs: '1.0000', pieces: '20.0000' })]);
    // COGS is the three sticks at the pack's cost.
    const [cogs] = await q<{ amount: string }>(s, `
      SELECT sum(l.debit - l.credit)::text AS amount FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
       WHERE e.source_type = 'SALE' AND e.source_id = $1 AND a.system_key = 'COGS'`, [sale.id]);
    expect(cogs!.amount).toBe('30.0000');
    const [audit] = await q<{ metadata: { packOpenings?: string[] } }>(s, `SELECT metadata FROM audit_logs WHERE action = 'sale.completed' AND resource_id = $1`, [sale.id]);
    expect(audit!.metadata.packOpenings).toHaveLength(1);

    // Enough pieces: nothing opens. 17 + 20 covers 30 with one pack, never two.
    await sell(s, session, [{ variantId: stick, quantity: '17' }]).expect(201);
    expect(await q(s, `SELECT 1 FROM pack_openings`)).toHaveLength(1);
    await sell(s, session, [{ variantId: stick, quantity: '15' }]).expect(201);
    expect(await onHand(s, pack)).toBe('0');
    expect(await onHand(s, stick)).toBe('5');
    // Selling the pack and its pieces together: the pack sold is not opened.
    await stockIn(s, pack, '1');
    await sell(s, session, [{ variantId: pack, quantity: '1' }, { variantId: stick, quantity: '6' }]).expect(201);
    expect(await onHand(s, pack)).toBe('0');
    expect(await onHand(s, stick)).toBe('-1');
    expect(await q(s, `SELECT 1 FROM pack_openings`)).toHaveLength(2);

    // Pieces sold short are revalued when the next pack (dearer: ₱240 → ₱12 a stick) is opened: +₱2 to COGS.
    await stockIn(s, pack, '1', '240.00');
    await sell(s, session, [{ variantId: stick, quantity: '1' }]).expect(201);
    expect(await balance(s, stick)).toMatchObject({ quantity: '18', avgCost: '12.0000', value: '216.00' });
    const [last] = await q<{ id: string }>(s, `SELECT id FROM pack_openings ORDER BY created_at DESC, id DESC LIMIT 1`);
    const entry = await q<{ key: string; net: string }>(s, `
      SELECT a.system_key AS key, sum(l.debit - l.credit)::text AS net FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
       WHERE e.source_type = 'PACK_OPENING' AND e.source_id = $1 GROUP BY 1 ORDER BY 1`, [last!.id]);
    expect(entry).toEqual([{ key: 'COGS', net: '2.0000' }, { key: 'INVENTORY', net: '-2.0000' }]);
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('respects reservations and automatic opening turned off', async () => {
    const s = await store('pk-reserve');
    const { pack, stick, linkId } = await cigarettes(s);
    await stockIn(s, pack, '1');
    await http().post('/v1/stock/reservations').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, variantId: pack, quantity: '1', note: 'For Mang Ben' }).expect(201);
    const session = await openSession(s);
    await sell(s, session, [{ variantId: stick, quantity: '2' }]).expect(201);
    expect(await onHand(s, pack)).toBe('1');
    expect(await onHand(s, stick)).toBe('-2');

    const other = await store('pk-manual');
    const c = await cigarettes(other);
    await stockIn(other, c.pack, '1');
    await http().patch(`/v1/pack-conversions/${c.linkId}`).set(other.auth).send({ autoOpen: false }).expect(200);
    await sell(other, await openSession(other), [{ variantId: c.stick, quantity: '2' }]).expect(201);
    expect(await onHand(other, c.pack)).toBe('1');
    expect(linkId).not.toBe(c.linkId);
  });

  it('under BLOCK the sale counts the packs it can open; refused, it opens nothing; two tills cannot share the last pack', async () => {
    const s = await store('pk-block');
    const { pack, stick } = await cigarettes(s);
    await stockIn(s, pack, '1');
    await setPolicy(s, 'BLOCK');
    const a = await openSession(s, s.cashier, s.registerId);
    expect((await sell(s, a, [{ variantId: stick, quantity: '21' }]).expect(409)).body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await q(s, `SELECT 1 FROM pack_openings`)).toEqual([]);
    expect(await onHand(s, pack)).toBe('1');

    const b = await openSession(s, s.cashier2, s.register2);
    const [x, y] = await Promise.all([sell(s, a, [{ variantId: stick, quantity: '15' }], s.cashier), sell(s, b, [{ variantId: stick, quantity: '15' }], s.cashier2)]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(await q(s, `SELECT 1 FROM pack_openings`)).toHaveLength(1);
    expect(await onHand(s, pack)).toBe('0');
    expect(await onHand(s, stick)).toBe('5');
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });
});
