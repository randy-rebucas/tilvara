import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwnerInTenant, bearer, createApp, ownerPool, signup, uniq } from './helpers.js';

/**
 * Tips and prepaid service packages were removed with their history (migrations 0112–0113): no table,
 * column, account or route of theirs is left, and nothing can write one.
 */
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

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'Counter' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, extra: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: vat, ...extra, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body as { id: string; variants: { id: string }[] };
  const session = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
  const sell = async (variantId: string) =>
    (await http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: session, clientTransactionId: randomUUID(), lines: [{ variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '5000.00' }] }).expect(201)).body as { id: string; lines: { id: string }[] };
  return { tenantId: t.tenantId, auth, session, product, sell };
}

type Shop = Awaited<ReturnType<typeof shop>>;

describe('tips and service packages are gone (0112–0113)', () => {
  it('no table, column or account of theirs is left; a package product cannot be made', async () => {
    const s: Shop = await shop('retired-schema');
    const [gone] = await asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(`
      SELECT (SELECT count(*)::int FROM pg_tables WHERE tablename IN ('sale_tips', 'sale_tip_refunds')) AS tables,
             (SELECT count(*)::int FROM information_schema.columns WHERE column_name IN ('tip_refund', 'package_value')) AS columns,
             (SELECT count(*)::int FROM accounts WHERE system_key IN ('TIPS_PAYABLE', 'PREPAID_SERVICES')) AS accounts`)).rows);
    expect(gone).toEqual({ tables: 0, columns: 0, accounts: 0 });
    const bundle = await s.product('Bundle', '100.00');
    await expect(asOwnerInTenant(owner, s.tenantId, (c) => c.query(`UPDATE products SET product_type = 'PACKAGE' WHERE id = $1`, [bundle.id]))).rejects.toThrow(/violates check constraint/);
  });

  it('removed money paths are gone: a tip payout from the drawer and a tip refund after a void', async () => {
    const s = await shop('retired-paths');
    const out = await http().post(`/v1/cashier-sessions/${s.session}/movements`).set(s.auth).send({ type: 'TIP_PAYOUT', amount: '1.00', reason: 'Tips' });
    expect([out.status, out.body.error?.code]).toEqual([400, 'VALIDATION_FAILED']);
    await http().post(`/v1/sale-returns/${randomUUID()}/tip-refund`).set(s.auth).send({}).expect(404);
    const tip = await http().post('/v1/payment-intents').set(s.auth).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), method: 'CARD', amount: '5.00', purpose: 'TIP' });
    // `purpose` is no longer part of a payment: an unknown key is refused or ignored, never a tip.
    if (tip.status === 201) {
      const [row] = await asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(`SELECT purpose FROM payment_intents WHERE id = $1`, [tip.body.id])).rows);
      expect(row).toEqual({ purpose: 'SALE' });
    } else expect(tip.status).toBe(400);
  });
});

/**
 * History of the removed features a test DB migrated from scratch never holds: staged as the migrator, with what keeps
 * new rows current (NOT VALID checks, the new-payment trigger) set aside for the insert and put back exactly as it was.
 */
describe('old sales and payments of removed features', () => {
  it('a sale paid with a retired tender (ROOM_CHARGE) cannot be returned or voided: TENDER_RETIRED', async () => {
    const s = await shop('retired-tender');
    const item = await s.product('Mango shake', '150.00');
    const sale = await s.sell(item.variants[0]!.id);
    await asOwnerInTenant(owner, s.tenantId, async (c) => {
      await c.query(`ALTER TABLE sale_tenders DROP CONSTRAINT sale_tenders_method_check, DROP CONSTRAINT sale_tenders_intent_check`);
      await c.query(`INSERT INTO sale_tenders (tenant_id, sale_id, method, amount, tendered, change) VALUES ($1, $2, 'ROOM_CHARGE', 0, 0, 0)`, [s.tenantId, sale.id]);
      await c.query(`ALTER TABLE sale_tenders ADD CONSTRAINT sale_tenders_method_check CHECK (method IN ('CASH','CARD','QR','EWALLET','STORE_CREDIT')) NOT VALID,
                     ADD CONSTRAINT sale_tenders_intent_check CHECK ((method IN ('CASH','STORE_CREDIT')) = (payment_intent_id IS NULL)) NOT VALID`);
    });
    for (const body of [{ kind: 'RETURN', lines: [{ saleLineId: sale.lines[0]!.id, quantity: '1', disposition: 'RESTOCK' }] }, { kind: 'VOID' }]) {
      const r = await http().post(`/v1/sales/${sale.id}/returns`).set(s.auth).set('Idempotency-Key', randomUUID())
        .send({ cashierSessionId: s.session, reason: 'Customer changed their mind', ...body });
      expect([r.status, r.body.error?.code], JSON.stringify(r.body)).toEqual([409, 'TENDER_RETIRED']);
    }
    // The receipt still names it, as stored (the counter and the admin word it).
    const receipt = await http().get(`/v1/sales/${sale.id}/receipt`).set(s.auth).expect(200);
    expect((receipt.body.tenders as { method: string }[]).map((t) => t.method)).toContain('ROOM_CHARGE');
  });

  it('a laundry down payment left without an answer can be checked, and then no longer holds the shift open (0119)', async () => {
    const s = await shop('retired-intent');
    const id = await asOwnerInTenant(owner, s.tenantId, async (c) => {
      await c.query(`ALTER TABLE payment_intents DISABLE TRIGGER payment_intents_new_purpose`);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO payment_intents (tenant_id, branch_id, register_id, cashier_session_id, client_transaction_id, request_key, provider, method, amount, currency, status, created_by, purpose)
         SELECT tenant_id, branch_id, register_id, id, gen_random_uuid(), gen_random_uuid(), 'dev', 'CARD', 50, 'PHP', 'UNKNOWN', opened_by, 'JOB_ORDER'
           FROM cashier_sessions WHERE id = $1 RETURNING id`, [s.session]);
      await c.query(`ALTER TABLE payment_intents ENABLE TRIGGER payment_intents_new_purpose`);
      return rows[0]!.id;
    });
    const blocked = await http().post(`/v1/cashier-sessions/${s.session}/close`).set(s.auth).send({ countedCash: '1150.00' });
    expect([blocked.status, blocked.body.error?.code]).toEqual([409, 'PAYMENTS_OUTSTANDING']);
    // The provider never had it: it settles as FAILED (before 0119 the trigger refused any change to it).
    const checked = await http().post(`/v1/payment-intents/${id}/reconcile`).set(s.auth).expect(200);
    expect(checked.body.status).toBe('FAILED');
    const closed = await http().post(`/v1/cashier-sessions/${s.session}/close`).set(s.auth).send({ countedCash: '1000.00' }).expect(200);
    expect(closed.body.status).toBe('RECONCILED');
    // A new payment is still for a sale only.
    await expect(asOwnerInTenant(owner, s.tenantId, (c) => c.query(`UPDATE payment_intents SET purpose = 'SALE' WHERE id = $1`, [id]))).rejects.toThrow(/immutable/);
    await expect(asOwnerInTenant(owner, s.tenantId, (c) => c.query(
      `INSERT INTO payment_intents (tenant_id, branch_id, register_id, cashier_session_id, client_transaction_id, request_key, provider, method, amount, currency, status, created_by, purpose)
       SELECT tenant_id, branch_id, register_id, cashier_session_id, gen_random_uuid(), gen_random_uuid(), 'dev', 'CARD', 5, 'PHP', 'PROCESSING', created_by, 'FOLIO' FROM payment_intents WHERE id = $1`, [id]))).rejects.toThrow(/for a sale/);
  });
});
