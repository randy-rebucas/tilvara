import type { INestApplication } from '@nestjs/common';
import type { OfflineSale, Snapshot } from '@1pos/sync-protocol';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Expired and held stock, box → strip → piece and the batch trace, kept for every shop when 0112 removed
 * pharmacies (these cases came from the pharmacy suite): where a branch blocks expired stock, a counter
 * sale never takes expired or held lots (an offline one is recorded and flagged); a hold covers the whole
 * pack family; a sale opens packs up the chain; the trace follows a lot from the box to the piece sold.
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

const day = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86_400_000));

/** A retail shop whose branch blocks expired stock (the setting; no setting = ALLOW). */
async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Store`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'Counter 1' }).expect(201)).body.id as string;
  const register2 = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R2', name: 'Counter 2' }).expect(201)).body.id as string;
  await http().put(`/v1/branches/${branchId}/inventory-settings`).set(auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: true, expiredStock: 'BLOCK' }).expect(200);
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const uoms = Object.fromEntries(((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).map((u) => [u.code, u.id]));
  const product = async (name: string, price: string) =>
    (await http().post('/v1/products').set(auth).send({
      name, uomId: uoms.PC, taxCategoryId: taxes.VAT, trackInventory: true, tracksExpiry: true, variants: [{ sku: uniq('SKU'), price }],
    }).expect(201)).body.variants[0].id as string;
  const c1 = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const c2 = await addMember(owner, t.tenantId, 'senior_cashier', { type: 'BRANCH', id: branchId });
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: branchId });
  return {
    tenantId: t.tenantId, auth, branchId, registerId, register2, product,
    cashier: { ...c1, auth: bearer(await loginToken(app, c1.email)) },
    cashier2: { ...c2, auth: bearer(await loginToken(app, c2.email)) },
    manager: bearer(await loginToken(app, m.email)),
  };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const stockIn = (s: Shop, items: { variantId: string; quantity: string; expiresOn?: string; lotCode?: string }[]) =>
  http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, kind: 'ADJUSTMENT', reason: 'Delivery', items: items.map((i) => ({ unitCost: '2.00', ...i })) });
const openSession = async (auth: Auth, registerId: string) =>
  (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat: '5000.00' }).expect(201)).body.id as string;
const sell = (sessionId: string, auth: Auth, lines: Record<string, unknown>[]) =>
  http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: sessionId, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '5000.00' }] });
const onHand = async (s: Shop, variantId: string) =>
  (((await http().get('/v1/stock/balances').query({ branchId: s.branchId, variantId }).set(s.auth).expect(200)).body.data[0] as { quantity: string } | undefined)?.quantity ?? '0');
const q = <T = Record<string, unknown>>(s: Shop, text: string, params: unknown[] = []) =>
  asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(text, params)).rows as T[]);
const audit = (s: Shop) => asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c));
const link = (s: Shop, packVariantId: string, pieceVariantId: string, piecesPerPack: string) =>
  http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId, pieceVariantId, piecesPerPack }).expect(201);

describe('expired and held stock where the branch blocks it', () => {
  it('a counter sale never takes expired or held lots; holds and their release; writing off; ALLOW sells it', async () => {
    const s = await shop('exp-block');
    const tea = await s.product('Green tea', '5.50');
    await stockIn(s, [
      { variantId: tea, quantity: '5', expiresOn: day(-3), lotCode: 'OLD-1' },
      { variantId: tea, quantity: '10', expiresOn: day(200), lotCode: 'NEW-1' },
    ]).expect(201);
    const session = await openSession(s.cashier.auth, s.registerId);
    // The expired lot would be drawn first by date; here the sale takes the good lot.
    const sold = (await sell(session, s.cashier.auth, [{ variantId: tea, quantity: '10' }]).expect(201)).body;
    const drawn = await q<{ lot_code: string }>(s, `SELECT l.lot_code FROM stock_lot_movements lm JOIN stock_lots l ON l.id = lm.lot_id JOIN stock_movements m ON m.id = lm.movement_id WHERE m.sale_id = $1`, [sold.id]);
    expect(drawn.map((d) => d.lot_code)).toEqual(['NEW-1']);
    // The receipt prints the lot under the line.
    const receipt = (await http().get(`/v1/sales/${sold.id}/receipt`).set(s.cashier.auth).expect(200)).body;
    expect(receipt.lines[0].lots).toEqual([`Lot NEW-1 · Exp ${day(200).slice(5, 7)}/${day(200).slice(0, 4)}`]);
    // Only the expired five are left: refused, nothing written.
    const refused = await sell(session, s.cashier.auth, [{ variantId: tea, quantity: '1' }]).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'EXPIRED_STOCK', details: { lines: [{ variantId: tea, sellable: '0', expiredOrHeld: '5', requested: '1' }] } });
    expect(await onHand(s, tea)).toBe('5');
    // A hold works like expiry; releasing it puts the lot back on sale.
    await stockIn(s, [{ variantId: tea, quantity: '4', expiresOn: day(100), lotCode: 'REC-9' }]).expect(201);
    const hold = (await http().post('/v1/stock/lot-holds').set(s.manager).set('Idempotency-Key', randomUUID()).send({ variantId: tea, lotCode: 'rec-9 ', reason: 'Supplier recall', reference: 'REC-2026-001' })).body;
    expect(hold.error?.code).toBe('FORBIDDEN'); // every branch needs the business-wide grant
    const held = (await http().post('/v1/stock/lot-holds').set(s.auth).set('Idempotency-Key', randomUUID()).send({ variantId: tea, lotCode: 'rec-9 ', reason: 'Supplier recall', reference: 'REC-2026-001' }).expect(201)).body;
    const again = await http().post('/v1/stock/lot-holds').set(s.auth).set('Idempotency-Key', randomUUID()).send({ variantId: tea, lotCode: 'REC-9', reason: 'twice' }).expect(409);
    expect(again.body.error.code).toBe('LOT_ALREADY_HELD');
    expect((await sell(session, s.cashier.auth, [{ variantId: tea, quantity: '1' }]).expect(409)).body.error.code).toBe('EXPIRED_STOCK');
    const expiring = (await http().get('/v1/stock/expiring').query({ branchId: s.branchId, withinDays: 120 }).set(s.auth).expect(200)).body.data as { lotCode: string; held: boolean }[];
    expect(expiring.map((l) => [l.lotCode, l.held])).toEqual([['OLD-1', false], ['REC-9', true]]);
    // A held lot is listed however far its date (it is written off from there).
    const soonOnly = (await http().get('/v1/stock/expiring').query({ branchId: s.branchId, withinDays: 7 }).set(s.auth).expect(200)).body.data as { lotCode: string; held: boolean }[];
    expect(soonOnly.map((l) => [l.lotCode, l.held])).toEqual([['OLD-1', false], ['REC-9', true]]);
    const listed = (await http().get('/v1/stock/lot-holds').set(s.auth).expect(200)).body.data;
    expect(listed[0]).toMatchObject({ id: held.id, lotCode: 'rec-9', placedByName: expect.any(String), releasedByName: null });
    await http().post(`/v1/stock/lot-holds/${held.id}/release`).set(s.auth).send({ reason: 'Recall lifted' }).expect(200);
    await http().post(`/v1/stock/lot-holds/${held.id}/release`).set(s.auth).send({ reason: 'again' }).expect(409);
    await sell(session, s.cashier.auth, [{ variantId: tea, quantity: '4' }]).expect(201);
    // Writing off the expired lot by name clears it; a branch set to ALLOW sells dated stock as before.
    const lot = (await http().get('/v1/stock/lots').query({ branchId: s.branchId, variantId: tea }).set(s.auth).expect(200)).body.data[0];
    await http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID())
      .send({ branchId: s.branchId, kind: 'WASTE', reason: 'Expired', items: [{ variantId: tea, quantity: '-5', lotId: lot.lotId }] }).expect(201);
    expect(await onHand(s, tea)).toBe('0');
    await http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: true, expiredStock: 'ALLOW' }).expect(200);
    await stockIn(s, [{ variantId: tea, quantity: '2', expiresOn: day(-1), lotCode: 'X-1' }]).expect(201);
    await sell(session, s.cashier.auth, [{ variantId: tea, quantity: '2' }]).expect(201);
    expect(await q(s, `SELECT 1 FROM outbox_events WHERE topic = 'stock.expired_sold'`)).toEqual([]);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('an offline sale of expired stock is recorded, flagged and mailed about', async () => {
    const s = await shop('exp-off');
    const tea = await s.product('Green tea', '5.50');
    await stockIn(s, [{ variantId: tea, quantity: '3', expiresOn: day(-2), lotCode: 'OLD-2' }]).expect(201);
    const session = await openSession(s.cashier.auth, s.registerId);
    const terminal = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.registerId, name: 'Till 1' }).expect(201)).body;
    const headers = { 'x-terminal-id': terminal.terminal.id, Authorization: `Terminal ${terminal.credential}` };
    const snap = (await http().get('/v1/terminal/snapshot').set(headers).expect(200)).body as Snapshot;
    expect(snap.items.find((i) => i.variantId === tea)).not.toHaveProperty('drug');
    const env: OfflineSale = {
      terminalTxnId: randomUUID(), deviceSeq: 1, snapshotId: snap.snapshotId, cashierSessionId: session, cashierUserId: s.cashier.userId,
      occurredAt: new Date().toISOString(), localReference: 'R1-OFF-000001', lines: [{ variantId: tea, quantity: '2' }],
      tenders: [{ method: 'CASH', tendered: '11.00' }], amountDue: '11.00',
    };
    const res = (await http().post('/v1/sync/sales').set(headers).send({ sales: [env] }).expect(200)).body;
    expect(res.results[0]).toMatchObject({ status: 'RECORDED' });
    const recorded = (await http().get('/v1/sync/transactions?status=RECORDED').set(s.manager).expect(200)).body.data as { flags: string[] }[];
    expect(recorded[0]!.flags).toEqual(['EXPIRED_STOCK']);
    const events = await q<{ payload: { saleId: string; lots: number } }>(s, `SELECT payload FROM outbox_events WHERE topic = 'stock.expired_sold'`);
    expect(events.map((e) => e.payload)).toEqual([{ saleId: res.results[0].saleId, branchId: s.branchId, lots: 1 }]);
  });

  it('a hold stops the sale where expired stock is allowed too (no setting); expired lots still sell there', async () => {
    const s = await shop('exp-allow-hold');
    await http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: true, expiredStock: null }).expect(200);
    const tea = await s.product('Iced tea', '25.00');
    const sku = ((await http().get('/v1/products').set(s.auth).expect(200)).body.data as { variants: { id: string; sku: string }[] }[]).flatMap((p) => p.variants).find((v) => v.id === tea)!.sku;
    await stockIn(s, [
      { variantId: tea, quantity: '3', expiresOn: day(50), lotCode: 'RC-1' },
      { variantId: tea, quantity: '4', expiresOn: day(200), lotCode: 'OK-1' },
    ]).expect(201);
    const session = await openSession(s.cashier.auth, s.registerId);
    // No hold: the till's lookup says nothing about sellable stock.
    expect((await http().get('/v1/catalog/lookup').query({ code: sku, branchId: s.branchId }).set(s.auth).expect(200)).body).not.toHaveProperty('sellable');
    const held = (await http().post('/v1/stock/lot-holds').set(s.auth).set('Idempotency-Key', randomUUID()).send({ variantId: tea, lotCode: 'RC-1', reason: 'Supplier recall' }).expect(201)).body;
    expect((await http().get('/v1/catalog/lookup').query({ code: sku, branchId: s.branchId }).set(s.auth).expect(200)).body.sellable).toEqual({ onHand: '7', expiredOrHeld: '3', sellable: '4' });
    // The sale takes the good lot though the held one expires first, then refuses what only the held lot could fill.
    const sold = (await sell(session, s.cashier.auth, [{ variantId: tea, quantity: '4' }]).expect(201)).body;
    const drawn = await q<{ lot_code: string }>(s, `SELECT l.lot_code FROM stock_lot_movements lm JOIN stock_lots l ON l.id = lm.lot_id JOIN stock_movements m ON m.id = lm.movement_id WHERE m.sale_id = $1`, [sold.id]);
    expect(drawn.map((d) => d.lot_code)).toEqual(['OK-1']);
    const refused = (await sell(session, s.cashier.auth, [{ variantId: tea, quantity: '1' }]).expect(409)).body.error;
    expect(refused).toMatchObject({ code: 'EXPIRED_STOCK', details: { lines: [{ variantId: tea, sellable: '0', expiredOrHeld: '3', requested: '1' }] } });
    expect(refused.message).toMatch(/^Only held stock is left/);
    // An expired lot is sold where the branch allows it.
    await stockIn(s, [{ variantId: tea, quantity: '2', expiresOn: day(-1), lotCode: 'EX-1' }]).expect(201);
    await sell(session, s.cashier.auth, [{ variantId: tea, quantity: '2' }]).expect(201);
    await http().post(`/v1/stock/lot-holds/${held.id}/release`).set(s.auth).send({ reason: 'Recall lifted' }).expect(200);
    await sell(session, s.cashier.auth, [{ variantId: tea, quantity: '3' }]).expect(201);
    expect(await onHand(s, tea)).toBe('0');
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('a hold on a box stops the loose pieces of its lot (the whole pack family)', async () => {
    const s = await shop('exp-hold');
    const box = await s.product('Candy box of 10', '70.00');
    const piece = await s.product('Candy', '7.50');
    await link(s, box, piece, '10');
    await stockIn(s, [{ variantId: box, quantity: '1', expiresOn: day(300), lotCode: 'H-1' }]).expect(201);
    const session = await openSession(s.cashier.auth, s.registerId);
    await sell(session, s.cashier.auth, [{ variantId: piece, quantity: '1' }]).expect(201); // opens the box: 9 pieces of lot H-1
    await http().post('/v1/stock/lot-holds').set(s.auth).set('Idempotency-Key', randomUUID()).send({ variantId: box, lotCode: 'H-1', reason: 'Recall', reference: 'REC-2026-002' }).expect(201);
    expect((await sell(session, s.cashier.auth, [{ variantId: piece, quantity: '1' }]).expect(409)).body.error).toMatchObject({ code: 'EXPIRED_STOCK', details: { lines: [{ variantId: piece, expiredOrHeld: '9' }] } });
  });
});

describe('box, strip and piece', () => {
  it('a sale short of pieces opens a strip, and a box for the strip, in its own transaction; the trace follows the lot', async () => {
    const s = await shop('pack-chain');
    const box = await s.product('Gum box of 100', '650.00');
    const strip = await s.product('Gum strip of 10', '70.00');
    const piece = await s.product('Gum piece', '7.50');
    await link(s, box, strip, '10');
    await link(s, strip, piece, '10');
    await stockIn(s, [{ variantId: box, quantity: '2', expiresOn: day(400), lotCode: 'MF-55' }]).expect(201);
    const session = await openSession(s.cashier.auth, s.registerId);
    const sold = (await sell(session, s.cashier.auth, [{ variantId: piece, quantity: '5' }]).expect(201)).body;
    expect([await onHand(s, box), await onHand(s, strip), await onHand(s, piece)]).toEqual(['1', '9', '5']);
    const openings = await q<{ packs: string; pieces: string; sale_id: string }>(s, `SELECT trim_scale(packs)::text AS packs, trim_scale(pieces)::text AS pieces, sale_id FROM pack_openings ORDER BY created_at`);
    expect(openings).toEqual([{ packs: '1', pieces: '10', sale_id: sold.id }, { packs: '1', pieces: '10', sale_id: sold.id }]);
    // Two tills selling at once never open the same box twice (the branch refuses selling below zero).
    await http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'BLOCK', lowStockAlerts: true, expiredStock: 'BLOCK' }).expect(200);
    const s2 = await openSession(s.cashier2.auth, s.register2);
    const results = await Promise.all([
      sell(session, s.cashier.auth, [{ variantId: piece, quantity: '100' }]),
      sell(s2, s.cashier2.auth, [{ variantId: piece, quantity: '100' }]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await audit(s)).toEqual(CLEAN);
    // The batch trace follows the lot from the box down to the piece sold.
    const trace = (await http().get('/v1/stock/lots/trace').query({ variantId: box, lotCode: 'mf-55' }).set(s.manager).expect(200)).body;
    expect(trace.movements.map((m: { name: string; type: string; quantity: string }) => [m.name, m.type, m.quantity]).slice(0, 7)).toEqual([
      ['Gum box of 100', 'ADJUSTMENT', '2'],
      ['Gum box of 100', 'UNPACK_OUT', '-1'],
      ['Gum strip of 10', 'UNPACK_IN', '10'],
      ['Gum strip of 10', 'UNPACK_OUT', '-1'],
      ['Gum piece', 'UNPACK_IN', '10'],
      ['Gum piece', 'SALE', '-5'],
      expect.anything(),
    ]);
    const saleRow = trace.movements.find((m: { type: string; sale: unknown }) => m.type === 'SALE');
    expect(saleRow.sale).toMatchObject({ id: sold.id });
    expect(saleRow).not.toHaveProperty('prescriptionIds');
  });
});

describe('whether a shop uses dated stock and packs', () => {
  it('reads false for a new shop, then true once an item keeps expiry dates or a pack is linked; needs inventory.read', async () => {
    const t = await signup(app, 'in-use');
    const auth = bearer(t.access);
    expect((await http().get('/v1/stock/in-use').set(auth).expect(200)).body).toEqual({ expiry: false, packs: false });
    const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
    const uoms = Object.fromEntries(((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).map((u) => [u.code, u.id]));
    const product = async (name: string, tracksExpiry: boolean) =>
      (await http().post('/v1/products').set(auth).send({
        name, uomId: uoms.PC, taxCategoryId: taxes.VAT, trackInventory: true, tracksExpiry, variants: [{ sku: uniq('SKU'), price: '10.00' }],
      }).expect(201)).body.variants[0].id as string;
    const box = await product('Soap box', false);
    const bar = await product('Soap bar', false);
    expect((await http().get('/v1/stock/in-use').set(auth).expect(200)).body).toEqual({ expiry: false, packs: false });
    await http().post('/v1/pack-conversions').set(auth).send({ packVariantId: box, pieceVariantId: bar, piecesPerPack: '12' }).expect(201);
    expect((await http().get('/v1/stock/in-use').set(auth).expect(200)).body).toEqual({ expiry: false, packs: true });
    await product('Milk', true);
    expect((await http().get('/v1/stock/in-use').set(auth).expect(200)).body).toEqual({ expiry: true, packs: true });

    const cashier = await addMember(owner, t.tenantId, 'cashier');
    const cashierAuth = bearer(await loginToken(app, cashier.email));
    await http().get('/v1/stock/in-use').set(cashierAuth).expect(403);
  });
});
