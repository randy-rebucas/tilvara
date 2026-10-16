import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

/**
 * Phase 1 exit sweep: two fully configured tenants, then every tenant table and every
 * id-addressed route is probed from the other tenant. The route matrix is checked against the
 * live router, so adding an `:id` route without a cross-tenant case fails this suite; the table
 * sweep is driven by the system catalog, so a new tenant table without fixture data fails too.
 */
let app: INestApplication;
let owner: pg.Pool;
let runtime: pg.Pool;
const http = () => request(app.getHttpServer());

interface World {
  t: SignedUp;
  auth: { Authorization: string };
  entityId: string;
  branchId: string;
  registerId: string;
  terminalId: string;
  categoryId: string;
  productId: string;
  variantId: string;
  barcodeId: string;
  priceListId: string;
  defaultListId: string;
  roleId: string;
  cashierRoleId: string;
  invitationId: string;
  memberId: string;
  uomId: string;
  taxId: string;
  openSessionId: string;
  closedSessionId: string;
  saleId: string;
  paymentIntentId: string;
  openSessionCash: string;
  supplierId: string;
  purchaseOrderId: string;
  draftOrderId: string;
  goodsReceiptId: string;
  supplierReturnId: string;
  branch2Id: string;
  transferId: string;
  countId: string;
  adjustmentId: string;
  journalEntryId: string;
  cashAccountId: string;
  dishId: string;
}

async function world(prefix: string): Promise<World> {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const ok = <T = { id: string }>(res: request.Response, status = 201): T => {
    if (res.status !== status) {
      const { req } = res as unknown as { req: { method: string; path: string } };
      throw new Error(`fixture ${req.method} ${req.path} → ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as T;
  };
  const entity = ok(await http().post('/v1/legal-entities').set(auth).set('Idempotency-Key', randomUUID()).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }));
  const branch = ok(await http().post('/v1/branches').set(auth).send({ legalEntityId: entity.id, code: 'B1', name: 'One' }));
  const register = ok(await http().post('/v1/registers').set(auth).send({ branchId: branch.id, code: 'R1', name: 'Counter' }));
  const terminal = ok<{ terminal: { id: string } }>(await http().post('/v1/terminals').set(auth).send({ registerId: register.id, name: 'T1' }));
  const uoms = ok<{ data: { id: string; code: string }[] }>(await http().get('/v1/uoms').set(auth), 200).data;
  const taxes = ok<{ data: { id: string; code: string }[] }>(await http().get('/v1/tax-categories').set(auth), 200).data;
  const lists = ok<{ data: { id: string; isDefault: boolean }[] }>(await http().get('/v1/price-lists').set(auth), 200).data;
  const roles = ok<{ data: { id: string; key: string }[] }>(await http().get('/v1/roles').set(auth), 200).data;
  const uomId = uoms.find((u) => u.code === 'PC')!.id;
  const taxId = taxes.find((x) => x.code === 'VAT')!.id;
  const category = ok(await http().post('/v1/categories').set(auth).send({ name: 'Drinks' }));
  const product = ok<{ id: string; variants: { id: string }[] }>(
    await http()
      .post('/v1/products')
      .set(auth)
      .send({ name: 'Cola', categoryId: category.id, taxCategoryId: taxId, uomId, variants: [{ sku: uniq('SKU'), price: '20.00' }] }),
  );
  const variantId = product.variants[0]!.id;
  const barcode = ok(await http().post(`/v1/variants/${variantId}/barcodes`).set(auth).send({ code: uniq('480').replace(/[^A-Za-z0-9-]/g, '') }));
  const priceList = ok(await http().post('/v1/price-lists').set(auth).send({ name: 'Mall' }));
  ok(await http().post(`/v1/price-lists/${priceList.id}/prices`).set(auth).send({ items: [{ variantId, amount: '22.00' }] }));
  ok(await http().put(`/v1/branches/${branch.id}/price-list`).set(auth).send({ priceListId: priceList.id }), 200);
  const role = ok(await http().post('/v1/roles').set(auth).send({ key: 'auditor', name: 'Auditor', permissions: ['catalog.read'] }));
  const cashierRoleId = roles.find((r) => r.key === 'cashier')!.id;
  const invitation = ok(
    await http()
      .post('/v1/invitations')
      .set(auth)
      .send({ email: `${uniq('inv')}@example.ph`, roles: [{ roleId: cashierRoleId, scopeType: 'BRANCH', scopeId: branch.id }] }),
  );
  const member = await addMember(owner, t.tenantId, 'cashier');
  // Phase 2: stock, a statutory sale on a session that is then counted, and an open session.
  const adjustment = ok(await http().post('/v1/stock/adjustments').set(auth).send({ branchId: branch.id, reason: 'Opening stock', items: [{ variantId, quantity: '10' }] }));
  const closedSession = ok(await http().post('/v1/cashier-sessions').set(auth).send({ registerId: register.id, openingFloat: '100.00' }));
  const sold = ok(
    await http()
      .post('/v1/sales')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        cashierSessionId: closedSession.id,
        clientTransactionId: randomUUID(),
        lines: [{ variantId, quantity: '1', statutory: { scheme: 'SC', beneficiary: 'b1' } }],
        beneficiaries: [{ ref: 'b1', scheme: 'SC', name: 'Lola', idNumber: 'OSCA-1' }],
        tenders: [{ method: 'CASH', tendered: '50.00' }],
      }),
  );
  ok(await http().post(`/v1/cashier-sessions/${closedSession.id}/close`).set(auth).send({ countedCash: '90.00' }), 200);
  const openSession = ok(await http().post('/v1/cashier-sessions').set(auth).send({ registerId: register.id, openingFloat: '100.00' }));
  const soldLines = (await http().get(`/v1/sales/${sold.id}`).set(auth)).body.lines as { id: string }[];
  ok(
    await http()
      .post(`/v1/sales/${sold.id}/returns`)
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: openSession.id, kind: 'RETURN', reason: 'Fixture return', lines: [{ saleLineId: soldLines[0]!.id, quantity: '1', disposition: 'DAMAGED' }] }),
  );
  // Phase 4: a dish made from Cola (recipe v1), sold once, so its consumption is in the ledger.
  const dish = ok<{ variants: { id: string }[] }>(
    await http().post('/v1/products').set(auth).send({ name: 'Float', taxCategoryId: taxId, uomId, trackInventory: false, variants: [{ sku: uniq('DISH'), price: '60.00' }] }),
  );
  const dishId = dish.variants[0]!.id;
  ok(await http().post(`/v1/price-lists/${priceList.id}/prices`).set(auth).send({ items: [{ variantId: dishId, amount: '65.00' }] }));
  ok(await http().post(`/v1/variants/${dishId}/recipe`).set(auth).send({ ingredients: [{ variantId, quantity: '1' }] }));
  ok(
    await http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: openSession.id, clientTransactionId: randomUUID(), lines: [{ variantId: dishId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }] }),
  );
  const openSessionCash = (await http().get(`/v1/cashier-sessions/${openSession.id}`).set(auth)).body.expectedCash as string;
  const payment = ok(
    await http()
      .post('/v1/payment-intents')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: openSession.id, clientTransactionId: randomUUID(), method: 'CARD', amount: '5.00' }),
  );
  // Phase 3: a supplier, an approved order received in part, a supplier return, and a draft order.
  const supplier = ok(await http().post('/v1/suppliers').set(auth).send({ code: 'SUP1', name: `${prefix} Supplier` }));
  const po = ok<{ id: string; lines: { id: string }[] }>(
    await http().post('/v1/purchase-orders').set(auth).send({ branchId: branch.id, supplierId: supplier.id, lines: [{ variantId, quantity: '5', unitCost: '12.00' }] }),
  );
  ok(await http().post(`/v1/purchase-orders/${po.id}/approve`).set(auth), 200);
  const receipt = ok<{ id: string; lines: { id: string }[] }>(
    await http()
      .post('/v1/goods-receipts')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ branchId: branch.id, supplierId: supplier.id, purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: po.lines[0]!.id, variantId, quantity: '3' }] }),
  );
  const supplierReturn = ok(
    await http()
      .post('/v1/supplier-returns')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ branchId: branch.id, supplierId: supplier.id, goodsReceiptId: receipt.id, reason: 'Fixture', lines: [{ goodsReceiptLineId: receipt.lines[0]!.id, variantId, quantity: '1' }] }),
  );
  const draft = ok(await http().post('/v1/purchase-orders').set(auth).send({ branchId: branch.id, supplierId: supplier.id, lines: [{ variantId, quantity: '1', unitCost: '1.00' }] }));
  // Phase 3 slice 3: a received transfer to a second branch, a count, and a reorder point.
  const branch2 = ok(await http().post('/v1/branches').set(auth).send({ legalEntityId: entity.id, code: 'B2', name: 'Two', birBranchCode: '00001' }));
  const transfer = ok(await http().post('/v1/stock/transfers').set(auth).set('Idempotency-Key', randomUUID()).send({ fromBranchId: branch.id, toBranchId: branch2.id, lines: [{ variantId, quantity: '1' }] }));
  ok(await http().post(`/v1/stock/transfers/${transfer.id}/receive`).set(auth).set('Idempotency-Key', randomUUID()).send({}), 200);
  const count = ok(await http().post('/v1/stock/counts').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: branch2.id, lines: [{ variantId, countedQuantity: '2' }] }));
  ok(await http().put('/v1/stock/reorder-points').set(auth).send({ branchId: branch.id, items: [{ variantId, reorderPoint: '20' }] }), 200);
  // Phase 3 slice 4: the books every document above posted to (chart seeded with the entity).
  const accounts = ok<{ data: { id: string; systemKey: string }[] }>(await http().get('/v1/accounts').query({ legalEntityId: entity.id }).set(auth), 200).data;
  const entries = ok<{ data: { id: string }[] }>(await http().get('/v1/journal-entries').query({ legalEntityId: entity.id, sourceType: 'SALE' }).set(auth), 200).data;
  return {
    t,
    auth,
    entityId: entity.id,
    branchId: branch.id,
    registerId: register.id,
    terminalId: terminal.terminal.id,
    categoryId: category.id,
    productId: product.id,
    variantId,
    barcodeId: barcode.id,
    priceListId: priceList.id,
    defaultListId: lists.find((l) => l.isDefault)!.id,
    roleId: role.id,
    cashierRoleId,
    invitationId: invitation.id,
    memberId: member.membershipId,
    uomId,
    taxId,
    openSessionId: openSession.id,
    closedSessionId: closedSession.id,
    saleId: sold.id,
    paymentIntentId: payment.id,
    openSessionCash,
    supplierId: supplier.id,
    purchaseOrderId: po.id,
    draftOrderId: draft.id,
    goodsReceiptId: receipt.id,
    supplierReturnId: supplierReturn.id,
    branch2Id: branch2.id,
    transferId: transfer.id,
    countId: count.id,
    adjustmentId: adjustment.id,
    journalEntryId: entries[0]!.id,
    cashAccountId: accounts.find((x) => x.systemKey === 'CASH_ON_HAND')!.id,
    dishId,
  };
}

let a: World;
let b: World;

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  [a, b] = await Promise.all([world('iso-a'), world('iso-b')]);
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await runtime.end();
});

/** Every id-addressed route, attacked by tenant B with tenant A's ids. Keys must match the router. */
function attackMatrix(): Record<string, () => request.Test> {
  const auth = b.auth;
  return {
    'PATCH /v1/legal-entities/:id': () => http().patch(`/v1/legal-entities/${a.entityId}`).set(auth).send({ registeredName: 'pwned' }),
    'POST /v1/legal-entities/:id/archive': () => http().post(`/v1/legal-entities/${a.entityId}/archive`).set(auth),
    'GET /v1/legal-entities/:id/tax-profiles': () => http().get(`/v1/legal-entities/${a.entityId}/tax-profiles`).set(auth),
    'POST /v1/legal-entities/:id/tax-profiles': () => http().post(`/v1/legal-entities/${a.entityId}/tax-profiles`).set(auth).send({ vatStatus: 'NON_VAT' }),
    'PATCH /v1/branches/:id': () => http().patch(`/v1/branches/${a.branchId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/branches/:id/archive': () => http().post(`/v1/branches/${a.branchId}/archive`).set(auth),
    'PATCH /v1/registers/:id': () => http().patch(`/v1/registers/${a.registerId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/registers/:id/archive': () => http().post(`/v1/registers/${a.registerId}/archive`).set(auth),
    'POST /v1/terminals/:id/revoke': () => http().post(`/v1/terminals/${a.terminalId}/revoke`).set(auth).send({ reason: 'sabotage' }),
    'PATCH /v1/categories/:id': () => http().patch(`/v1/categories/${a.categoryId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/categories/:id/archive': () => http().post(`/v1/categories/${a.categoryId}/archive`).set(auth),
    'GET /v1/products/:id': () => http().get(`/v1/products/${a.productId}`).set(auth),
    'PATCH /v1/products/:id': () => http().patch(`/v1/products/${a.productId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/products/:id/archive': () => http().post(`/v1/products/${a.productId}/archive`).set(auth),
    'POST /v1/products/:id/variants': () => http().post(`/v1/products/${a.productId}/variants`).set(auth).send({ sku: uniq('X') }),
    'PATCH /v1/variants/:id': () => http().patch(`/v1/variants/${a.variantId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/variants/:id/archive': () => http().post(`/v1/variants/${a.variantId}/archive`).set(auth),
    'POST /v1/variants/:id/barcodes': () => http().post(`/v1/variants/${a.variantId}/barcodes`).set(auth).send({ code: 'HIJACK1' }),
    'POST /v1/barcodes/:id/archive': () => http().post(`/v1/barcodes/${a.barcodeId}/archive`).set(auth),
    'GET /v1/variants/:id/price-history': () => http().get(`/v1/variants/${a.variantId}/price-history`).set(auth),
    'PATCH /v1/price-lists/:id': () => http().patch(`/v1/price-lists/${a.priceListId}`).set(auth).send({ name: 'pwned' }),
    'GET /v1/price-lists/:id/prices': () => http().get(`/v1/price-lists/${a.priceListId}/prices`).set(auth),
    'POST /v1/price-lists/:id/prices': () =>
      http().post(`/v1/price-lists/${a.priceListId}/prices`).set(auth).send({ items: [{ variantId: b.variantId, amount: '0.01' }] }),
    'PUT /v1/branches/:id/price-list': () => http().put(`/v1/branches/${a.branchId}/price-list`).set(auth).send({ priceListId: null }),
    'POST /v1/invitations/:id/revoke': () => http().post(`/v1/invitations/${a.invitationId}/revoke`).set(auth),
    'PUT /v1/members/:id/roles': () =>
      http().put(`/v1/members/${a.memberId}/roles`).set(auth).send({ roles: [{ roleId: b.cashierRoleId, scopeType: 'TENANT', scopeId: null }] }),
    'POST /v1/members/:id/suspend': () => http().post(`/v1/members/${a.memberId}/suspend`).set(auth),
    'POST /v1/members/:id/reactivate': () => http().post(`/v1/members/${a.memberId}/reactivate`).set(auth),
    'POST /v1/members/:id/remove': () => http().post(`/v1/members/${a.memberId}/remove`).set(auth),
    'PATCH /v1/roles/:id': () => http().patch(`/v1/roles/${a.roleId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/roles/:id/archive': () => http().post(`/v1/roles/${a.roleId}/archive`).set(auth),
    'GET /v1/cashier-sessions/:id': () => http().get(`/v1/cashier-sessions/${a.openSessionId}`).set(auth),
    'POST /v1/cashier-sessions/:id/movements': () =>
      http().post(`/v1/cashier-sessions/${a.openSessionId}/movements`).set(auth).send({ type: 'PAY_OUT', amount: '1.00', reason: 'theft' }),
    'POST /v1/cashier-sessions/:id/close': () => http().post(`/v1/cashier-sessions/${a.openSessionId}/close`).set(auth).send({ countedCash: '0' }),
    'POST /v1/cashier-sessions/:id/approve-variance': () => http().post(`/v1/cashier-sessions/${a.closedSessionId}/approve-variance`).set(auth).send({ note: 'x' }),
    'GET /v1/sales/:id': () => http().get(`/v1/sales/${a.saleId}`).set(auth),
    'GET /v1/reports/cashier-sessions/:id': () => http().get(`/v1/reports/cashier-sessions/${a.closedSessionId}`).set(auth),
    'GET /v1/sales/:id/returns': () => http().get(`/v1/sales/${a.saleId}/returns`).set(auth),
    'POST /v1/sales/:id/returns': () =>
      http().post(`/v1/sales/${a.saleId}/returns`).set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, kind: 'VOID', reason: 'steal' }),
    'GET /v1/sales/:id/receipt': () => http().get(`/v1/sales/${a.saleId}/receipt`).set(auth),
    'GET /v1/payment-intents/:id': () => http().get(`/v1/payment-intents/${a.paymentIntentId}`).set(auth),
    'POST /v1/payment-intents/:id/reconcile': () => http().post(`/v1/payment-intents/${a.paymentIntentId}/reconcile`).set(auth),
    'POST /v1/payment-intents/:id/cancel': () => http().post(`/v1/payment-intents/${a.paymentIntentId}/cancel`).set(auth),
    'GET /v1/suppliers/:id': () => http().get(`/v1/suppliers/${a.supplierId}`).set(auth),
    'PATCH /v1/suppliers/:id': () => http().patch(`/v1/suppliers/${a.supplierId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/suppliers/:id/archive': () => http().post(`/v1/suppliers/${a.supplierId}/archive`).set(auth),
    'GET /v1/purchase-orders/:id': () => http().get(`/v1/purchase-orders/${a.purchaseOrderId}`).set(auth),
    'PATCH /v1/purchase-orders/:id': () => http().patch(`/v1/purchase-orders/${a.draftOrderId}`).set(auth).send({ notes: 'pwned' }),
    'POST /v1/purchase-orders/:id/approve': () => http().post(`/v1/purchase-orders/${a.draftOrderId}/approve`).set(auth),
    'POST /v1/purchase-orders/:id/cancel': () => http().post(`/v1/purchase-orders/${a.draftOrderId}/cancel`).set(auth).send({ reason: 'sabotage' }),
    'POST /v1/purchase-orders/:id/close': () => http().post(`/v1/purchase-orders/${a.purchaseOrderId}/close`).set(auth).send({ reason: 'sabotage' }),
    'GET /v1/goods-receipts/:id': () => http().get(`/v1/goods-receipts/${a.goodsReceiptId}`).set(auth),
    'GET /v1/supplier-returns/:id': () => http().get(`/v1/supplier-returns/${a.supplierReturnId}`).set(auth),
    'GET /v1/stock/transfers/:id': () => http().get(`/v1/stock/transfers/${a.transferId}`).set(auth),
    'POST /v1/stock/transfers/:id/receive': () => http().post(`/v1/stock/transfers/${a.transferId}/receive`).set(auth).set('Idempotency-Key', randomUUID()).send({}),
    'GET /v1/stock/counts/:id': () => http().get(`/v1/stock/counts/${a.countId}`).set(auth),
    'GET /v1/stock/adjustments/:id': () => http().get(`/v1/stock/adjustments/${a.adjustmentId}`).set(auth),
    'GET /v1/journal-entries/:id': () => http().get(`/v1/journal-entries/${a.journalEntryId}`).set(auth),
    'POST /v1/journal-entries/:id/reverse': () => http().post(`/v1/journal-entries/${a.journalEntryId}/reverse`).set(auth).set('Idempotency-Key', randomUUID()).send({ memo: 'sabotage' }),
    'GET /v1/variants/:id/recipe': () => http().get(`/v1/variants/${a.dishId}/recipe`).set(auth),
    'POST /v1/variants/:id/recipe': () => http().post(`/v1/variants/${a.dishId}/recipe`).set(auth).send({ ingredients: [{ variantId: b.variantId, quantity: '1' }] }),
  };
}

/** Requests on B's own resources that smuggle one of A's ids in the body or query. */
function smuggleMatrix(): [string, () => request.Test][] {
  const auth = b.auth;
  return [
    ['branch under A entity', () => http().post('/v1/branches').set(auth).send({ legalEntityId: a.entityId, code: 'HACK', name: 'x', birBranchCode: '00009' })],
    ['register in A branch', () => http().post('/v1/registers').set(auth).send({ branchId: a.branchId, code: 'HACK', name: 'x' })],
    ['terminal on A register', () => http().post('/v1/terminals').set(auth).send({ registerId: a.registerId, name: 'x' })],
    ['category under A parent', () => http().post('/v1/categories').set(auth).send({ name: 'x', parentId: a.categoryId })],
    ['re-parent B category under A', () => http().patch(`/v1/categories/${b.categoryId}`).set(auth).send({ parentId: a.categoryId })],
    ['product in A category', () => http().post('/v1/products').set(auth).send({ name: 'x', categoryId: a.categoryId, taxCategoryId: b.taxId, uomId: b.uomId, variants: [{ sku: uniq('S') }] })],
    ['product with A tax category', () => http().post('/v1/products').set(auth).send({ name: 'x', taxCategoryId: a.taxId, uomId: b.uomId, variants: [{ sku: uniq('S') }] })],
    ['product with A uom', () => http().post('/v1/products').set(auth).send({ name: 'x', taxCategoryId: b.taxId, uomId: a.uomId, variants: [{ sku: uniq('S') }] })],
    ['move B product into A category', () => http().patch(`/v1/products/${b.productId}`).set(auth).send({ categoryId: a.categoryId })],
    ['price A variant in B list', () => http().post(`/v1/price-lists/${b.priceListId}/prices`).set(auth).send({ items: [{ variantId: a.variantId, amount: '0.01' }] })],
    ['assign A list to B branch', () => http().put(`/v1/branches/${b.branchId}/price-list`).set(auth).send({ priceListId: a.priceListId })],
    ['lookup in A branch', () => http().get('/v1/catalog/lookup').query({ code: 'x', branchId: a.branchId }).set(auth)],
    ['invite with A role', () => http().post('/v1/invitations').set(auth).send({ email: `${uniq('x')}@example.ph`, roles: [{ roleId: a.cashierRoleId, scopeType: 'TENANT', scopeId: null }] })],
    ['invite scoped to A branch', () => http().post('/v1/invitations').set(auth).send({ email: `${uniq('x')}@example.ph`, roles: [{ roleId: b.cashierRoleId, scopeType: 'BRANCH', scopeId: a.branchId }] })],
    ['give B member A role', () => http().put(`/v1/members/${b.memberId}/roles`).set(auth).send({ roles: [{ roleId: a.roleId, scopeType: 'TENANT', scopeId: null }] })],
    ['quote at A branch', () => http().post('/v1/tax/quote').set(auth).send({ branchId: a.branchId, lines: [{ variantId: b.variantId, quantity: '1' }] })],
    ['quote A variant at B branch', () => http().post('/v1/tax/quote').set(auth).send({ branchId: b.branchId, lines: [{ variantId: a.variantId, quantity: '1' }] })],
    ['open a session on A register', () => http().post('/v1/cashier-sessions').set(auth).send({ registerId: a.registerId, openingFloat: '0' })],
    ['sell on A session', () => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: a.openSessionId, clientTransactionId: randomUUID(), lines: [{ variantId: b.variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }] })],
    ['sell A variant on B session', () => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), lines: [{ variantId: a.variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }] })],
    ['take a payment on A session', () => http().post('/v1/payment-intents').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: a.openSessionId, clientTransactionId: randomUUID(), method: 'CARD', amount: '1.00' })],
    ['tender A payment in a B sale', () => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), lines: [{ variantId: b.variantId, quantity: '1' }], tenders: [{ method: 'INTENT', paymentIntentId: a.paymentIntentId }] })],
    ['list A session payments', () => http().get('/v1/payment-intents').query({ cashierSessionId: a.openSessionId }).set(auth)],
    ['refund a B sale from the A drawer', () => http().post(`/v1/sales/${b.saleId}/returns`).set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: a.openSessionId, kind: 'VOID', reason: 'x' })],
    ...(['sales-summary', 'by-product', 'by-cashier', 'by-tender', 'tax-summary', 'statutory-book'] as const).map(
      (r) => [`report ${r} on A branch`, () => http().get(`/v1/reports/${r}`).query({ branchId: a.branchId, from: '2026-01-01', to: '2026-12-31' }).set(auth)] as [string, () => request.Test],
    ),
    ['adjust stock at A branch', () => http().post('/v1/stock/adjustments').set(auth).send({ branchId: a.branchId, reason: 'x', items: [{ variantId: b.variantId, quantity: '1' }] })],
    ['adjust A variant at B branch', () => http().post('/v1/stock/adjustments').set(auth).send({ branchId: b.branchId, reason: 'x', items: [{ variantId: a.variantId, quantity: '1' }] })],
    ['read A stock balances', () => http().get('/v1/stock/balances').query({ branchId: a.branchId }).set(auth)],
    ['read A stock movements', () => http().get('/v1/stock/movements').query({ branchId: a.branchId }).set(auth)],
    ['switch into A', () => http().post('/v1/auth/switch-tenant').set(auth).send({ tenantId: a.t.tenantId })],
    ['order from the A supplier', () => http().post('/v1/purchase-orders').set(auth).send({ branchId: b.branchId, supplierId: a.supplierId, lines: [{ variantId: b.variantId, quantity: '1', unitCost: '1' }] })],
    ['order for the A branch', () => http().post('/v1/purchase-orders').set(auth).send({ branchId: a.branchId, supplierId: b.supplierId, lines: [{ variantId: b.variantId, quantity: '1', unitCost: '1' }] })],
    ['order an A variant', () => http().post('/v1/purchase-orders').set(auth).send({ branchId: b.branchId, supplierId: b.supplierId, lines: [{ variantId: a.variantId, quantity: '1', unitCost: '1' }] })],
    ['move a B draft to the A supplier', () => http().patch(`/v1/purchase-orders/${b.draftOrderId}`).set(auth).send({ supplierId: a.supplierId })],
    ['receive against the A order', () => http().post('/v1/goods-receipts').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b.branchId, supplierId: b.supplierId, purchaseOrderId: a.purchaseOrderId, lines: [{ variantId: b.variantId, quantity: '1', unitCost: '1' }] })],
    ['receive at the A branch', () => http().post('/v1/goods-receipts').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: a.branchId, supplierId: b.supplierId, lines: [{ variantId: b.variantId, quantity: '1', unitCost: '1' }] })],
    ['receive from the A supplier', () => http().post('/v1/goods-receipts').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b.branchId, supplierId: a.supplierId, lines: [{ variantId: b.variantId, quantity: '1', unitCost: '1' }] })],
    ['return against the A receipt', () => http().post('/v1/supplier-returns').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b.branchId, supplierId: b.supplierId, goodsReceiptId: a.goodsReceiptId, reason: 'x', lines: [{ variantId: b.variantId, quantity: '1' }] })],
    ['list receipts at the A branch', () => http().get('/v1/goods-receipts').query({ branchId: a.branchId }).set(auth)],
    ['list supplier returns at the A branch', () => http().get('/v1/supplier-returns').query({ branchId: a.branchId }).set(auth)],
    ['transfer from the A branch', () => http().post('/v1/stock/transfers').set(auth).set('Idempotency-Key', randomUUID()).send({ fromBranchId: a.branchId, toBranchId: b.branchId, lines: [{ variantId: b.variantId, quantity: '1' }] })],
    ['transfer to the A branch', () => http().post('/v1/stock/transfers').set(auth).set('Idempotency-Key', randomUUID()).send({ fromBranchId: b.branchId, toBranchId: a.branchId, lines: [{ variantId: b.variantId, quantity: '1' }] })],
    ['transfer an A variant', () => http().post('/v1/stock/transfers').set(auth).set('Idempotency-Key', randomUUID()).send({ fromBranchId: b.branchId, toBranchId: b.branch2Id, lines: [{ variantId: a.variantId, quantity: '1' }] })],
    ['count at the A branch', () => http().post('/v1/stock/counts').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: a.branchId, lines: [{ variantId: b.variantId, countedQuantity: '0' }] })],
    ['count an A variant', () => http().post('/v1/stock/counts').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b.branchId, lines: [{ variantId: a.variantId, countedQuantity: '0' }] })],
    ['reorder points at the A branch', () => http().put('/v1/stock/reorder-points').set(auth).send({ branchId: a.branchId, items: [{ variantId: b.variantId, reorderPoint: '1' }] })],
    ['reorder point for an A variant', () => http().put('/v1/stock/reorder-points').set(auth).send({ branchId: b.branchId, items: [{ variantId: a.variantId, reorderPoint: '1' }] })],
    ['low stock at the A branch', () => http().get('/v1/stock/low').query({ branchId: a.branchId }).set(auth)],
    ['transfers at the A branch', () => http().get('/v1/stock/transfers').query({ branchId: a.branchId }).set(auth)],
    ['counts at the A branch', () => http().get('/v1/stock/counts').query({ branchId: a.branchId }).set(auth)],
    ['adjustments at the A branch', () => http().get('/v1/stock/adjustments').query({ branchId: a.branchId }).set(auth)],
    ['valuation of the A branch', () => http().get('/v1/reports/inventory-valuation').query({ branchId: a.branchId }).set(auth)],
    ['stock movements report of the A branch', () => http().get('/v1/reports/stock-movements').query({ branchId: a.branchId, from: '2026-01-01', to: '2026-12-31' }).set(auth)],
    ['chart of the A entity', () => http().get('/v1/accounts').query({ legalEntityId: a.entityId }).set(auth)],
    ['account in the A entity', () => http().post('/v1/accounts').set(auth).send({ legalEntityId: a.entityId, code: '9999', name: 'x', type: 'EXPENSE' })],
    ['journal of the A entity', () => http().get('/v1/journal-entries').query({ legalEntityId: a.entityId }).set(auth)],
    ['manual entry in the A entity', () => http().post('/v1/journal-entries').set(auth).set('Idempotency-Key', randomUUID()).send({ legalEntityId: a.entityId, entryDate: '2026-10-01', memo: 'x', lines: [{ accountId: a.cashAccountId, debit: '1' }, { accountId: a.cashAccountId, credit: '1' }] })],
    ['manual entry on an A account', () => http().post('/v1/journal-entries').set(auth).set('Idempotency-Key', randomUUID()).send({ legalEntityId: b.entityId, entryDate: '2026-10-01', memo: 'x', lines: [{ accountId: a.cashAccountId, debit: '1' }, { accountId: b.cashAccountId, credit: '1' }] })],
    ['manual entry for an A branch', () => http().post('/v1/journal-entries').set(auth).set('Idempotency-Key', randomUUID()).send({ legalEntityId: b.entityId, entryDate: '2026-10-01', memo: 'x', lines: [{ accountId: b.cashAccountId, debit: '1', branchId: a.branchId }, { accountId: b.cashAccountId, credit: '1' }] })],
    ['periods of the A entity', () => http().get('/v1/accounting/periods').query({ legalEntityId: a.entityId }).set(auth)],
    ['close an A period', () => http().post('/v1/accounting/periods/close').set(auth).send({ legalEntityId: a.entityId, month: '2020-01' })],
    ['trial balance of the A entity', () => http().get('/v1/reports/trial-balance').query({ legalEntityId: a.entityId, from: '2026-01-01', to: '2026-12-31' }).set(auth)],
    ['recipe with an A ingredient', () => http().post(`/v1/variants/${b.dishId}/recipe`).set(auth).send({ ingredients: [{ variantId: a.variantId, quantity: '1' }] })],
  ];
}

/** All string values anywhere in a JSON document. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

const idsOf = (w: World) =>
  [w.t.tenantId, w.t.userId, w.entityId, w.branchId, w.registerId, w.terminalId, w.categoryId, w.productId, w.variantId, w.barcodeId,
   w.priceListId, w.defaultListId, w.roleId, w.cashierRoleId, w.invitationId, w.memberId, w.uomId, w.taxId,
   w.supplierId, w.purchaseOrderId, w.draftOrderId, w.goodsReceiptId, w.supplierReturnId, w.branch2Id, w.transferId, w.countId, w.adjustmentId, w.journalEntryId, w.cashAccountId, w.dishId];

describe('Phase 1 cross-tenant sweep', () => {
  it('the attack matrix covers every id-addressed route in the router', () => {
    const router = (app.getHttpAdapter().getInstance() as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }).router;
    const live = router.stack
      .filter((l) => l.route && l.route.path.includes(':'))
      .flatMap((l) => Object.keys(l.route!.methods).filter((m) => m !== '_all').map((m) => `${m.toUpperCase()} ${l.route!.path}`));
    expect(live.length).toBeGreaterThan(20);
    expect([...live].sort()).toEqual(Object.keys(attackMatrix()).sort());
  });

  it("every id-addressed route answers 404 NOT_FOUND for the other tenant's ids", async () => {
    const results = await Promise.all(Object.entries(attackMatrix()).map(async ([k, send]) => [k, await send()] as const));
    const leaks = results.filter(([, r]) => r.status !== 404 || r.body.error?.code !== 'NOT_FOUND').map(([k, r]) => `${k} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    expect(leaks).toEqual([]);
  });

  it("references to the other tenant's ids inside bodies and queries are refused", async () => {
    const results = await Promise.all(smuggleMatrix().map(async ([k, send]) => [k, await send()] as const));
    // 404 (not found in this tenant) or 403 (switch-tenant: not a member) — never success, never 5xx.
    const bad = results.filter(([, r]) => ![403, 404].includes(r.status)).map(([k, r]) => `${k} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    expect(bad).toEqual([]);
  });

  it('A is untouched after the attacks', async () => {
    const p = await http().get(`/v1/products/${a.productId}`).set(a.auth).expect(200);
    expect([p.body.name, p.body.archivedAt, p.body.categoryId]).toEqual(['Cola', null, a.categoryId]);
    const terminals = (await http().get('/v1/terminals').set(a.auth).expect(200)).body.data;
    expect(terminals.map((x: { status: string }) => x.status)).toEqual(['ACTIVE']);
    const members = (await http().get('/v1/members').set(a.auth).expect(200)).body.data;
    expect(members.find((m: { membershipId: string }) => m.membershipId === a.memberId)?.status).toBe('ACTIVE');
    const invites = (await http().get('/v1/invitations').set(a.auth).expect(200)).body.data;
    expect(invites.find((i: { id: string }) => i.id === a.invitationId)?.status).toBe('PENDING');
    const session = (await http().get(`/v1/cashier-sessions/${a.openSessionId}`).set(a.auth).expect(200)).body;
    expect([session.status, session.expectedCash]).toEqual(['OPEN', a.openSessionCash]);
    const closed = (await http().get(`/v1/cashier-sessions/${a.closedSessionId}`).set(a.auth).expect(200)).body;
    expect([closed.status, closed.reconciliation.approvedBy]).toEqual(['CLOSED', null]);
    const stock = (await http().get('/v1/stock/balances').query({ branchId: a.branchId }).set(a.auth).expect(200)).body.data;
    // 10 opening − 1 sold − 1 used in the dish + 3 received − 1 returned to the supplier − 1 transferred to branch 2.
    expect(stock.map((x: { quantity: string }) => x.quantity)).toEqual(['9']);
    const t = (await http().get(`/v1/stock/transfers/${a.transferId}`).set(a.auth).expect(200)).body;
    expect([t.status, t.lines[0].receivedQuantity]).toEqual(['RECEIVED', '1']);
    const po = (await http().get(`/v1/purchase-orders/${a.draftOrderId}`).set(a.auth).expect(200)).body;
    expect([po.status, po.notes]).toEqual(['DRAFT', null]);
  });

  it("no list or read endpoint returns any of the other tenant's ids", async () => {
    const paths = [
      '/v1/me', '/v1/members', '/v1/roles', '/v1/subscription', '/v1/legal-entities', '/v1/branches', '/v1/registers', '/v1/terminals',
      `/v1/legal-entities/${b.entityId}/tax-profiles`, '/v1/discount-schemes',
      '/v1/uoms', '/v1/tax-categories', '/v1/categories', '/v1/products', '/v1/price-lists', `/v1/price-lists/${b.priceListId}/prices`,
      `/v1/variants/${b.variantId}/price-history`, `/v1/variants/${b.dishId}/recipe`, '/v1/invitations',
      '/v1/pos/workstations', '/v1/cashier-sessions', `/v1/cashier-sessions/${b.closedSessionId}`, '/v1/sales', `/v1/sales?cashierSessionId=${a.closedSessionId}`, `/v1/sales/${b.saleId}`, `/v1/sales/${b.saleId}/receipt`, `/v1/sales/${b.saleId}/returns`, `/v1/payment-intents/${b.paymentIntentId}`, `/v1/payment-intents?cashierSessionId=${b.openSessionId}`,
      `/v1/stock/balances?branchId=${b.branchId}`, `/v1/reports/cashier-sessions/${b.closedSessionId}`,
      ...['sales-summary', 'by-product', 'by-cashier', 'by-tender', 'tax-summary', 'statutory-book'].map((r) => `/v1/reports/${r}?branchId=${b.branchId}&from=2026-01-01&to=2026-12-31`), `/v1/stock/movements?branchId=${b.branchId}`,
      '/v1/suppliers', `/v1/suppliers/${b.supplierId}`, '/v1/purchase-orders', `/v1/purchase-orders?branchId=${a.branchId}`, `/v1/purchase-orders/${b.purchaseOrderId}`,
      `/v1/goods-receipts?branchId=${b.branchId}`, `/v1/goods-receipts/${b.goodsReceiptId}`, `/v1/supplier-returns?branchId=${b.branchId}`, `/v1/supplier-returns/${b.supplierReturnId}`,
      `/v1/stock/transfers?branchId=${b.branchId}`, `/v1/stock/transfers/${b.transferId}`, `/v1/stock/counts?branchId=${b.branch2Id}`, `/v1/stock/counts/${b.countId}`, `/v1/stock/adjustments?branchId=${b.branchId}`, `/v1/stock/adjustments/${b.adjustmentId}`,
      `/v1/stock/low?branchId=${b.branchId}`, `/v1/reports/inventory-valuation?branchId=${b.branchId}`, `/v1/reports/stock-movements?branchId=${b.branchId}&from=2026-01-01&to=2026-12-31`,
      `/v1/accounts?legalEntityId=${b.entityId}`, `/v1/journal-entries?legalEntityId=${b.entityId}`, `/v1/journal-entries/${b.journalEntryId}`,
      `/v1/accounting/periods?legalEntityId=${b.entityId}`, `/v1/reports/trial-balance?legalEntityId=${b.entityId}&from=2026-01-01&to=2026-12-31`,
    ];
    const foreign = new Set(idsOf(a));
    for (const path of paths) {
      const res = await http().get(path).set(b.auth);
      expect([path, res.status]).toEqual([path, 200]);
      expect([path, strings(res.body).filter((s) => foreign.has(s))]).toEqual([path, []]);
    }
  });

  describe('database sweep (every tenant table)', () => {
    let tables: string[];
    beforeAll(async () => {
      const { rows } = await owner.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY 1`,
      );
      tables = rows.map((r) => r.table_name);
    });

    it('the fixture puts at least one row for tenant A in every tenant table', async () => {
      const empty = await asOwnerInTenant(owner, a.t.tenantId, async (c) => {
        const out: string[] = [];
        for (const t of tables) {
          const { rows } = await c.query(`SELECT 1 FROM ${t} LIMIT 1`);
          if (rows.length === 0) out.push(t);
        }
        return out;
      });
      expect(empty).toEqual([]);
    });

    it("the runtime role in tenant B's context sees and changes none of A's rows", async () => {
      const { rows: updatable } = await owner.query<{ table_name: string; column_name: string }>(
        `SELECT DISTINCT ON (table_name) table_name, column_name FROM information_schema.column_privileges
          WHERE grantee = 'onepos_app' AND privilege_type = 'UPDATE' ORDER BY table_name, column_name`,
      );
      const c = await runtime.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [b.t.tenantId]);
        const problems: string[] = [];
        for (const t of tables) {
          const seen = await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id IS DISTINCT FROM $1`, [b.t.tenantId]);
          if (seen.rows[0].n !== 0) problems.push(`${t}: sees ${seen.rows[0].n} foreign rows`);
          const col = updatable.find((u) => u.table_name === t)?.column_name;
          if (col) {
            const upd = await c.query(`UPDATE ${t} SET ${col} = ${col} WHERE tenant_id = $1`, [a.t.tenantId]);
            if (upd.rowCount !== 0) problems.push(`${t}: updated ${upd.rowCount} foreign rows`);
          }
        }
        expect(problems).toEqual([]);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it("the runtime role cannot write rows into another tenant (WITH CHECK)", async () => {
      const c = await runtime.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [b.t.tenantId]);
        const err = await c
          .query(`INSERT INTO categories (tenant_id, name) VALUES ($1, 'smuggled')`, [a.t.tenantId])
          .then(() => null, (e: { code?: string }) => e.code);
        expect(err).toBe('42501');
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('without a tenant context the runtime role sees no tenant rows at all (fail closed)', async () => {
      const problems: string[] = [];
      for (const t of tables) {
        const { rows } = await runtime.query(`SELECT count(*)::int AS n FROM ${t}`);
        if (rows[0].n !== 0) problems.push(`${t}: ${rows[0].n}`);
      }
      expect(problems).toEqual([]);
    });
  });
});
