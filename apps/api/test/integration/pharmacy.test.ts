import type { INestApplication } from '@nestjs/common';
import type { OfflineSale, Snapshot } from '@1pos/sync-protocol';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, PASSWORD, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Pharmacies and drugstores (ADR-0025): drug details and generic lookup, lot codes, expired and held stock
 * never sold where blocked (flagged offline), prescriptions by class with the pharmacist's approval at the
 * till, dangerous drugs, returns giving pieces back, box → strip → piece at the sale, SC/PWD purchase
 * booklets, the batch trace and the two books.
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
type Drug = { drugClass: string; genericName: string; strength?: string; dosageForm: string };

async function pharmacy(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  await http().patch('/v1/business').set(auth).send({ businessType: 'PHARMACY' }).expect(200);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Drug`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'Counter 1' }).expect(201)).body.id as string;
  const register2 = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R2', name: 'Counter 2' }).expect(201)).body.id as string;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const uoms = Object.fromEntries(((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).map((u) => [u.code, u.id]));
  const product = async (name: string, price: string, drug: Drug | null, extra: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({
      name, uomId: uoms.PC, taxCategoryId: taxes.VAT, trackInventory: true, tracksExpiry: true, ...(drug && { drug }), ...extra, variants: [{ sku: uniq('SKU'), price }],
    }).expect(201)).body.variants[0].id as string;
  const ph = await addMember(owner, t.tenantId, 'pharmacist', { type: 'BRANCH', id: branchId });
  const as = await addMember(owner, t.tenantId, 'pharmacy_assistant', { type: 'BRANCH', id: branchId });
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: branchId });
  return {
    tenantId: t.tenantId, auth, branchId, registerId, register2, product, legalEntityId: le.body.id as string,
    pharmacist: { ...ph, auth: bearer(await loginToken(app, ph.email)) },
    assistant: { ...as, auth: bearer(await loginToken(app, as.email)) },
    manager: bearer(await loginToken(app, m.email)),
  };
}
type Store = Awaited<ReturnType<typeof pharmacy>>;

const stockIn = (s: Store, items: { variantId: string; quantity: string; expiresOn?: string; lotCode?: string }[], auth: Auth = s.auth) =>
  http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, kind: 'ADJUSTMENT', reason: 'Delivery', items: items.map((i) => ({ unitCost: '2.00', ...i })) });
const openSession = async (s: Store, auth: Auth, registerId = s.registerId) =>
  (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat: '5000.00' }).expect(201)).body.id as string;
const sell = (sessionId: string, auth: Auth, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: sessionId, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '5000.00' }], ...extra });
const onHand = async (s: Store, variantId: string) =>
  (((await http().get('/v1/stock/balances').query({ branchId: s.branchId, variantId }).set(s.auth).expect(200)).body.data[0] as { quantity: string } | undefined)?.quantity ?? '0');
const q = <T = Record<string, unknown>>(s: Store, text: string, params: unknown[] = []) =>
  asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(text, params)).rows as T[]);
const audit = (s: Store) => asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c));

const rx = (ref: string, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  ref, patientName: 'Juan Dela Cruz', prescriberName: 'Dr. Ana Santos', prescriberLicenseNo: 'PRC-0123456', issuedOn: day(-1),
  items: items.map((it, i) => ({ ref: `i${i + 1}`, ...it })), ...extra,
});
const AMOX: Drug = { drugClass: 'ANTIBIOTIC', genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE' };
const PARA: Drug = { drugClass: 'OTC', genericName: 'Paracetamol', strength: '500 mg', dosageForm: 'TABLET' };

describe('business type, drug details and lookup', () => {
  it('a pharmacy gets its roles, its products carry drug details, search and the snapshot find them by generic name', async () => {
    const s = await pharmacy('rx-type');
    const roles = (await q<{ key: string }>(s, `SELECT key FROM roles WHERE is_system ORDER BY key`)).map((r) => r.key);
    expect(roles).toEqual(expect.arrayContaining(['pharmacist', 'pharmacy_assistant']));
    const brand = await s.product('Amoxil 500', '18.00', AMOX);
    const generic = await s.product('Amoxicillin RiteMed', '9.00', { ...AMOX, genericName: '  amoxicillin ', strength: '500MG' });
    const product = (await http().get('/v1/products').query({ q: 'amoxicillin' }).set(s.auth).expect(200)).body.data as { name: string; drugClass: string; genericKey: string }[];
    expect(product.map((p) => p.name).sort()).toEqual(['Amoxicillin RiteMed', 'Amoxil 500']);
    expect(new Set(product.map((p) => p.genericKey))).toEqual(new Set(['amoxicillin|500mg|CAPSULE']));
    const sku = (await q<{ sku: string }>(s, `SELECT sku FROM product_variants WHERE id = $1`, [brand]))[0]!.sku;
    const hit = (await http().get('/v1/catalog/lookup').query({ code: sku, branchId: s.branchId }).set(s.assistant.auth).expect(200)).body;
    expect(hit.drug).toEqual({ drugClass: 'ANTIBIOTIC', genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE', genericKey: 'amoxicillin|500mg|CAPSULE', piecesPerUnit: '1' });
    expect(hit.sellable).toEqual({ onHand: '0', expiredOrHeld: '0', sellable: '0' });
    // Equivalents: the other brand, cheapest first, with what is sellable here.
    await stockIn(s, [{ variantId: generic, quantity: '30', expiresOn: day(300), lotCode: 'G-1' }]).expect(201);
    const eq = (await http().get('/v1/catalog/equivalents').query({ branchId: s.branchId, variantId: brand }).set(s.assistant.auth).expect(200)).body;
    expect(eq).toMatchObject({ generic: 'Amoxicillin 500 mg capsule', data: [{ variantId: generic, unitPrice: '9.00', sellable: '30', drugClass: 'ANTIBIOTIC' }] });
    // The branch blocks expired stock by default for a pharmacy.
    expect((await http().get(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).expect(200)).body).toMatchObject({ expiredStock: null, expiredStockRule: 'BLOCK' });
    // A retail shop may sell OTC medicines but not prescription ones.
    const shop = await signup(app, 'rx-shop');
    const sa = bearer(shop.access);
    await http().patch('/v1/business').set(sa).send({ businessType: 'RETAIL' }).expect(200);
    const taxes = ((await http().get('/v1/tax-categories').set(sa)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
    const pc = ((await http().get('/v1/uoms').set(sa)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
    const body = (drug: Drug) => ({ name: 'Med', uomId: pc, taxCategoryId: taxes, drug, variants: [{ sku: uniq('S'), price: '5.00' }] });
    await http().post('/v1/products').set(sa).send(body(PARA)).expect(201);
    const refused = await http().post('/v1/products').set(sa).send(body(AMOX)).expect(403);
    expect(refused.body.error.code).toBe('BUSINESS_TYPE_EXCLUDES_FEATURE');
    // Changing the class is audited with the old and new class.
    const productId = (await q<{ product_id: string }>(s, `SELECT product_id FROM product_variants WHERE id = $1`, [brand]))[0]!.product_id;
    await http().patch(`/v1/products/${productId}`).set(s.auth).send({ drug: { ...AMOX, drugClass: 'RX' } }).expect(200);
    const logged = await q<{ metadata: { drugClass: unknown } }>(s, `SELECT metadata FROM audit_logs WHERE action = 'product.updated' AND resource_id = $1`, [productId]);
    expect(logged[0]!.metadata.drugClass).toEqual({ from: 'ANTIBIOTIC', to: 'RX' });
  });

  it('a medicine received with a date needs its lot number', async () => {
    const s = await pharmacy('rx-lot');
    const para = await s.product('Biogesic', '5.50', PARA);
    const res = await stockIn(s, [{ variantId: para, quantity: '10', expiresOn: day(200) }]).expect(422);
    expect(res.body.error.code).toBe('LOT_CODE_REQUIRED');
    await stockIn(s, [{ variantId: para, quantity: '10', expiresOn: day(200), lotCode: 'B-77' }]).expect(201);
  });
});

describe('expired and held stock', () => {
  it('a counter sale never takes expired or held lots where blocked; the receipt names the lot', async () => {
    const s = await pharmacy('rx-exp');
    const para = await s.product('Biogesic', '5.50', PARA);
    await stockIn(s, [
      { variantId: para, quantity: '5', expiresOn: day(-3), lotCode: 'OLD-1' },
      { variantId: para, quantity: '10', expiresOn: day(200), lotCode: 'NEW-1' },
    ]).expect(201);
    const session = await openSession(s, s.assistant.auth);
    // The expired lot would be drawn first by date; here the sale takes the good lot.
    const sold = (await sell(session, s.assistant.auth, [{ variantId: para, quantity: '10' }]).expect(201)).body;
    const receipt = (await http().get(`/v1/sales/${sold.id}/receipt`).set(s.assistant.auth).expect(200)).body;
    expect(receipt.lines[0]).toMatchObject({ generic: 'Paracetamol 500 mg tablet', lots: [`Lot NEW-1 · Exp ${day(200).slice(5, 7)}/${day(200).slice(0, 4)}`] });
    expect(sold.lines[0]).toMatchObject({ drugClass: 'OTC', drugLabel: 'Paracetamol 500 mg tablet' });
    // Only the expired five are left: refused, nothing written.
    const refused = await sell(session, s.assistant.auth, [{ variantId: para, quantity: '1' }]).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'EXPIRED_STOCK', details: { lines: [{ variantId: para, sellable: '0', expiredOrHeld: '5', requested: '1' }] } });
    expect(await onHand(s, para)).toBe('5');
    // A hold works like expiry; releasing it puts the lot back on sale.
    await stockIn(s, [{ variantId: para, quantity: '4', expiresOn: day(100), lotCode: 'REC-9' }]).expect(201);
    const hold = (await http().post('/v1/stock/lot-holds').set(s.manager).set('Idempotency-Key', randomUUID()).send({ variantId: para, lotCode: 'rec-9 ', reason: 'FDA advisory', reference: 'FDA-2026-001' })).body;
    expect(hold.error?.code).toBe('FORBIDDEN'); // every branch needs the business-wide grant
    const held = (await http().post('/v1/stock/lot-holds').set(s.auth).set('Idempotency-Key', randomUUID()).send({ variantId: para, lotCode: 'rec-9 ', reason: 'FDA advisory', reference: 'FDA-2026-001' }).expect(201)).body;
    const again = await http().post('/v1/stock/lot-holds').set(s.auth).set('Idempotency-Key', randomUUID()).send({ variantId: para, lotCode: 'REC-9', reason: 'twice' }).expect(409);
    expect(again.body.error.code).toBe('LOT_ALREADY_HELD');
    expect((await sell(session, s.assistant.auth, [{ variantId: para, quantity: '1' }]).expect(409)).body.error.code).toBe('EXPIRED_STOCK');
    const expiring = (await http().get('/v1/stock/expiring').query({ branchId: s.branchId, withinDays: 120 }).set(s.auth).expect(200)).body.data as { lotCode: string; held: boolean }[];
    expect(expiring.map((l) => [l.lotCode, l.held])).toEqual([['OLD-1', false], ['REC-9', true]]);
    // A held lot is listed however far its date (it is written off from there).
    const soonOnly = (await http().get('/v1/stock/expiring').query({ branchId: s.branchId, withinDays: 7 }).set(s.auth).expect(200)).body.data as { lotCode: string; held: boolean }[];
    expect(soonOnly.map((l) => [l.lotCode, l.held])).toEqual([['OLD-1', false], ['REC-9', true]]);
    const listed = (await http().get('/v1/stock/lot-holds').set(s.auth).expect(200)).body.data;
    expect(listed[0]).toMatchObject({ id: held.id, lotCode: 'rec-9', placedByName: expect.any(String), releasedByName: null });
    await http().post(`/v1/stock/lot-holds/${held.id}/release`).set(s.auth).send({ reason: 'Advisory lifted' }).expect(200);
    await http().post(`/v1/stock/lot-holds/${held.id}/release`).set(s.auth).send({ reason: 'again' }).expect(409);
    await sell(session, s.assistant.auth, [{ variantId: para, quantity: '4' }]).expect(201);
    // Writing off the expired lot by name clears it; a branch set to ALLOW sells dated stock as before.
    const lot = (await http().get('/v1/stock/lots').query({ branchId: s.branchId, variantId: para }).set(s.auth).expect(200)).body.data[0];
    await http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID())
      .send({ branchId: s.branchId, kind: 'WASTE', reason: 'Expired', items: [{ variantId: para, quantity: '-5', lotId: lot.lotId }] }).expect(201);
    expect(await onHand(s, para)).toBe('0');
    await http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: true, expiredStock: 'ALLOW' }).expect(200);
    await stockIn(s, [{ variantId: para, quantity: '2', expiresOn: day(-1), lotCode: 'X-1' }]).expect(201);
    await sell(session, s.assistant.auth, [{ variantId: para, quantity: '2' }]).expect(201);
    expect(await q(s, `SELECT 1 FROM outbox_events WHERE topic = 'stock.expired_sold'`)).toEqual([]);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('an offline sale of expired stock is recorded, flagged for review and mailed about', async () => {
    const s = await pharmacy('rx-exp-off');
    const para = await s.product('Biogesic', '5.50', PARA);
    await stockIn(s, [{ variantId: para, quantity: '3', expiresOn: day(-2), lotCode: 'OLD-2' }]).expect(201);
    const session = await openSession(s, s.assistant.auth);
    const terminal = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.registerId, name: 'Till 1' }).expect(201)).body;
    const headers = { 'x-terminal-id': terminal.terminal.id, Authorization: `Terminal ${terminal.credential}` };
    const snap = (await http().get('/v1/terminal/snapshot').set(headers).expect(200)).body as Snapshot;
    expect(snap.items.find((i) => i.variantId === para)!.drug).toMatchObject({ drugClass: 'OTC', genericName: 'Paracetamol' });
    const env: OfflineSale = {
      terminalTxnId: randomUUID(), deviceSeq: 1, snapshotId: snap.snapshotId, cashierSessionId: session, cashierUserId: s.assistant.userId,
      occurredAt: new Date().toISOString(), localReference: 'R1-OFF-000001', lines: [{ variantId: para, quantity: '2' }],
      tenders: [{ method: 'CASH', tendered: '11.00' }], amountDue: '11.00',
    };
    const res = (await http().post('/v1/sync/sales').set(headers).send({ sales: [env] }).expect(200)).body;
    expect(res.results[0]).toMatchObject({ status: 'RECORDED' });
    const recorded = (await http().get('/v1/sync/transactions?status=RECORDED').set(s.manager).expect(200)).body.data as { flags: string[] }[];
    expect(recorded[0]!.flags).toEqual(['EXPIRED_STOCK']);
    const events = await q<{ payload: { saleId: string; lots: number } }>(s, `SELECT payload FROM outbox_events WHERE topic = 'stock.expired_sold'`);
    expect(events.map((e) => e.payload)).toEqual([{ saleId: res.results[0].saleId, branchId: s.branchId, lots: 1 }]);
  });
});

describe('prescriptions', () => {
  it('an antibiotic needs a prescription and a pharmacist; the approval is used once; refills, brands and returns', async () => {
    const s = await pharmacy('rx-fill');
    const amox = await s.product('Amoxil 500', '18.00', AMOX);
    const generic = await s.product('Amoxicillin RiteMed', '9.00', AMOX);
    const para = await s.product('Biogesic', '5.50', PARA);
    await stockIn(s, [
      { variantId: amox, quantity: '50', expiresOn: day(300), lotCode: 'A-1' },
      { variantId: generic, quantity: '50', expiresOn: day(300), lotCode: 'G-1' },
      { variantId: para, quantity: '50', expiresOn: day(300), lotCode: 'P-1' },
    ]).expect(201);
    const session = await openSession(s, s.assistant.auth);
    // No prescription: refused.
    expect((await sell(session, s.assistant.auth, [{ variantId: amox, quantity: '7' }]).expect(422)).body.error).toMatchObject({ code: 'PRESCRIPTION_REQUIRED', details: { line: 0 } });
    // A prescription, but the assistant may not dispense: a pharmacist must approve.
    const withRx = { prescriptions: [rx('rx1', [{ genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE', quantity: '21', drugClass: 'ANTIBIOTIC', directions: '1 cap 3x a day for 7 days' }])] };
    const line = { variantId: amox, quantity: '7', prescription: { prescriptionRef: 'rx1', itemRef: 'i1' } };
    expect((await sell(session, s.assistant.auth, [line], withRx).expect(403)).body.error.code).toBe('DISPENSE_APPROVAL_REQUIRED');
    // The pharmacist signs in at the till; a wrong password is refused and audited.
    await http().post('/v1/pharmacy/dispense-approvals').set(s.assistant.auth).send({ branchId: s.branchId, email: s.pharmacist.email, password: 'nope' }).expect(403);
    const approval = (await http().post('/v1/pharmacy/dispense-approvals').set(s.assistant.auth).send({ branchId: s.branchId, email: s.pharmacist.email, password: PASSWORD }).expect(201)).body;
    expect(approval).toMatchObject({ approvedBy: s.pharmacist.userId, approvalMethod: 'CREDENTIALS', allowsDangerous: false });
    const first = (await sell(session, s.assistant.auth, [line, { variantId: para, quantity: '2' }], { ...withRx, dispenseApprovalId: approval.id }).expect(201)).body;
    const again = await sell(session, s.assistant.auth, [line], { ...withRx, dispenseApprovalId: approval.id }).expect(409);
    expect(again.body.error.code).toBe('DISPENSE_APPROVAL_INVALID');
    const [fill] = await q<{ prescription_id: string; prescription_item_id: string; quantity: string; dispensed_by: string; approval_id: string }>(s, `SELECT prescription_id, prescription_item_id, quantity::text, dispensed_by, approval_id FROM prescription_fills`);
    expect(fill).toMatchObject({ quantity: '7.0000', dispensed_by: s.pharmacist.userId, approval_id: approval.id });
    const itemId = fill!.prescription_item_id;

    // A refill against the item on record, by the pharmacist, with the other brand (same generic).
    const pSession = await openSession(s, s.pharmacist.auth, s.register2);
    await sell(pSession, s.pharmacist.auth, [{ variantId: generic, quantity: '7', prescription: { itemId } }]).expect(201);
    const over = await sell(pSession, s.pharmacist.auth, [{ variantId: generic, quantity: '8', prescription: { itemId } }]).expect(422);
    expect(over.body.error).toMatchObject({ code: 'PRESCRIPTION_EXCEEDED', details: { left: '7' } });
    const wrong = await sell(pSession, s.pharmacist.auth, [{ variantId: para, quantity: '1', prescription: { itemId } }]).expect(422);
    expect(wrong.body.error.code).toBe('PRESCRIPTION_MISMATCH');

    // The record: 14 of 21 dispensed; it no longer changes; it cannot be voided while medicine is out.
    const view = (await http().get(`/v1/prescriptions/${fill!.prescription_id}`).set(s.pharmacist.auth).expect(200)).body;
    expect(view).toMatchObject({ status: 'PARTLY_FILLED', editable: false, source: 'COUNTER', items: [{ quantity: '21', dispensed: '14', left: '7' }] });
    expect(view.fills).toHaveLength(2);
    await http().patch(`/v1/prescriptions/${view.id}`).set(s.pharmacist.auth).send({ notes: 'edited' }).expect(422);
    await http().post(`/v1/prescriptions/${view.id}/void`).set(s.pharmacist.auth).send({ reason: 'mistake' }).expect(422);
    await expect(q(s, `UPDATE prescription_fills SET quantity = 1`)).rejects.toThrow();

    // A return gives the pieces back; the item can be filled again.
    await http().post(`/v1/sales/${first.id}/returns`).set(s.manager).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: session, kind: 'RETURN', reason: 'Allergy', lines: [{ saleLineId: first.lines[0].id, quantity: '7', disposition: 'DAMAGED' }] }).expect(201);
    const after = (await http().get(`/v1/prescriptions/${view.id}`).set(s.pharmacist.auth).expect(200)).body;
    expect(after.items[0]).toMatchObject({ dispensed: '7', left: '14' });
    expect(after.fills.map((f: { quantity: string; returned: boolean }) => [f.quantity, f.returned])).toEqual([['7', false], ['7', false], ['-7', true]]);

    // The prescription book lists the fills; an accountant may not read it.
    const book = (await http().get('/v1/reports/prescription-book').query({ branchId: s.branchId, from: day(-1), to: day(1) }).set(s.pharmacist.auth).expect(200)).body;
    expect(book.data.map((r: { brand: string; quantity: string; returned: boolean; pharmacist: string }) => [r.brand, r.quantity, r.returned])).toEqual([
      ['Amoxil 500', '7', false], ['Amoxicillin RiteMed', '7', false], ['Amoxil 500', '-7', true],
    ]);
    const acc = await addMember(owner, s.tenantId, 'accountant');
    const accountant = bearer(await loginToken(app, acc.email));
    await http().get('/v1/reports/prescription-book').query({ branchId: s.branchId, from: day(-1), to: day(1) }).set(accountant).expect(403);
    // Audit rows name ids, never the patient.
    const logged = JSON.stringify(await q(s, `SELECT metadata FROM audit_logs WHERE action IN ('sale.completed', 'prescription.created')`));
    expect(logged).not.toContain('Juan Dela Cruz');
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('prescriptions entered beforehand are listed for the customer and can be voided while nothing is dispensed', async () => {
    const s = await pharmacy('rx-admin');
    const customer = (await http().post('/v1/customers').set(s.auth).send({ displayName: 'Maria Clara' }).expect(201)).body;
    const body = {
      branchId: s.branchId, customerId: customer.id, patientName: 'Maria Clara', prescriberName: 'Dr. Jose Rizal', prescriberLicenseNo: 'PRC-998877', issuedOn: day(0),
      items: [{ genericName: 'Losartan', strength: '50 mg', dosageForm: 'TABLET', quantity: '30', drugClass: 'RX' }],
    };
    await http().post('/v1/prescriptions').set(s.assistant.auth).set('Idempotency-Key', randomUUID()).send(body).expect(403);
    const created = (await http().post('/v1/prescriptions').set(s.pharmacist.auth).set('Idempotency-Key', randomUUID()).send(body).expect(201)).body;
    expect(created).toMatchObject({ status: 'OPEN', editable: true, source: 'ADMIN', customerName: 'Maria Clara' });
    const listed = (await http().get(`/v1/customers/${customer.id}/prescriptions`).set(s.assistant.auth).expect(200)).body.data;
    expect(listed.map((p: { id: string }) => p.id)).toEqual([created.id]);
    await http().patch(`/v1/prescriptions/${created.id}`).set(s.pharmacist.auth).send({ items: [{ ...body.items[0], quantity: '60' }] }).expect(200);
    await http().post(`/v1/prescriptions/${created.id}/void`).set(s.pharmacist.auth).send({ reason: 'Entered twice' }).expect(200);
    expect((await http().get(`/v1/prescriptions/${created.id}`).set(s.pharmacist.auth).expect(200)).body).toMatchObject({ status: 'VOIDED', items: [{ quantity: '60' }] });
    // The customer's data export includes their prescriptions with the items.
    const dump = (await http().post(`/v1/customers/${customer.id}/export`).set(s.auth).expect(200)).body;
    expect(dump.prescriptions).toEqual([
      expect.objectContaining({ patientName: 'Maria Clara', prescriberName: 'Dr. Jose Rizal', voidReason: 'Entered twice', items: [expect.objectContaining({ genericName: 'Losartan', quantity: '60', fills: [] })] }),
    ]);
    // Anonymising the customer unlinks the prescription, even a voided one.
    await http().post(`/v1/customers/${customer.id}/anonymise`).set(s.auth).send({ reason: 'Asked to be forgotten' }).expect(200);
    expect(await q(s, `SELECT customer_id FROM prescriptions WHERE id = $1`, [created.id])).toEqual([{ customer_id: null }]);
  });

  it('a business no longer a pharmacy cannot change, void or fill prescriptions, nor ask for an approval; OTC still sells; settings need a pharmacy grant', async () => {
    const s = await pharmacy('rx-retyped');
    const amox = await s.product('Amoxil 500', '18.00', AMOX);
    const para = await s.product('Biogesic', '5.00', PARA);
    await stockIn(s, [{ variantId: amox, quantity: '20', expiresOn: day(300), lotCode: 'A-1' }, { variantId: para, quantity: '20', expiresOn: day(300), lotCode: 'P-1' }]).expect(201);
    const body = {
      branchId: s.branchId, patientName: 'Juan Dela Cruz', prescriberName: 'Dr. Ana Santos', prescriberLicenseNo: 'PRC-0123456', issuedOn: day(0),
      items: [{ genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE', quantity: '21', drugClass: 'ANTIBIOTIC' }],
    };
    const created = (await http().post('/v1/prescriptions').set(s.pharmacist.auth).set('Idempotency-Key', randomUUID()).send(body).expect(201)).body;
    const session = await openSession(s, s.pharmacist.auth);
    await http().post('/v1/roles').set(s.auth).send({ key: 'stock_viewer', name: 'Stock viewer', permissions: ['catalog.read'] }).expect(201);
    const viewer = bearer(await loginToken(app, (await addMember(owner, s.tenantId, 'stock_viewer')).email));
    await http().get('/v1/pharmacy/settings').set(viewer).expect(403);
    await http().get('/v1/pharmacy/settings').set(s.pharmacist.auth).expect(200);

    await http().patch('/v1/business').set(s.auth).send({ businessType: 'RETAIL' }).expect(200);
    const excluded = (r: request.Response) => expect(r.body.error).toMatchObject({ code: 'BUSINESS_TYPE_EXCLUDES_FEATURE', details: { feature: 'pharmacy' } });
    excluded(await http().patch(`/v1/prescriptions/${created.id}`).set(s.pharmacist.auth).send({ notes: 'x' }).expect(403));
    excluded(await http().post(`/v1/prescriptions/${created.id}/void`).set(s.pharmacist.auth).send({ reason: 'x' }).expect(403));
    excluded(await http().post('/v1/pharmacy/dispense-approvals').set(s.pharmacist.auth).send({ branchId: s.branchId }).expect(403));
    excluded(await sell(session, s.pharmacist.auth, [{ variantId: amox, quantity: '7', prescription: { itemId: created.items[0].id } }]).expect(403));
    excluded(await sell(session, s.pharmacist.auth, [{ variantId: para, quantity: '1' }], { prescriptions: [rx('p1', [{ ...AMOX, quantity: '7' }])] }).expect(403));
    // Over-the-counter medicine needs no pharmacy.
    await sell(session, s.pharmacist.auth, [{ variantId: para, quantity: '2' }]).expect(201);
    expect(await q(s, `SELECT count(*)::int AS n FROM prescription_fills`)).toEqual([{ n: 0 }]);
  });

  it('a dangerous drug: a licensed pharmacist, a yellow form, one full fill, never offline', async () => {
    const s = await pharmacy('rx-dd');
    const dd = await s.product('Valium 5', '25.00', { drugClass: 'DANGEROUS', genericName: 'Diazepam', strength: '5 mg', dosageForm: 'TABLET' });
    await stockIn(s, [{ variantId: dd, quantity: '40', expiresOn: day(300), lotCode: 'D-1' }]).expect(201);
    const session = await openSession(s, s.pharmacist.auth);
    const item = { genericName: 'Diazepam', strength: '5 mg', dosageForm: 'TABLET', quantity: '10', drugClass: 'DANGEROUS' };
    const yellow = { prescriberS2No: 'S2-445566', yellowFormNo: 'YF-000123', patientAddress: '12 Mabini St, Manila' };
    const order = (q2: string, extra: Record<string, unknown> = yellow) => ({ prescriptions: [rx('dd1', [item], extra)], line: { variantId: dd, quantity: q2, prescription: { prescriptionRef: 'dd1', itemRef: 'i1' } } });
    // Without the forms the prescription itself is refused.
    const noForms = order('10', {});
    await sell(session, s.pharmacist.auth, [noForms.line], { prescriptions: noForms.prescriptions }).expect(400);
    // Without a licence on record the pharmacist may not dispense it.
    const full = order('10');
    expect((await sell(session, s.pharmacist.auth, [full.line], { prescriptions: full.prescriptions }).expect(403)).body.error.code).toBe('DISPENSE_APPROVAL_REQUIRED');
    await http().put(`/v1/pharmacy/pharmacists/${s.pharmacist.membershipId}`).set(s.manager).send({ licenseNo: 'PRC-PH-0042' }).expect(403);
    await http().put(`/v1/pharmacy/pharmacists/${s.pharmacist.membershipId}`).set(s.auth).send({ licenseNo: 'PRC-PH-0042', validUntil: day(365) }).expect(200);
    // Part of it: refused; all of it: dispensed.
    const part = order('5');
    expect((await sell(session, s.pharmacist.auth, [part.line], { prescriptions: part.prescriptions }).expect(422)).body.error.code).toBe('DANGEROUS_DRUG_FULL_FILL');
    await sell(session, s.pharmacist.auth, [full.line], { prescriptions: full.prescriptions }).expect(201);
    // The same yellow form again is refused.
    expect((await sell(session, s.pharmacist.auth, [full.line], { prescriptions: full.prescriptions }).expect(409)).body.error.code).toBe('YELLOW_FORM_USED');
    const itemId = (await q<{ id: string }>(s, `SELECT id FROM prescription_items`))[0]!.id;
    expect((await sell(session, s.pharmacist.auth, [{ variantId: dd, quantity: '10', prescription: { itemId } }]).expect(422)).body.error.code).toBe('DANGEROUS_DRUG_FULL_FILL');
    // The register: 40 at the start (the delivery was today, so: 0 + 40 in), 10 dispensed with the form.
    const book = (await http().get('/v1/reports/dangerous-drugs').query({ branchId: s.branchId, from: day(0), to: day(0) }).set(s.pharmacist.auth).expect(200)).body;
    expect(book.data).toEqual([expect.objectContaining({
      name: 'Valium 5', opening: '0', adjusted: '40', dispensed: '10', closing: '30',
      dispensings: [expect.objectContaining({ quantity: '10', yellowFormNo: 'YF-000123', prescriberS2No: 'S2-445566', patientAddress: '12 Mabini St, Manila' })],
    })]);
    // Offline: quarantined, never recorded.
    const terminal = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.registerId, name: 'Till 1' }).expect(201)).body;
    const headers = { 'x-terminal-id': terminal.terminal.id, Authorization: `Terminal ${terminal.credential}` };
    const snap = (await http().get('/v1/terminal/snapshot').set(headers).expect(200)).body as Snapshot;
    const off = order('10', { ...yellow, yellowFormNo: 'YF-000999' });
    const env: OfflineSale = {
      terminalTxnId: randomUUID(), deviceSeq: 1, snapshotId: snap.snapshotId, cashierSessionId: session, cashierUserId: s.pharmacist.userId,
      occurredAt: new Date().toISOString(), localReference: 'R1-OFF-000001', lines: [off.line as OfflineSale['lines'][number]], prescriptions: off.prescriptions as OfflineSale['prescriptions'],
      tenders: [{ method: 'CASH', tendered: '250.00' }], amountDue: '250.00',
    };
    const res = (await http().post('/v1/sync/sales').set(headers).send({ sales: [env] }).expect(200)).body;
    expect(res.results[0]).toMatchObject({ status: 'QUARANTINED', code: 'DANGEROUS_DRUG_OFFLINE' });
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('an offline prescription sale by a cashier who may not dispense is recorded and flagged for the pharmacist', async () => {
    const s = await pharmacy('rx-off');
    const amox = await s.product('Amoxil 500', '18.00', AMOX);
    await stockIn(s, [{ variantId: amox, quantity: '30', expiresOn: day(300), lotCode: 'A-9' }]).expect(201);
    const session = await openSession(s, s.assistant.auth);
    const terminal = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.registerId, name: 'Till 1' }).expect(201)).body;
    const headers = { 'x-terminal-id': terminal.terminal.id, Authorization: `Terminal ${terminal.credential}` };
    const snap = (await http().get('/v1/terminal/snapshot').set(headers).expect(200)).body as Snapshot;
    const env: OfflineSale = {
      terminalTxnId: randomUUID(), deviceSeq: 1, snapshotId: snap.snapshotId, cashierSessionId: session, cashierUserId: s.assistant.userId,
      occurredAt: new Date().toISOString(), localReference: 'R1-OFF-000001',
      lines: [{ variantId: amox, quantity: '21', prescription: { prescriptionRef: 'o1', itemRef: 'i1' } }, { variantId: amox, quantity: '1' }],
      prescriptions: [rx('o1', [{ genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE', quantity: '14', drugClass: 'ANTIBIOTIC' }])] as OfflineSale['prescriptions'],
      tenders: [{ method: 'CASH', tendered: '396.00' }], amountDue: '396.00',
    };
    const res = (await http().post('/v1/sync/sales').set(headers).send({ sales: [env] }).expect(200)).body;
    expect(res.results[0]).toMatchObject({ status: 'RECORDED', flags: ['PRESCRIPTION_REVIEW'] });
    const fills = await q<{ quantity: string; needs_review: boolean; dispensed_by: string }>(s, `SELECT quantity::text, needs_review, dispensed_by FROM prescription_fills`);
    expect(fills).toEqual([{ quantity: '21.0000', needs_review: true, dispensed_by: s.assistant.userId }]);
    expect(await q(s, `SELECT source FROM prescriptions`)).toEqual([{ source: 'OFFLINE' }]);
  });
});

describe('box, strip and piece', () => {
  it('a sale short of capsules opens a strip, and a box for the strip, in its own transaction; the lot follows', async () => {
    const s = await pharmacy('rx-chain');
    const mef = { drugClass: 'OTC', genericName: 'Mefenamic acid', strength: '500 mg', dosageForm: 'CAPSULE' };
    const box = await s.product('Dolfenal box of 100', '650.00', mef);
    const strip = await s.product('Dolfenal strip of 10', '70.00', mef);
    const cap = await s.product('Dolfenal capsule', '7.50', mef);
    await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: box, pieceVariantId: strip, piecesPerPack: '10' }).expect(201);
    await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: strip, pieceVariantId: cap, piecesPerPack: '10' }).expect(201);
    await stockIn(s, [{ variantId: box, quantity: '2', expiresOn: day(400), lotCode: 'MF-55' }]).expect(201);
    const session = await openSession(s, s.assistant.auth);
    const sold = (await sell(session, s.assistant.auth, [{ variantId: cap, quantity: '5' }]).expect(201)).body;
    expect([await onHand(s, box), await onHand(s, strip), await onHand(s, cap)]).toEqual(['1', '9', '5']);
    const openings = await q<{ packs: string; pieces: string; sale_id: string }>(s, `SELECT trim_scale(packs)::text AS packs, trim_scale(pieces)::text AS pieces, sale_id FROM pack_openings ORDER BY created_at`);
    expect(openings).toEqual([{ packs: '1', pieces: '10', sale_id: sold.id }, { packs: '1', pieces: '10', sale_id: sold.id }]);
    const receipt = (await http().get(`/v1/sales/${sold.id}/receipt`).set(s.assistant.auth).expect(200)).body;
    expect(receipt.lines[0].lots).toEqual([`Lot MF-55 · Exp ${day(400).slice(5, 7)}/${day(400).slice(0, 4)}`]);
    // Two tills selling at once never open the same box twice (the branch refuses selling below zero).
    await http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'BLOCK', lowStockAlerts: true }).expect(200);
    const s2 = await openSession(s, s.pharmacist.auth, s.register2);
    const results = await Promise.all([
      sell(session, s.assistant.auth, [{ variantId: cap, quantity: '100' }]),
      sell(s2, s.pharmacist.auth, [{ variantId: cap, quantity: '100' }]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await audit(s)).toEqual(CLEAN);
    // The batch trace follows the lot from the box down to the capsule sold.
    const trace = (await http().get('/v1/stock/lots/trace').query({ variantId: box, lotCode: 'mf-55' }).set(s.manager).expect(200)).body;
    expect(trace.movements.map((m: { name: string; type: string; quantity: string }) => [m.name, m.type, m.quantity]).slice(0, 7)).toEqual([
      ['Dolfenal box of 100', 'ADJUSTMENT', '2'],
      ['Dolfenal box of 100', 'UNPACK_OUT', '-1'],
      ['Dolfenal strip of 10', 'UNPACK_IN', '10'],
      ['Dolfenal strip of 10', 'UNPACK_OUT', '-1'],
      ['Dolfenal capsule', 'UNPACK_IN', '10'],
      ['Dolfenal capsule', 'SALE', '-5'],
      expect.anything(),
    ]);
    expect(trace.movements.find((m: { type: string; sale: unknown }) => m.type === 'SALE').sale).toMatchObject({ id: sold.id });
  });
});

describe('SC/PWD on medicines', () => {
  it('needs the purchase booklet unless the business turns the rule off; the booklet is on the receipt and in the book', async () => {
    const s = await pharmacy('rx-sc');
    const para = await s.product('Biogesic', '5.50', PARA);
    await stockIn(s, [{ variantId: para, quantity: '50', expiresOn: day(300), lotCode: 'P-2' }]).expect(201);
    const session = await openSession(s, s.assistant.auth);
    const sc = (booklet?: boolean) => ({ beneficiaries: [{ ref: 'lolo', scheme: 'SC', name: 'Pedro Penduko', idNumber: 'OSCA-77', ...(booklet !== undefined && { purchaseBooklet: booklet }) }] });
    const line = { variantId: para, quantity: '10', statutory: { scheme: 'SC', beneficiary: 'lolo' } };
    expect((await sell(session, s.assistant.auth, [line], sc()).expect(422)).body.error.code).toBe('PURCHASE_BOOKLET_REQUIRED');
    const sold = (await sell(session, s.assistant.auth, [line], sc(true)).expect(201)).body;
    const receipt = (await http().get(`/v1/sales/${sold.id}/receipt`).set(s.assistant.auth).expect(200)).body;
    expect(receipt.statutory[0]).toMatchObject({ scheme: 'SC', name: 'Pedro Penduko', purchaseBooklet: true, signatureLine: true });
    const book = (await http().get('/v1/reports/statutory-book').query({ branchId: s.branchId, from: day(-1), to: day(1) }).set(s.auth).expect(200)).body;
    expect(book.data[0]).toMatchObject({ name: 'Pedro Penduko', purchaseBooklet: true });
    await http().put('/v1/pharmacy/settings').set(s.manager).send({ requirePurchaseBooklet: false }).expect(403);
    await http().put('/v1/pharmacy/settings').set(s.auth).send({ requirePurchaseBooklet: false }).expect(200);
    const without = (await sell(session, s.assistant.auth, [line], sc()).expect(201)).body;
    expect(without.beneficiaries[0].purchaseBooklet).toBe(false);
  });
});

describe('audit 2026-10-21', () => {
  const productOf = async (s: Store, variantId: string) => (await q<{ product_id: string }>(s, `SELECT product_id FROM product_variants WHERE id = $1`, [variantId]))[0]!.product_id;

  it('a pack and its piece are the same medicine: other links and later edits are refused; an older pack takes its piece\'s class', async () => {
    const s = await pharmacy('rx-a-pack');
    const cap = await s.product('Amoxil capsule', '18.00', AMOX);
    const plainBox = await s.product('Amoxil box (no details)', '170.00', null);
    const otcBox = await s.product('Amoxil box (OTC)', '170.00', { ...AMOX, drugClass: 'OTC' });
    const otherBox = await s.product('Cefalexin box', '170.00', { ...AMOX, genericName: 'Cefalexin' });
    const box = await s.product('Amoxil box of 10', '170.00', AMOX);
    for (const pack of [plainBox, otcBox, otherBox]) {
      expect((await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: pack, pieceVariantId: cap, piecesPerPack: '10' }).expect(422)).body.error.code).toBe('PACK_DRUG_MISMATCH');
    }
    await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: box, pieceVariantId: cap, piecesPerPack: '10' }).expect(201);
    // Editing one side apart from the other is refused too.
    expect((await http().patch(`/v1/products/${await productOf(s, box)}`).set(s.auth).send({ drug: { ...AMOX, drugClass: 'RX' } }).expect(422)).body.error.code).toBe('PACK_DRUG_MISMATCH');
    expect((await http().patch(`/v1/products/${await productOf(s, cap)}`).set(s.auth).send({ drug: null }).expect(422)).body.error.code).toBe('PACK_DRUG_MISMATCH');
    // A link made before the rule: the box without details still needs the prescription its capsules need.
    const cap2 = await s.product('Amoxicillin capsule (generic)', '9.00', AMOX);
    await q(s, `INSERT INTO pack_conversions (tenant_id, pack_variant_id, piece_variant_id, pieces_per_pack, created_by) VALUES ($1, $2, $3, 10, $4)`, [s.tenantId, plainBox, cap2, s.pharmacist.userId]);
    await stockIn(s, [{ variantId: plainBox, quantity: '2', expiresOn: day(300), lotCode: 'PB-1' }]).expect(201);
    const session = await openSession(s, s.assistant.auth);
    expect((await sell(session, s.assistant.auth, [{ variantId: plainBox, quantity: '1' }]).expect(422)).body.error.code).toBe('PRESCRIPTION_REQUIRED');
  });

  it('a box counts its pieces against the prescription; a box feeding two piece items counts the larger', async () => {
    const s = await pharmacy('rx-a-pieces');
    const box = await s.product('Amoxil box', '170.00', AMOX);
    const capA = await s.product('Amoxil capsule', '18.00', AMOX);
    const capB = await s.product('Amoxil capsule (hospital pack)', '18.00', AMOX);
    await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: box, pieceVariantId: capA, piecesPerPack: '10' }).expect(201);
    await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: box, pieceVariantId: capB, piecesPerPack: '12' }).expect(201);
    await stockIn(s, [{ variantId: box, quantity: '3', expiresOn: day(300), lotCode: 'BX-1' }]).expect(201);
    const session = await openSession(s, s.pharmacist.auth);
    const item = { genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE', quantity: '14', drugClass: 'ANTIBIOTIC' };
    const line = (quantity: string) => ({ variantId: box, quantity, prescription: { prescriptionRef: 'p1', itemRef: 'i1' } });
    expect((await sell(session, s.pharmacist.auth, [line('2')], { prescriptions: [rx('p1', [item])] }).expect(422)).body.error.code).toBe('PRESCRIPTION_EXCEEDED');
    await sell(session, s.pharmacist.auth, [line('1')], { prescriptions: [rx('p1', [item])] }).expect(201);
    expect(await q(s, `SELECT trim_scale(quantity)::text AS quantity, trim_scale(pieces_per_unit)::text AS per FROM prescription_fills`)).toEqual([{ quantity: '12', per: '12' }]);
  });

  it('a hold on a box stops the loose pieces of its lot (the whole pack family)', async () => {
    const s = await pharmacy('rx-a-hold');
    const mef = { drugClass: 'OTC', genericName: 'Mefenamic acid', strength: '500 mg', dosageForm: 'CAPSULE' };
    const box = await s.product('Dolfenal box of 10', '70.00', mef);
    const cap = await s.product('Dolfenal capsule', '7.50', mef);
    await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: box, pieceVariantId: cap, piecesPerPack: '10' }).expect(201);
    await stockIn(s, [{ variantId: box, quantity: '1', expiresOn: day(300), lotCode: 'H-1' }]).expect(201);
    const session = await openSession(s, s.assistant.auth);
    await sell(session, s.assistant.auth, [{ variantId: cap, quantity: '1' }]).expect(201); // opens the box: 9 capsules of lot H-1
    await http().post('/v1/stock/lot-holds').set(s.auth).set('Idempotency-Key', randomUUID()).send({ variantId: box, lotCode: 'H-1', reason: 'FDA recall', reference: 'FDA-2026-002' }).expect(201);
    expect((await sell(session, s.assistant.auth, [{ variantId: cap, quantity: '1' }]).expect(409)).body.error).toMatchObject({ code: 'EXPIRED_STOCK', details: { lines: [{ variantId: cap, expiredOrHeld: '9' }] } });
  });

  it('a pharmacist licence counts until the end of its last day at the branch; the dangerous drugs register counts pieces', async () => {
    const s = await pharmacy('rx-a-dd');
    const diaz = { drugClass: 'DANGEROUS', genericName: 'Diazepam', strength: '5 mg', dosageForm: 'TABLET' };
    const box = await s.product('Valium box of 10', '250.00', diaz);
    const tab = await s.product('Valium tablet', '25.00', diaz);
    await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: box, pieceVariantId: tab, piecesPerPack: '10' }).expect(201);
    await stockIn(s, [{ variantId: box, quantity: '2', expiresOn: day(300), lotCode: 'D-2' }]).expect(201);
    const session = await openSession(s, s.pharmacist.auth);
    const order = (form: string) => ({
      prescriptions: [rx('dd', [{ genericName: 'Diazepam', strength: '5 mg', dosageForm: 'TABLET', quantity: '10', drugClass: 'DANGEROUS' }], { prescriberS2No: 'S2-1', yellowFormNo: form, patientAddress: '12 Mabini St, Manila' })],
    });
    const line = { variantId: box, quantity: '1', prescription: { prescriptionRef: 'dd', itemRef: 'i1' } };
    await http().put(`/v1/pharmacy/pharmacists/${s.pharmacist.membershipId}`).set(s.auth).send({ licenseNo: 'PRC-PH-0042', validUntil: day(-1) }).expect(200);
    expect((await sell(session, s.pharmacist.auth, [line], order('YF-1')).expect(403)).body.error.code).toBe('DISPENSE_APPROVAL_REQUIRED');
    await http().put(`/v1/pharmacy/pharmacists/${s.pharmacist.membershipId}`).set(s.auth).send({ licenseNo: 'PRC-PH-0042', validUntil: day(0) }).expect(200);
    await sell(session, s.pharmacist.auth, [line], order('YF-2')).expect(201);
    const book = (await http().get('/v1/reports/dangerous-drugs').query({ branchId: s.branchId, from: day(0), to: day(0) }).set(s.pharmacist.auth).expect(200)).body;
    expect(book.unit).toBe('PIECE');
    expect(book.data.find((r: { variantId: string }) => r.variantId === box)).toMatchObject({
      piecesPerUnit: '10', opening: '0', adjusted: '20', dispensed: '10', closing: '10', dispensings: [expect.objectContaining({ quantity: '10', yellowFormNo: 'YF-2' })],
    });
  });
});
