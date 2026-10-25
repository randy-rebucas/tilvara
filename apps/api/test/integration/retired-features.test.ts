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
