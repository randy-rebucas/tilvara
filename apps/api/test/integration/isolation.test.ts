import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExportLinks } from '../../src/exports/export-links.js';
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
const RESTAURANT_REPORTS = ['item-performance', 'ingredient-usage', 'kitchen-voids', 'prep-times', 'service-charge'] as const;
/** Today in Manila (the branches' timezone). */
const today = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

interface World {
  t: SignedUp;
  packVariantId: string;
  packLinkId: string;
  packOpeningId: string;
  pieceLotId: string;
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
  saleReturnId: string;
  cashMovementId: string;
  paymentIntentId: string;
  openSessionCash: string;
  supplierId: string;
  purchaseOrderId: string;
  draftOrderId: string;
  goodsReceiptId: string;
  supplierReturnId: string;
  supplierInvoiceId: string;
  supplierPaymentId: string;
  supplierNoteId: string;
  priceOverrideId: string;
  heldCartId: string;
  customerId: string;
  customerSaleId: string;
  reservationId: string;
  supplierItemId: string;
  promotionId: string;
  apiKeyId: string;
  webhookId: string;
  webhookDeliveryId: string;
  branch2Id: string;
  transferId: string;
  countId: string;
  sheetId: string;
  zRegisterId: string;
  zReadingId: string;
  adjustmentId: string;
  journalEntryId: string;
  cashAccountId: string;
  dishId: string;
  stationId: string;
  areaId: string;
  tableId: string;
  modifierGroupId: string;
  modifierOptionId: string;
  menuId: string;
  draftVersionId: string;
  orderId: string;
  pendingItemId: string;
  firedItemId: string;
  ticketId: string;
  billId: string;
  checkSaleId: string;
  liveOrderId: string;
  liveItemId: string;
  terminalHeaders: Record<string, string>;
  snapshotId: string;
  offlineTxnId: string;
  supportGrantId: string;
  exportId: string;
  serviceId: string;
  staffId: string;
  timeOffId: string;
  appointmentId: string;
  bundleId: string;
  customerPackageId: string;
  noteId: string;
  roomTypeId: string;
  roomId: string;
  roomBlockId: string;
  stayId: string;
  folioId: string;
  guestId: string;
  beneficiaryId: string;
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
  const terminal = ok<{ terminal: { id: string }; credential: string }>(await http().post('/v1/terminals').set(auth).send({ registerId: register.id, name: 'T1' }));
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
  const adjustment = ok(await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: branch.id, reason: 'Opening stock', items: [{ variantId, quantity: '10' }] }));
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
  const payIn = ok(await http().post(`/v1/cashier-sessions/${openSession.id}/movements`).set(auth).send({ type: 'PAY_IN', amount: '10.00', reason: 'Fixture float top-up' }));
  const saleReturn = ok(
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
      .send({ cashierSessionId: openSession.id, clientTransactionId: randomUUID(), lines: [{ variantId: dishId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }], tip: { amount: '5.00' } }),
  );
  // Session 25: a dish with a card tip, voided: the tip's charge is cancelled (sale_tip_refunds).
  const tipTxn = randomUUID();
  const tipCharge = ok<{ id: string }>(await http().post('/v1/payment-intents').set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: openSession.id, clientTransactionId: tipTxn, method: 'CARD', amount: '7.00', purpose: 'TIP' }));
  const tipped = ok<{ id: string }>(await http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: openSession.id, clientTransactionId: tipTxn, lines: [{ variantId: dishId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }], tip: { amount: '7.00', paymentIntentId: tipCharge.id } }));
  ok(await http().post(`/v1/sales/${tipped.id}/returns`).set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: openSession.id, kind: 'VOID', reason: 'Wrong table' }));
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
  // Session 16: the supplier's invoice for that receipt, part paid.
  const supplierInvoice = ok(
    await http().post('/v1/supplier-invoices').set(auth).set('Idempotency-Key', randomUUID())
      .send({ supplierId: supplier.id, invoiceNumber: 'F-1', invoiceDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()), goodsReceiptIds: [receipt.id], netAmount: '24.00', vatAmount: '2.88' }),
  );
  const paid = ok<{ payments: { id: string }[] }>(
    await http().post(`/v1/supplier-invoices/${supplierInvoice.id}/payments`).set(auth).set('Idempotency-Key', randomUUID())
      .send({ amount: '10.00', paidOn: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()), method: 'BANK_TRANSFER' }),
  );
  // Session 22: a debit note on that invoice (the payment above is its allocation row).
  const noted = ok<{ adjustments: { id: string }[] }>(
    await http().post(`/v1/supplier-invoices/${supplierInvoice.id}/notes`).set(auth).set('Idempotency-Key', randomUUID())
      .send({ kind: 'DEBIT', noteNumber: 'DM-F', noteDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()), netAmount: '1.00', vatAmount: '0', reason: 'Fixture' }),
  );
  // Phase 3 slice 3: a received transfer to a second branch, a count, and a reorder point.
  const branch2 = ok(await http().post('/v1/branches').set(auth).send({ legalEntityId: entity.id, code: 'B2', name: 'Two', birBranchCode: '00001' }));
  const transfer = ok(await http().post('/v1/stock/transfers').set(auth).set('Idempotency-Key', randomUUID()).send({ fromBranchId: branch.id, toBranchId: branch2.id, lines: [{ variantId, quantity: '1' }] }));
  ok(await http().post(`/v1/stock/transfers/${transfer.id}/receive`).set(auth).set('Idempotency-Key', randomUUID()).send({}), 200);
  const count = ok(await http().post('/v1/stock/counts').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: branch2.id, lines: [{ variantId, countedQuantity: '2' }] }));
  ok(await http().put('/v1/stock/reorder-points').set(auth).send({ branchId: branch.id, items: [{ variantId, reorderPoint: '20' }] }), 200);
  // Session 16: a Z-reading of a second register (no shift open on it), for today.
  const zRegister = ok(await http().post('/v1/registers').set(auth).send({ branchId: branch.id, code: 'RZ', name: 'Z only' }));
  const zDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const zReading = ok(await http().post(`/v1/registers/${zRegister.id}/z-readings`).set(auth).send({ day: zDay }));
  // Session 16: branch inventory settings and an open count sheet with one counted line.
  ok(await http().put(`/v1/branches/${branch.id}/inventory-settings`).set(auth).send({ negativeStockPolicy: 'ALLOW_WITH_FLAG', lowStockAlerts: true }), 200);
  const sheet = ok(await http().post('/v1/stock/count-sheets').set(auth).send({ branchId: branch2.id, variantIds: [variantId] }));
  ok(await http().put(`/v1/stock/count-sheets/${sheet.id}/lines`).set(auth).send({ lines: [{ variantId, countedQuantity: '2' }] }), 200);
  // Phase 3 slice 4: the books every document above posted to (chart seeded with the entity).
  const accounts = ok<{ data: { id: string; systemKey: string }[] }>(await http().get('/v1/accounts').query({ legalEntityId: entity.id }).set(auth), 200).data;
  const entries = ok<{ data: { id: string }[] }>(await http().get('/v1/journal-entries').query({ legalEntityId: entity.id, sourceType: 'SALE' }).set(auth), 200).data;
  // Phase 4 slice 2: station, floor, modifiers, a published menu with a new draft, settings and an 86.
  const station = ok(await http().post('/v1/kitchen-stations').set(auth).send({ branchId: branch.id, code: 'GRILL', name: 'Grill', isDefault: true }));
  const area = ok(await http().post('/v1/dining-areas').set(auth).send({ branchId: branch.id, name: 'Hall' }));
  const table = ok(await http().post('/v1/restaurant-tables').set(auth).send({ areaId: area.id, code: 'T1' }));
  const group = ok<{ id: string; options: { id: string }[] }>(
    await http().post('/v1/modifier-groups').set(auth).send({ name: 'Extras', options: [{ name: 'Extra', variantId: dishId }, { name: 'Plain' }] }),
  );
  const menu = ok<{ id: string; draft: { id: string } }>(await http().post('/v1/menus').set(auth).send({ name: 'All day' }));
  ok(await http().put(`/v1/menu-versions/${menu.draft.id}/content`).set(auth).send({ sections: [{ name: 'Mains', items: [{ variantId: dishId, stationCode: 'GRILL', modifierGroupIds: [group.id] }] }] }), 200);
  ok(await http().post(`/v1/menu-versions/${menu.draft.id}/publish`).set(auth), 200);
  const draftVersion = ok(await http().post(`/v1/menus/${menu.id}/drafts`).set(auth));
  ok(await http().put(`/v1/branches/${branch.id}/restaurant-settings`).set(auth).send({ dineInMenuId: menu.id, takeawayMenuId: null, serviceChargeRate: '0.10', serviceChargeDineIn: true, serviceChargeTakeaway: false, serviceChargeVatTreatment: 'VATABLE' }), 200);
  ok(await http().put(`/v1/branches/${branch.id}/sold-out`).set(auth).send({ variantId, soldOut: true }), 200);
  // Phase 4 slice 3: an order on T1 with one fired item (a kitchen ticket) and one pending item.
  const order = ok<{ id: string }>(await http().post('/v1/restaurant/orders').set(auth).send({ branchId: branch.id, orderType: 'DINE_IN', tableId: table.id }));
  ok(await http().post(`/v1/restaurant/orders/${order.id}/items`).set(auth).set('Idempotency-Key', randomUUID()).send({ items: [{ variantId: dishId, quantity: '1', modifierOptionIds: [group.options[0]!.id] }] }));
  const fired = ok<{ items: { id: string }[]; tickets: { id: string }[] }>(await http().post(`/v1/restaurant/orders/${order.id}/fire`).set(auth).send({}), 200);
  const withPending = ok<{ items: { id: string }[] }>(await http().post(`/v1/restaurant/orders/${order.id}/items`).set(auth).set('Idempotency-Key', randomUUID()).send({ items: [{ variantId: dishId, quantity: '1' }] }));
  // Phase 4 slice 4: billed with an SC diner and the service charge, paid in one check, part returned.
  ok(await http().post(`/v1/restaurant/orders/${order.id}/fire`).set(auth).send({}), 200);
  const bill = ok<{ id: string }>(
    await http().post(`/v1/restaurant/orders/${order.id}/bill`).set(auth).set('Idempotency-Key', randomUUID())
      .send({ beneficiaries: [{ ref: 'b1', scheme: 'SC', name: 'Lolo', idNumber: 'OSCA-2' }], statutory: [{ orderItemId: withPending.items[1]!.id, beneficiary: 'b1' }] }),
  );
  const checkSale = ok<{ id: string; lines: { id: string }[] }>(
    await http().post(`/v1/restaurant/bills/${bill.id}/checks`).set(auth).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: openSession.id, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '1000.00' }] }),
  );
  ok(
    await http().post(`/v1/sales/${checkSale.id}/returns`).set(auth).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: openSession.id, kind: 'RETURN', reason: 'Fixture', lines: [{ saleLineId: checkSale.lines[0]!.id, quantity: '1', disposition: 'DAMAGED' }] }),
  );
  // A second, still-open order (T2) for the move/transfer probes.
  const table2 = ok(await http().post('/v1/restaurant-tables').set(auth).send({ areaId: area.id, code: 'T2' }));
  const liveOrder = ok<{ id: string }>(await http().post('/v1/restaurant/orders').set(auth).send({ branchId: branch.id, orderType: 'DINE_IN', tableId: table2.id }));
  const liveItems = ok<{ items: { id: string }[] }>(await http().post(`/v1/restaurant/orders/${liveOrder.id}/items`).set(auth).set('Idempotency-Key', randomUUID()).send({ items: [{ variantId: dishId, quantity: '1' }] }));
  // Session 16: a course note on the live order, and an item moved from it to a new order on T3 (its move history).
  ok(await http().put(`/v1/restaurant/orders/${liveOrder.id}/course-notes`).set(auth).send({ course: 1, note: 'Fixture note' }), 200);
  const extra = ok<{ items: { id: string }[] }>(await http().post(`/v1/restaurant/orders/${liveOrder.id}/items`).set(auth).set('Idempotency-Key', randomUUID()).send({ items: [{ variantId: dishId, quantity: '1' }] }));
  const table3 = ok(await http().post('/v1/restaurant-tables').set(auth).send({ areaId: area.id, code: 'T3' }));
  ok(await http().post(`/v1/restaurant/orders/${liveOrder.id}/move-items`).set(auth).send({ itemIds: [extra.items[1]!.id], toTableId: table3.id }), 200);
  // Phase 5: the terminal takes a snapshot and delivers two offline sales: one recorded, one quarantined (wrong total).
  const terminalHeaders = { 'x-terminal-id': terminal.terminal.id, Authorization: `Terminal ${terminal.credential}` };
  const snap = ok<{ snapshotId: string }>(await http().get('/v1/terminal/snapshot').set(terminalHeaders), 200);
  const offline = (n: number, amountDue: string) => ({
    terminalTxnId: randomUUID(), deviceSeq: n, snapshotId: snap.snapshotId, cashierSessionId: openSession.id, cashierUserId: t.userId,
    occurredAt: new Date().toISOString(), localReference: `R1-T-${n}`, lines: [{ variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '50.00' }], amountDue,
  });
  const synced = ok<{ results: { status: string }[] }>(await http().post('/v1/sync/sales').set(terminalHeaders).send({ sales: [offline(1, '22.00'), offline(2, '1.00')] }), 200);
  if (synced.results.map((r) => r.status).join() !== 'RECORDED,QUARANTINED') throw new Error(`fixture sync → ${JSON.stringify(synced.results)}`);
  const quarantined = ok<{ data: { id: string }[] }>(await http().get('/v1/sync/transactions').query({ status: 'QUARANTINED' }).set(auth), 200).data[0]!;
  // Session 20 (ADR-0018): a customer who bought two gift wraps (untracked: stock stays as it is), returned
  // one as store credit and spent ₱10 of it on another wrap; the consent they gave is on record. Half of the
  // ₱30.00 line comes back as ₱15.01: returns round each tax bucket on its own (LEFTOVER, Phase 4 slice 4).
  const wrap = ok<{ variants: { id: string }[] }>(await http().post('/v1/products').set(auth).send({ name: 'Gift wrap', productType: 'SERVICE', taxCategoryId: taxId, uomId, trackInventory: false, variants: [{ sku: uniq('WRAP'), price: '15.00' }] }));
  const wrapId = wrap.variants[0]!.id;
  ok(await http().post(`/v1/price-lists/${priceList.id}/prices`).set(auth).send({ items: [{ variantId: wrapId, amount: '15.00' }] }));
  const customer = ok(await http().post('/v1/customers').set(auth).send({ displayName: `${prefix} Customer`, phone: '09170000000', marketingConsent: true, consentSource: 'COUNTER' }));
  const customerSale = ok<{ id: string; lines: { id: string }[] }>(
    await http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: openSession.id, clientTransactionId: randomUUID(), customerId: customer.id, lines: [{ variantId: wrapId, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '30.00' }] }),
  );
  ok(await http().post(`/v1/sales/${customerSale.id}/returns`).set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: openSession.id, kind: 'RETURN', reason: 'Fixture credit', refundTo: 'STORE_CREDIT', lines: [{ saleLineId: customerSale.lines[0]!.id, quantity: '1', disposition: 'DAMAGED' }] }));
  ok(await http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: openSession.id, clientTransactionId: randomUUID(), customerId: customer.id, lines: [{ variantId: wrapId, quantity: '1' }], tenders: [{ method: 'STORE_CREDIT', amount: '10.00' }, { method: 'CASH', tendered: '5.00' }] }));
  // Session 20: one unit of the item set aside for the customer, and the supplier's catalog entry for it.
  const reservation = ok(await http().post('/v1/stock/reservations').set(auth).send({ branchId: branch.id, variantId, quantity: '1', note: 'Fixture hold', customerId: customer.id }));
  const supplierItem = ok(await http().post(`/v1/suppliers/${supplier.id}/items`).set(auth).send({ variantId, supplierSku: 'SUP-COLA', unitCost: '11.00', preferred: true }));
  // Session 24 (ADR-0020): a pack of 10 linked to its piece, one pack in stock and opened by hand.
  const packItem = ok<{ variants: { id: string }[] }>(await http().post('/v1/products').set(auth).send({ name: 'Candy (pack of 10)', taxCategoryId: taxId, uomId, tracksExpiry: true, variants: [{ sku: uniq('PACK'), price: '50.00' }] }));
  const pieceItem = ok<{ variants: { id: string }[] }>(await http().post('/v1/products').set(auth).send({ name: 'Candy', taxCategoryId: taxId, uomId, tracksExpiry: true, variants: [{ sku: uniq('PIECE'), price: '6.00' }] }));
  const packVariantId = packItem.variants[0]!.id;
  const packLink = ok(await http().post('/v1/pack-conversions').set(auth).send({ packVariantId, pieceVariantId: pieceItem.variants[0]!.id, piecesPerPack: '10' }));
  ok(await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: branch.id, reason: 'Fixture packs', items: [{ variantId: packVariantId, quantity: '1', unitCost: '40.00', expiresOn: '2030-01-31', lotCode: 'FIX-1' }] }));
  // The pieces take the pack's date: a lot of candy with its lot movement.
  // Session 26 (ADR-0021): the item on a shelf, and a promotion on the packs at this branch (no sale buys two).
  ok(await http().put('/v1/stock/locations').set(auth).send({ branchId: branch.id, items: [{ variantId, location: 'A1-1' }] }), 200);
  const promotion = ok(await http().post('/v1/promotions').set(auth).send({ name: 'Two for 90', kind: 'MULTI_BUY', quantity: 2, price: '90.00', variantIds: [packVariantId], branchIds: [branch.id] }));
  const packOpening = ok(await http().post('/v1/stock/pack-openings').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: branch.id, conversionId: packLink.id, packs: '1', reason: 'Fixture' }));
  // Session 20 (ADR-0019): on a plan with API access, a read-only key, a webhook and its test ping.
  await owner.query(`SELECT platform_set_subscription($1, 'enterprise', 'ACTIVE', null, null)`, [t.tenantId]);
  const apiKey = ok(await http().post('/v1/api-keys').set(auth).send({ name: 'Fixture', scopes: ['org.read'] }));
  const webhook = ok(await http().post('/v1/webhooks').set(auth).send({ url: 'https://hooks.example.ph/fixture', topics: ['sale.completed'] }));
  const webhookPing = ok(await http().post(`/v1/webhooks/${webhook.id}/ping`).set(auth));
  // Session 27 (ADR-0022): the wrap as a 30-minute service; a stylist with hours, the service and time off;
  // a two-session bundle sold to the customer; one session used on a booked appointment with a tip shared
  // with the stylist, then given back; a live booking; a service note.
  ok(await http().patch(`/v1/variants/${wrapId}`).set(auth).send({ serviceMinutes: 30 }), 200);
  const stylist = ok(await http().post('/v1/service-staff').set(auth).send({ branchId: branch.id, displayName: `${prefix} Stylist`, commissionRate: '0.1' }));
  ok(await http().put(`/v1/service-staff/${stylist.id}/services`).set(auth).send({ services: [{ variantId: wrapId, commissionRate: '0.2' }] }), 200);
  ok(await http().put(`/v1/service-staff/${stylist.id}/hours`).set(auth).send({ hours: [{ weekday: 1, startsAt: '09:00', endsAt: '18:00' }] }), 200);
  const timeOff = ok(await http().post(`/v1/service-staff/${stylist.id}/time-off`).set(auth).send({ startsAt: '2031-01-01T00:00:00+08:00', endsAt: '2031-01-02T00:00:00+08:00', reason: 'Fixture' }));
  const bundle = ok<{ variants: { id: string }[] }>(await http().post('/v1/products').set(auth).send({ name: 'Wrap bundle', productType: 'PACKAGE', taxCategoryId: taxId, uomId, variants: [{ sku: uniq('PKG'), price: '30.00' }] }));
  const bundleId = bundle.variants[0]!.id;
  ok(await http().post(`/v1/price-lists/${priceList.id}/prices`).set(auth).send({ items: [{ variantId: bundleId, amount: '30.00' }] }));
  ok(await http().put(`/v1/variants/${bundleId}/package-items`).set(auth).send({ items: [{ serviceVariantId: wrapId, sessions: 2 }] }), 200);
  ok(await http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: openSession.id, clientTransactionId: randomUUID(), customerId: customer.id, lines: [{ variantId: bundleId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '30.00' }] }));
  const customerPackageId = ok<{ data: { id: string }[] }>(await http().get(`/v1/customers/${customer.id}/packages`).set(auth), 200).data[0]!.id;
  const booked = ok(await http().post('/v1/appointments').set(auth).send({ branchId: branch.id, customerId: customer.id, outsideHours: true, services: [{ variantId: wrapId, staffId: stylist.id, startsAt: '2031-01-03T10:00:00+08:00' }] }));
  const session = ok<{ id: string; lines: { id: string }[] }>(await http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: openSession.id, clientTransactionId: randomUUID(), appointmentId: booked.id, customerId: customer.id, lines: [{ variantId: wrapId, quantity: '1', packageId: customerPackageId, staffId: stylist.id }], tenders: [{ method: 'CASH', tendered: '5.00' }], tip: { amount: '5.00' } }));
  ok(await http().post(`/v1/sales/${session.id}/returns`).set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: openSession.id, kind: 'RETURN', reason: 'Fixture redo', lines: [{ saleLineId: session.lines[0]!.id, quantity: '1', disposition: 'RESTOCK' }] }));
  const appointment = ok(await http().post('/v1/appointments').set(auth).send({ branchId: branch.id, guestName: 'Fixture guest', outsideHours: true, services: [{ variantId: wrapId, staffId: stylist.id, startsAt: '2031-01-04T10:00:00+08:00' }] }));
  const note = ok(await http().post(`/v1/customers/${customer.id}/notes`).set(auth).send({ body: 'Fixture note', pinned: true }));
  // Session 28 (ADR-0023): a room type and rooms (one blocked, one cleaned), lodging settings, an in-house
  // stay with its registry, an SC guest, a cash deposit applied, its nights, a dinner charged to the room
  // and a cash payment on the folio.
  const roomType = ok<{ id: string; nightVariantId: string }>(await http().post('/v1/room-types').set(auth).set('Idempotency-Key', randomUUID()).send({ code: 'STD', name: 'Standard', rackRate: '2800.00' }));
  ok(await http().post(`/v1/price-lists/${priceList.id}/prices`).set(auth).send({ items: [{ variantId: roomType.nightVariantId, amount: '2800.00' }] }));
  const room = ok(await http().post('/v1/rooms').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: branch.id, roomTypeId: roomType.id, number: '101' }));
  const room2 = ok(await http().post('/v1/rooms').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: branch.id, roomTypeId: roomType.id, number: '102' }));
  const roomBlock = ok(await http().post('/v1/room-blocks').set(auth).set('Idempotency-Key', randomUUID()).send({ roomId: room2.id, startsOn: '2031-05-01', endsOn: '2031-05-03', reason: 'Fixture repair' }));
  ok(await http().post(`/v1/rooms/${room.id}/status`).set(auth).send({ status: 'INSPECTED' }), 200);
  ok(await http().patch(`/v1/branches/${branch.id}/lodging-settings`).set(auth).send({ nightAuditTime: '00:00', accommodationTaxRate: '0.01' }), 200);
  const yesterday = new Date(Date.parse(today()) - 86_400_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(today()) + 86_400_000).toISOString().slice(0, 10);
  const stay = ok<{ id: string; guests: { id: string }[] }>(await http().post('/v1/stays').set(auth).set('Idempotency-Key', randomUUID())
    .send({ branchId: branch.id, roomId: room.id, arrivalDate: yesterday, departureDate: tomorrow, adults: 2, guests: [{ fullName: `${prefix} Guest`, idNumber: 'P-1' }] }));
  const beneficiary = ok(await http().post(`/v1/stays/${stay.id}/beneficiaries`).set(auth).send({ scheme: 'SC', name: 'Fixture Lola', idNumber: 'OSCA-9' }));
  ok(await http().post(`/v1/stays/${stay.id}/deposits`).set(auth).set('Idempotency-Key', randomUUID()).send({ method: 'CASH', cashierSessionId: openSession.id, amount: '100.00' }));
  ok(await http().post(`/v1/stays/${stay.id}/check-in`).set(auth).send({}), 200);
  ok(await http().post('/v1/lodging/night-audit').set(auth).send({ branchId: branch.id }), 200);
  const stayFolio = ok<{ id: string }>(await http().get(`/v1/stays/${stay.id}/folio`).set(auth), 200);
  ok(await http().post(`/v1/stays/${stay.id}/deposits/apply`).set(auth).set('Idempotency-Key', randomUUID()).send({}), 200);
  ok(await http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: openSession.id, clientTransactionId: randomUUID(), lines: [{ variantId, quantity: '1' }], tenders: [{ method: 'ROOM_CHARGE', stayId: stay.id }] }));
  ok(await http().post(`/v1/folios/${stayFolio.id}/payments`).set(auth).set('Idempotency-Key', randomUUID()).send({ method: 'CASH', cashierSessionId: openSession.id, tendered: '50.00' }));
  const openSessionCash = (await http().get(`/v1/cashier-sessions/${openSession.id}`).set(auth)).body.expectedCash as string;
  // Session 20: a price approved for the item (not used), and a cart held on the open shift.
  const override = ok(await http().post('/v1/price-overrides').set(auth).send({ branchId: branch.id, variantId, unitPrice: '19.00', quantity: '1', reason: 'Fixture' }));
  const held = ok(await http().post('/v1/held-carts').set(auth).send({ cashierSessionId: openSession.id, label: 'Fixture', lines: [{ variantId, sku: 'X', name: 'Cola', quantity: '1' }] }));
  // Phase 6 slice 6: support access and a data export request (the worker does not run here).
  const grant = ok(await http().post('/v1/support-access').set(auth).send({ purpose: 'Fixture support access', hours: 2 }));
  const dataExport = ok(await http().post('/v1/data-exports').set(auth), 202);
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
    saleReturnId: saleReturn.id,
    cashMovementId: payIn.id,
    paymentIntentId: payment.id,
    openSessionCash,
    supplierId: supplier.id,
    purchaseOrderId: po.id,
    draftOrderId: draft.id,
    goodsReceiptId: receipt.id,
    supplierReturnId: supplierReturn.id,
    supplierInvoiceId: supplierInvoice.id,
    supplierPaymentId: paid.payments[0]!.id,
    supplierNoteId: noted.adjustments[0]!.id,
    priceOverrideId: override.id,
    heldCartId: held.id,
    customerId: customer.id,
    customerSaleId: customerSale.id,
    reservationId: reservation.id,
    supplierItemId: supplierItem.id,
    promotionId: promotion.id,
    packVariantId,
    packLinkId: packLink.id,
    packOpeningId: packOpening.id,
    pieceLotId: (ok<{ data: { lotId: string }[] }>(await http().get('/v1/stock/lots').query({ branchId: branch.id, variantId: pieceItem.variants[0]!.id }).set(auth), 200)).data[0]!.lotId,
    apiKeyId: apiKey.id,
    webhookId: webhook.id,
    webhookDeliveryId: webhookPing.id,
    branch2Id: branch2.id,
    transferId: transfer.id,
    countId: count.id,
    sheetId: sheet.id,
    zRegisterId: zRegister.id,
    zReadingId: zReading.id,
    adjustmentId: adjustment.id,
    journalEntryId: entries[0]!.id,
    cashAccountId: accounts.find((x) => x.systemKey === 'CASH_ON_HAND')!.id,
    dishId,
    stationId: station.id,
    areaId: area.id,
    tableId: table.id,
    modifierGroupId: group.id,
    modifierOptionId: group.options[1]!.id,
    menuId: menu.id,
    draftVersionId: draftVersion.id,
    orderId: order.id,
    firedItemId: fired.items[0]!.id,
    pendingItemId: withPending.items[1]!.id,
    ticketId: fired.tickets[0]!.id,
    billId: bill.id,
    checkSaleId: checkSale.id,
    liveOrderId: liveOrder.id,
    liveItemId: liveItems.items[0]!.id,
    terminalHeaders,
    snapshotId: snap.snapshotId,
    offlineTxnId: quarantined.id,
    supportGrantId: grant.id,
    exportId: dataExport.id,
    serviceId: wrapId,
    staffId: stylist.id,
    timeOffId: timeOff.id,
    appointmentId: appointment.id,
    bundleId,
    customerPackageId,
    noteId: note.id,
    roomTypeId: roomType.id,
    roomId: room.id,
    roomBlockId: roomBlock.id,
    stayId: stay.id,
    folioId: stayFolio.id,
    guestId: stay.guests[0]!.id,
    beneficiaryId: beneficiary.id,
  };
}

let a: World;
let b: World;

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  [a, b] = await Promise.all([world('iso-a'), world('iso-b')]);
  // Two full businesses with a row in every tenant table: ~10 s alone, past 60 s late in a full gate run.
}, 180_000);

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
    'GET /v1/sync/transactions/:id': () => http().get(`/v1/sync/transactions/${a.offlineTxnId}`).set(auth),
    // B's till asks for a page of A's snapshot (the tenant comes from B's credential).
    'GET /v1/terminal/snapshot/:id/items': () =>
      http().get(`/v1/terminal/snapshot/${a.snapshotId}/items`).query({ after: Buffer.from(JSON.stringify(['A', a.variantId])).toString('base64url') }).set(b.terminalHeaders),
    'POST /v1/sync/transactions/:id/retry': () => http().post(`/v1/sync/transactions/${a.offlineTxnId}/retry`).set(auth),
    'POST /v1/sync/transactions/:id/dismiss': () => http().post(`/v1/sync/transactions/${a.offlineTxnId}/dismiss`).set(auth).send({ reason: 'sabotage' }),
    'PATCH /v1/categories/:id': () => http().patch(`/v1/categories/${a.categoryId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/categories/:id/archive': () => http().post(`/v1/categories/${a.categoryId}/archive`).set(auth),
    'GET /v1/products/:id': () => http().get(`/v1/products/${a.productId}`).set(auth),
    'PATCH /v1/products/:id': () => http().patch(`/v1/products/${a.productId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/products/:id/archive': () => http().post(`/v1/products/${a.productId}/archive`).set(auth),
    'POST /v1/products/:id/variants': () => http().post(`/v1/products/${a.productId}/variants`).set(auth).send({ sku: uniq('X') }),
    'PATCH /v1/variants/:id': () => http().patch(`/v1/variants/${a.variantId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/variants/:id/archive': () => http().post(`/v1/variants/${a.variantId}/archive`).set(auth),
    'POST /v1/variants/:id/barcodes': () => http().post(`/v1/variants/${a.variantId}/barcodes`).set(auth).send({ code: 'HIJACK1' }),
    'POST /v1/variants/:id/barcodes/generate': () => http().post(`/v1/variants/${a.variantId}/barcodes/generate`).set(auth),
    'GET /v1/promotions/:id': () => http().get(`/v1/promotions/${a.promotionId}`).set(auth),
    'PATCH /v1/promotions/:id': () => http().patch(`/v1/promotions/${a.promotionId}`).set(auth).send({ endsAt: 'now' }),
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
    'GET /v1/sale-returns/:id': () => http().get(`/v1/sale-returns/${a.saleReturnId}`).set(auth),
    'GET /v1/sale-returns/:id/receipt': () => http().get(`/v1/sale-returns/${a.saleReturnId}/receipt`).set(auth),
    'POST /v1/sale-returns/:id/tip-refund': () => http().post(`/v1/sale-returns/${a.saleReturnId}/tip-refund`).set(auth).send({}),
    'POST /v1/members/:id/reset-mfa': () => http().post(`/v1/members/${a.memberId}/reset-mfa`).set(auth).send({ reason: 'cross-tenant probe' }),
    'GET /v1/cash-movements/:id': () => http().get(`/v1/cash-movements/${a.cashMovementId}`).set(auth),
    'POST /v1/sales/:id/returns': () =>
      http().post(`/v1/sales/${a.saleId}/returns`).set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, kind: 'VOID', reason: 'steal' }),
    'POST /v1/sales/:id/returns/preview': () => http().post(`/v1/sales/${a.saleId}/returns/preview`).set(auth).send({ lines: [{ saleLineId: randomUUID(), quantity: '1' }] }),
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
    'GET /v1/supplier-invoices/:id': () => http().get(`/v1/supplier-invoices/${a.supplierInvoiceId}`).set(auth),
    'POST /v1/supplier-invoices/:id/cancel': () => http().post(`/v1/supplier-invoices/${a.supplierInvoiceId}/cancel`).set(auth).set('Idempotency-Key', randomUUID()).send({ reason: 'sabotage' }),
    'POST /v1/supplier-invoices/:id/payments': () =>
      http().post(`/v1/supplier-invoices/${a.supplierInvoiceId}/payments`).set(auth).set('Idempotency-Key', randomUUID()).send({ amount: '1.00', paidOn: today(), method: 'OTHER' }),
    'GET /v1/supplier-payments/:id': () => http().get(`/v1/supplier-payments/${a.supplierPaymentId}`).set(auth),
    'POST /v1/supplier-payments/:id/void': () => http().post(`/v1/supplier-payments/${a.supplierPaymentId}/void`).set(auth).set('Idempotency-Key', randomUUID()).send({ reason: 'sabotage' }),
    'POST /v1/supplier-invoices/:id/notes': () =>
      http().post(`/v1/supplier-invoices/${a.supplierInvoiceId}/notes`).set(auth).set('Idempotency-Key', randomUUID()).send({ kind: 'CREDIT', noteNumber: 'X', noteDate: today(), netAmount: '1.00', vatAmount: '0', reason: 'sabotage' }),
    'GET /v1/supplier-notes/:id': () => http().get(`/v1/supplier-notes/${a.supplierNoteId}`).set(auth),
    'GET /v1/stock/transfers/:id': () => http().get(`/v1/stock/transfers/${a.transferId}`).set(auth),
    'POST /v1/stock/transfers/:id/receive': () => http().post(`/v1/stock/transfers/${a.transferId}/receive`).set(auth).set('Idempotency-Key', randomUUID()).send({}),
    'GET /v1/stock/counts/:id': () => http().get(`/v1/stock/counts/${a.countId}`).set(auth),
    'GET /v1/stock/count-sheets/:id': () => http().get(`/v1/stock/count-sheets/${a.sheetId}`).set(auth),
    'POST /v1/registers/:id/z-readings': () => http().post(`/v1/registers/${a.zRegisterId}/z-readings`).set(auth).send({ day: '2026-01-01' }),
    'GET /v1/registers/:id/z-readings': () => http().get(`/v1/registers/${a.zRegisterId}/z-readings`).set(auth),
    'GET /v1/z-readings/:id': () => http().get(`/v1/z-readings/${a.zReadingId}`).set(auth),
    'PUT /v1/stock/count-sheets/:id/lines': () => http().put(`/v1/stock/count-sheets/${a.sheetId}/lines`).set(auth).send({ lines: [{ variantId: b.variantId, countedQuantity: '1' }] }),
    'POST /v1/stock/count-sheets/:id/post': () => http().post(`/v1/stock/count-sheets/${a.sheetId}/post`).set(auth).set('Idempotency-Key', randomUUID()),
    'POST /v1/stock/count-sheets/:id/cancel': () => http().post(`/v1/stock/count-sheets/${a.sheetId}/cancel`).set(auth).send({ reason: 'sabotage' }),
    'GET /v1/branches/:id/inventory-settings': () => http().get(`/v1/branches/${a.branchId}/inventory-settings`).set(auth),
    'PUT /v1/branches/:id/inventory-settings': () => http().put(`/v1/branches/${a.branchId}/inventory-settings`).set(auth).send({ negativeStockPolicy: 'BLOCK', lowStockAlerts: false }),
    'GET /v1/stock/adjustments/:id': () => http().get(`/v1/stock/adjustments/${a.adjustmentId}`).set(auth),
    'GET /v1/journal-entries/:id': () => http().get(`/v1/journal-entries/${a.journalEntryId}`).set(auth),
    'POST /v1/journal-entries/:id/reverse': () => http().post(`/v1/journal-entries/${a.journalEntryId}/reverse`).set(auth).set('Idempotency-Key', randomUUID()).send({ memo: 'sabotage' }),
    'GET /v1/variants/:id/recipe': () => http().get(`/v1/variants/${a.dishId}/recipe`).set(auth),
    'POST /v1/variants/:id/recipe': () => http().post(`/v1/variants/${a.dishId}/recipe`).set(auth).send({ ingredients: [{ variantId: b.variantId, quantity: '1' }] }),
    'PATCH /v1/kitchen-stations/:id': () => http().patch(`/v1/kitchen-stations/${a.stationId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/kitchen-stations/:id/archive': () => http().post(`/v1/kitchen-stations/${a.stationId}/archive`).set(auth),
    'PATCH /v1/dining-areas/:id': () => http().patch(`/v1/dining-areas/${a.areaId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/dining-areas/:id/archive': () => http().post(`/v1/dining-areas/${a.areaId}/archive`).set(auth),
    'PATCH /v1/restaurant-tables/:id': () => http().patch(`/v1/restaurant-tables/${a.tableId}`).set(auth).send({ seats: 99 }),
    'POST /v1/restaurant-tables/:id/archive': () => http().post(`/v1/restaurant-tables/${a.tableId}/archive`).set(auth),
    'GET /v1/branches/:id/restaurant-settings': () => http().get(`/v1/branches/${a.branchId}/restaurant-settings`).set(auth),
    'PUT /v1/branches/:id/restaurant-settings': () =>
      http().put(`/v1/branches/${a.branchId}/restaurant-settings`).set(auth).send({ dineInMenuId: null, takeawayMenuId: null, serviceChargeRate: '0', serviceChargeDineIn: false, serviceChargeTakeaway: false, serviceChargeVatTreatment: 'VATABLE' }),
    'GET /v1/branches/:id/sold-out': () => http().get(`/v1/branches/${a.branchId}/sold-out`).set(auth),
    'PUT /v1/branches/:id/sold-out': () => http().put(`/v1/branches/${a.branchId}/sold-out`).set(auth).send({ variantId: b.variantId, soldOut: true }),
    'GET /v1/branches/:id/menu': () => http().get(`/v1/branches/${a.branchId}/menu`).set(auth),
    'PATCH /v1/modifier-groups/:id': () => http().patch(`/v1/modifier-groups/${a.modifierGroupId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/modifier-groups/:id/options': () => http().post(`/v1/modifier-groups/${a.modifierGroupId}/options`).set(auth).send({ name: 'pwned' }),
    'POST /v1/modifier-groups/:id/archive': () => http().post(`/v1/modifier-groups/${a.modifierGroupId}/archive`).set(auth),
    'POST /v1/modifier-options/:id/archive': () => http().post(`/v1/modifier-options/${a.modifierOptionId}/archive`).set(auth),
    'GET /v1/menus/:id': () => http().get(`/v1/menus/${a.menuId}`).set(auth),
    'PATCH /v1/menus/:id': () => http().patch(`/v1/menus/${a.menuId}`).set(auth).send({ name: 'pwned' }),
    'POST /v1/menus/:id/archive': () => http().post(`/v1/menus/${a.menuId}/archive`).set(auth),
    'POST /v1/menus/:id/drafts': () => http().post(`/v1/menus/${a.menuId}/drafts`).set(auth),
    'GET /v1/menu-versions/:id': () => http().get(`/v1/menu-versions/${a.draftVersionId}`).set(auth),
    'PUT /v1/menu-versions/:id/content': () => http().put(`/v1/menu-versions/${a.draftVersionId}/content`).set(auth).send({ sections: [] }),
    'POST /v1/menu-versions/:id/publish': () => http().post(`/v1/menu-versions/${a.draftVersionId}/publish`).set(auth),
    'GET /v1/restaurant/orders/:id': () => http().get(`/v1/restaurant/orders/${a.orderId}`).set(auth),
    'POST /v1/restaurant/orders/:id/items': () =>
      http().post(`/v1/restaurant/orders/${a.orderId}/items`).set(auth).set('Idempotency-Key', randomUUID()).send({ items: [{ variantId: b.dishId, quantity: '1' }] }),
    'POST /v1/restaurant/orders/:id/fire': () => http().post(`/v1/restaurant/orders/${a.orderId}/fire`).set(auth).send({}),
    'PUT /v1/restaurant/orders/:id/course-notes': () => http().put(`/v1/restaurant/orders/${a.liveOrderId}/course-notes`).set(auth).send({ course: 1, note: 'pwned' }),
    'POST /v1/restaurant/orders/:id/transfer': () => http().post(`/v1/restaurant/orders/${a.orderId}/transfer`).set(auth).send({ tableId: b.tableId }),
    'POST /v1/restaurant/orders/:id/merge': () => http().post(`/v1/restaurant/orders/${a.orderId}/merge`).set(auth).send({ intoOrderId: b.orderId }),
    'POST /v1/restaurant/orders/:id/move-items': () => http().post(`/v1/restaurant/orders/${a.orderId}/move-items`).set(auth).send({ itemIds: [a.firedItemId], toOrderId: b.orderId }),
    'POST /v1/restaurant/orders/:id/cancel': () => http().post(`/v1/restaurant/orders/${a.orderId}/cancel`).set(auth).send({ reason: 'sabotage' }),
    'PATCH /v1/order-items/:id': () => http().patch(`/v1/order-items/${a.pendingItemId}`).set(auth).send({ quantity: '9' }),
    'POST /v1/order-items/:id/remove': () => http().post(`/v1/order-items/${a.pendingItemId}/remove`).set(auth),
    'POST /v1/order-items/:id/void': () => http().post(`/v1/order-items/${a.firedItemId}/void`).set(auth).set('Idempotency-Key', randomUUID()).send({ reason: 'sabotage', wasted: true }),
    'POST /v1/order-items/:id/status': () => http().post(`/v1/order-items/${a.firedItemId}/status`).set(auth).send({ status: 'SERVED' }),
    'POST /v1/kitchen/tickets/:id/bump': () => http().post(`/v1/kitchen/tickets/${a.ticketId}/bump`).set(auth),
    'POST /v1/kitchen/tickets/:id/unbump': () => http().post(`/v1/kitchen/tickets/${a.ticketId}/unbump`).set(auth),
    'POST /v1/kitchen/tickets/:id/reprint': () => http().post(`/v1/kitchen/tickets/${a.ticketId}/reprint`).set(auth),
    // B's till marks A's ticket printed or gives it back (the tenant comes from B's credential).
    'POST /v1/terminal/kitchen-tickets/:id/printed': () => http().post(`/v1/terminal/kitchen-tickets/${a.ticketId}/printed`).set(b.terminalHeaders),
    'POST /v1/terminal/kitchen-tickets/:id/release': () => http().post(`/v1/terminal/kitchen-tickets/${a.ticketId}/release`).set(b.terminalHeaders),
    'POST /v1/restaurant/orders/:id/bill': () => http().post(`/v1/restaurant/orders/${a.orderId}/bill`).set(auth).set('Idempotency-Key', randomUUID()).send({}),
    'GET /v1/restaurant/bills/:id': () => http().get(`/v1/restaurant/bills/${a.billId}`).set(auth),
    'POST /v1/restaurant/bills/:id/void': () => http().post(`/v1/restaurant/bills/${a.billId}/void`).set(auth).send({ reason: 'sabotage' }),
    'POST /v1/restaurant/bills/:id/checks': () =>
      http().post(`/v1/restaurant/bills/${a.billId}/checks`).set(auth).set('Idempotency-Key', randomUUID())
        .send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '1000.00' }] }),
    'POST /v1/restaurant/bills/:id/checks/preview': () => http().post(`/v1/restaurant/bills/${a.billId}/checks/preview`).set(auth).send({}),
    'POST /v1/support-access/:id/revoke': () => http().post(`/v1/support-access/${a.supportGrantId}/revoke`).set(auth).send({ reason: 'sabotage' }),
    // B's owner is not Tilvara staff: A's grant is as good as absent.
    'POST /v1/support/grants/:id/open': () => http().post(`/v1/support/grants/${a.supportGrantId}/open`).set(auth),
    'GET /v1/customers/:id': () => http().get(`/v1/customers/${a.customerId}`).set(auth),
    'PATCH /v1/customers/:id': () => http().patch(`/v1/customers/${a.customerId}`).set(auth).send({ displayName: 'pwned' }),
    'POST /v1/customers/:id/consent': () => http().post(`/v1/customers/${a.customerId}/consent`).set(auth).send({ marketingConsent: false, source: 'REQUEST' }),
    'POST /v1/customers/:id/archive': () => http().post(`/v1/customers/${a.customerId}/archive`).set(auth),
    'POST /v1/customers/:id/anonymise': () => http().post(`/v1/customers/${a.customerId}/anonymise`).set(auth).send({ reason: 'sabotage' }),
    'GET /v1/customers/:id/sales': () => http().get(`/v1/customers/${a.customerId}/sales`).set(auth),
    'GET /v1/customers/:id/store-credit': () => http().get(`/v1/customers/${a.customerId}/store-credit`).set(auth),
    'POST /v1/customers/:id/export': () => http().post(`/v1/customers/${a.customerId}/export`).set(auth),
    // Session 27 (ADR-0022): salons.
    'GET /v1/service-staff/:id': () => http().get(`/v1/service-staff/${a.staffId}`).set(auth),
    'PATCH /v1/service-staff/:id': () => http().patch(`/v1/service-staff/${a.staffId}`).set(auth).send({ commissionRate: '1' }),
    'PUT /v1/service-staff/:id/services': () => http().put(`/v1/service-staff/${a.staffId}/services`).set(auth).send({ services: [] }),
    'PUT /v1/service-staff/:id/hours': () => http().put(`/v1/service-staff/${a.staffId}/hours`).set(auth).send({ hours: [] }),
    'POST /v1/service-staff/:id/time-off': () => http().post(`/v1/service-staff/${a.staffId}/time-off`).set(auth).send({ startsAt: '2031-02-01T00:00:00+08:00', endsAt: '2031-02-02T00:00:00+08:00' }),
    'DELETE /v1/service-staff/:id/time-off/:timeOffId': () => http().delete(`/v1/service-staff/${a.staffId}/time-off/${a.timeOffId}`).set(auth),
    'GET /v1/appointments/:id': () => http().get(`/v1/appointments/${a.appointmentId}`).set(auth),
    'PATCH /v1/appointments/:id': () => http().patch(`/v1/appointments/${a.appointmentId}`).set(auth).send({ notes: 'pwned' }),
    'POST /v1/appointments/:id/status': () => http().post(`/v1/appointments/${a.appointmentId}/status`).set(auth).send({ status: 'CANCELLED', reason: 'sabotage' }),
    'GET /v1/variants/:id/package-items': () => http().get(`/v1/variants/${a.bundleId}/package-items`).set(auth),
    'PUT /v1/variants/:id/package-items': () => http().put(`/v1/variants/${a.bundleId}/package-items`).set(auth).send({ items: [{ serviceVariantId: b.variantId, sessions: 1 }] }),
    'GET /v1/customers/:id/packages': () => http().get(`/v1/customers/${a.customerId}/packages`).set(auth),
    'GET /v1/customers/:id/visits': () => http().get(`/v1/customers/${a.customerId}/visits`).set(auth),
    'GET /v1/customers/:id/notes': () => http().get(`/v1/customers/${a.customerId}/notes`).set(auth),
    'POST /v1/customers/:id/notes': () => http().post(`/v1/customers/${a.customerId}/notes`).set(auth).send({ body: 'pwned' }),
    'PATCH /v1/customers/:id/notes/:noteId': () => http().patch(`/v1/customers/${a.customerId}/notes/${a.noteId}`).set(auth).send({ body: 'pwned' }),
    'DELETE /v1/customers/:id/notes/:noteId': () => http().delete(`/v1/customers/${a.customerId}/notes/${a.noteId}`).set(auth),
    // Session 28 (ADR-0023): lodging.
    'GET /v1/room-types/:id': () => http().get(`/v1/room-types/${a.roomTypeId}`).set(auth),
    'PATCH /v1/room-types/:id': () => http().patch(`/v1/room-types/${a.roomTypeId}`).set(auth).send({ name: 'pwned' }),
    'GET /v1/rooms/:id': () => http().get(`/v1/rooms/${a.roomId}`).set(auth),
    'PATCH /v1/rooms/:id': () => http().patch(`/v1/rooms/${a.roomId}`).set(auth).send({ notes: 'pwned' }),
    'POST /v1/rooms/:id/status': () => http().post(`/v1/rooms/${a.roomId}/status`).set(auth).send({ status: 'DIRTY' }),
    'GET /v1/rooms/:id/status-changes': () => http().get(`/v1/rooms/${a.roomId}/status-changes`).set(auth),
    'DELETE /v1/room-blocks/:id': () => http().delete(`/v1/room-blocks/${a.roomBlockId}`).set(auth),
    'GET /v1/branches/:id/lodging-settings': () => http().get(`/v1/branches/${a.branchId}/lodging-settings`).set(auth),
    'PATCH /v1/branches/:id/lodging-settings': () => http().patch(`/v1/branches/${a.branchId}/lodging-settings`).set(auth).send({ forfeitOnCancel: false }),
    'GET /v1/stays/:id': () => http().get(`/v1/stays/${a.stayId}`).set(auth),
    'PATCH /v1/stays/:id': () => http().patch(`/v1/stays/${a.stayId}`).set(auth).send({ notes: 'pwned' }),
    'POST /v1/stays/:id/cancel': () => http().post(`/v1/stays/${a.stayId}/cancel`).set(auth).send({ reason: 'sabotage' }),
    'POST /v1/stays/:id/no-show': () => http().post(`/v1/stays/${a.stayId}/no-show`).set(auth).send({ reason: 'sabotage' }),
    'POST /v1/stays/:id/check-in': () => http().post(`/v1/stays/${a.stayId}/check-in`).set(auth).send({}),
    'POST /v1/stays/:id/prepare-check-out': () => http().post(`/v1/stays/${a.stayId}/prepare-check-out`).set(auth).send({}),
    'POST /v1/stays/:id/check-out': () => http().post(`/v1/stays/${a.stayId}/check-out`).set(auth).send({}),
    'GET /v1/stays/:id/guests': () => http().get(`/v1/stays/${a.stayId}/guests`).set(auth),
    'POST /v1/stays/:id/guests': () => http().post(`/v1/stays/${a.stayId}/guests`).set(auth).send({ fullName: 'pwned' }),
    'PATCH /v1/stays/:id/guests/:guestId': () => http().patch(`/v1/stays/${a.stayId}/guests/${a.guestId}`).set(auth).send({ fullName: 'pwned' }),
    'DELETE /v1/stays/:id/guests/:guestId': () => http().delete(`/v1/stays/${a.stayId}/guests/${a.guestId}`).set(auth),
    'GET /v1/stays/:id/registration-card': () => http().get(`/v1/stays/${a.stayId}/registration-card`).set(auth),
    'POST /v1/stays/:id/beneficiaries': () => http().post(`/v1/stays/${a.stayId}/beneficiaries`).set(auth).send({ scheme: 'SC', name: 'x', idNumber: 'x' }),
    'DELETE /v1/stays/:id/beneficiaries/:beneficiaryId': () => http().delete(`/v1/stays/${a.stayId}/beneficiaries/${a.beneficiaryId}`).set(auth),
    'GET /v1/stays/:id/deposits': () => http().get(`/v1/stays/${a.stayId}/deposits`).set(auth),
    'POST /v1/stays/:id/deposits': () => http().post(`/v1/stays/${a.stayId}/deposits`).set(auth).set('Idempotency-Key', randomUUID()).send({ method: 'BANK_TRANSFER', amount: '1.00', reference: 'x' }),
    'POST /v1/stays/:id/deposits/apply': () => http().post(`/v1/stays/${a.stayId}/deposits/apply`).set(auth).set('Idempotency-Key', randomUUID()).send({}),
    'POST /v1/stays/:id/deposits/refund': () => http().post(`/v1/stays/${a.stayId}/deposits/refund`).set(auth).set('Idempotency-Key', randomUUID()).send({ reason: 'x', refund: { method: 'BANK_TRANSFER', reference: 'x' } }),
    'POST /v1/stays/:id/deposits/forfeit': () => http().post(`/v1/stays/${a.stayId}/deposits/forfeit`).set(auth).set('Idempotency-Key', randomUUID()).send({ reason: 'x' }),
    'GET /v1/stays/:id/folio': () => http().get(`/v1/stays/${a.stayId}/folio`).set(auth),
    'GET /v1/folios/:id': () => http().get(`/v1/folios/${a.folioId}`).set(auth),
    'GET /v1/folios/:id/statement': () => http().get(`/v1/folios/${a.folioId}/statement`).set(auth),
    'POST /v1/folios/:id/payments': () => http().post(`/v1/folios/${a.folioId}/payments`).set(auth).set('Idempotency-Key', randomUUID()).send({ method: 'CASH', cashierSessionId: b.openSessionId, tendered: '1.00' }),
    'POST /v1/folios/:id/adjustments': () => http().post(`/v1/folios/${a.folioId}/adjustments`).set(auth).set('Idempotency-Key', randomUUID()).send({ amount: '-1.00', reason: 'x' }),
    'POST /v1/folios/:id/night-reversals': () => http().post(`/v1/folios/${a.folioId}/night-reversals`).set(auth).set('Idempotency-Key', randomUUID()).send({ entryId: randomUUID(), reason: 'x' }),
    'POST /v1/api-keys/:id/revoke': () => http().post(`/v1/api-keys/${a.apiKeyId}/revoke`).set(auth),
    'PATCH /v1/webhooks/:id': () => http().patch(`/v1/webhooks/${a.webhookId}`).set(auth).send({ enabled: false }),
    'POST /v1/webhooks/:id/rotate-secret': () => http().post(`/v1/webhooks/${a.webhookId}/rotate-secret`).set(auth),
    'POST /v1/webhooks/:id/ping': () => http().post(`/v1/webhooks/${a.webhookId}/ping`).set(auth),
    'GET /v1/webhooks/:id/deliveries': () => http().get(`/v1/webhooks/${a.webhookId}/deliveries`).set(auth),
    'POST /v1/webhook-deliveries/:id/retry': () => http().post(`/v1/webhook-deliveries/${a.webhookDeliveryId}/retry`).set(auth),
    'POST /v1/stock/reservations/:id/release': () => http().post(`/v1/stock/reservations/${a.reservationId}/release`).set(auth).send({ reason: 'sabotage' }),
    'GET /v1/suppliers/:id/items': () => http().get(`/v1/suppliers/${a.supplierId}/items`).set(auth),
    'POST /v1/suppliers/:id/items': () => http().post(`/v1/suppliers/${a.supplierId}/items`).set(auth).send({ variantId: b.variantId }),
    'PATCH /v1/supplier-items/:id': () => http().patch(`/v1/supplier-items/${a.supplierItemId}`).set(auth).send({ unitCost: '0.01' }),
    'POST /v1/supplier-items/:id/archive': () => http().post(`/v1/supplier-items/${a.supplierItemId}/archive`).set(auth),
    'GET /v1/variants/:id/suppliers': () => http().get(`/v1/variants/${a.variantId}/suppliers`).set(auth),
    'PATCH /v1/pack-conversions/:id': () => http().patch(`/v1/pack-conversions/${a.packLinkId}`).set(auth).send({ autoOpen: false }),
    'POST /v1/pack-conversions/:id/archive': () => http().post(`/v1/pack-conversions/${a.packLinkId}/archive`).set(auth),
    'GET /v1/stock/pack-openings/:id': () => http().get(`/v1/stock/pack-openings/${a.packOpeningId}`).set(auth),
    'POST /v1/held-carts/:id/resume': () => http().post(`/v1/held-carts/${a.heldCartId}/resume`).set(auth).send({ cashierSessionId: b.openSessionId }),
    'POST /v1/held-carts/:id/discard': () => http().post(`/v1/held-carts/${a.heldCartId}/discard`).set(auth),
    'GET /v1/data-exports/:id': () => http().get(`/v1/data-exports/${a.exportId}`).set(auth),
    'POST /v1/data-exports/:id/link': () => http().post(`/v1/data-exports/${a.exportId}/link`).set(auth),
    // A genuine link naming A's export but B's business opens nothing.
    'GET /v1/data-export-files/:token': () =>
      http().get(`/v1/data-export-files/${new ExportLinks(process.env.JWT_ACCESS_SECRET!).sign({ e: a.exportId, t: b.t.tenantId, u: b.t.userId, x: Math.floor(Date.now() / 1000) + 600 })}`),
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
    ['held carts of the A register', () => http().get('/v1/held-carts').query({ registerId: a.registerId }).set(auth)],
    ['hold a cart on the A shift', () => http().post('/v1/held-carts').set(auth).send({ cashierSessionId: a.openSessionId, label: 'x', lines: [{ variantId: b.variantId, sku: 'X', name: 'x', quantity: '1' }] })],
    ['approve a price at the A branch', () => http().post('/v1/price-overrides').set(auth).send({ branchId: a.branchId, variantId: b.variantId, unitPrice: '1.00', quantity: '1', reason: 'x' })],
    ['approve a price for an A item', () => http().post('/v1/price-overrides').set(auth).send({ branchId: b.branchId, variantId: a.variantId, unitPrice: '1.00', quantity: '1', reason: 'x' })],
    ['quote with an A approval', () => http().post('/v1/tax/quote').set(auth).send({ branchId: b.branchId, lines: [{ variantId: b.variantId, quantity: '1', priceOverrideId: a.priceOverrideId }] })],
    ['exchange an A sale on the B shift', () => http().post('/v1/exchanges').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, saleId: a.saleId, reason: 'x', returnLines: [{ saleLineId: randomUUID(), quantity: '1', disposition: 'RESTOCK' }], sale: { clientTransactionId: randomUUID(), lines: [{ variantId: b.variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }] } })],
    ['exchange a B sale on the A shift', () => http().post('/v1/exchanges').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: a.openSessionId, saleId: b.saleId, reason: 'x', returnLines: [{ saleLineId: randomUUID(), quantity: '1', disposition: 'RESTOCK' }], sale: { clientTransactionId: randomUUID(), lines: [{ variantId: b.variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }] } })],
    ['reserve at the A branch', () => http().post('/v1/stock/reservations').set(auth).send({ branchId: a.branchId, variantId: b.variantId, quantity: '1', note: 'x' })],
    ['reserve an A item at the B branch', () => http().post('/v1/stock/reservations').set(auth).send({ branchId: b.branchId, variantId: a.variantId, quantity: '1', note: 'x' })],
    ['reserve for an A customer', () => http().post('/v1/stock/reservations').set(auth).send({ branchId: b.branchId, variantId: b.variantId, quantity: '1', note: 'x', customerId: a.customerId })],
    ['reservations of the A branch', () => http().get('/v1/stock/reservations').query({ branchId: a.branchId }).set(auth)],
    ['link an A pack to a B piece', () => http().post('/v1/pack-conversions').set(auth).send({ packVariantId: a.packVariantId, pieceVariantId: b.variantId, piecesPerPack: '10' })],
    ['link a B pack to an A piece', () => http().post('/v1/pack-conversions').set(auth).send({ packVariantId: b.packVariantId, pieceVariantId: a.variantId, piecesPerPack: '10' })],
    ['open an A pack link at the B branch', () => http().post('/v1/stock/pack-openings').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b.branchId, conversionId: a.packLinkId, packs: '1', reason: 'x' })],
    ['open B packs at the A branch', () => http().post('/v1/stock/pack-openings').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: a.branchId, conversionId: b.packLinkId, packs: '1', reason: 'x' })],
    ['write off an A lot at the B branch', () => http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b.branchId, kind: 'WASTE', reason: 'x', items: [{ variantId: b.variantId, quantity: '-1', lotId: a.pieceLotId }] })],
    ['expiring at the A branch', () => http().get('/v1/stock/expiring').query({ branchId: a.branchId, withinDays: 365 }).set(auth)],
    ['lots of an A item at the B branch', () => http().get('/v1/stock/lots').query({ branchId: b.branchId, variantId: a.variantId }).set(auth)],
    ['pack openings of the A branch', () => http().get('/v1/stock/pack-openings').query({ branchId: a.branchId }).set(auth)],
    ['promote an A item', () => http().post('/v1/promotions').set(auth).send({ name: 'x', kind: 'MULTI_BUY', quantity: 2, price: '1.00', variantIds: [a.variantId] })],
    ['promote at the A branch', () => http().post('/v1/promotions').set(auth).send({ name: 'x', kind: 'MULTI_BUY', quantity: 2, price: '1.00', variantIds: [b.variantId], branchIds: [a.branchId] })],
    ['shelve an A item at the B branch', () => http().put('/v1/stock/locations').set(auth).send({ branchId: b.branchId, items: [{ variantId: a.variantId, location: 'X' }] })],
    ['shelve at the A branch', () => http().put('/v1/stock/locations').set(auth).send({ branchId: a.branchId, items: [{ variantId: b.variantId, location: 'X' }] })],
    ['shelf locations of the A branch', () => http().get('/v1/stock/locations').query({ branchId: a.branchId }).set(auth)],
    ['quick keys of the A branch', () => http().get('/v1/catalog/quick-keys').query({ branchId: a.branchId }).set(auth)],
    ['catalog an A item for a B supplier', () => http().post(`/v1/suppliers/${b.supplierId}/items`).set(auth).send({ variantId: a.variantId })],
    ['sell to an A customer', () => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), customerId: a.customerId, lines: [{ variantId: b.variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }] })],
    ['spend an A customer’s credit', () => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), customerId: a.customerId, lines: [{ variantId: b.variantId, quantity: '1' }], tenders: [{ method: 'STORE_CREDIT', amount: '1.00' }, { method: 'CASH', tendered: '100.00' }] })],
    ['refund a B sale as credit to an A customer', () => http().post(`/v1/sales/${b.saleId}/returns`).set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, kind: 'RETURN', reason: 'x', refundTo: 'STORE_CREDIT', customerId: a.customerId, lines: [{ saleLineId: randomUUID(), quantity: '1', disposition: 'DAMAGED' }] })],
    ['staff at the A branch', () => http().post('/v1/service-staff').set(auth).send({ branchId: a.branchId, displayName: 'x' })],
    ['staff of the A branch', () => http().get('/v1/service-staff').query({ branchId: a.branchId }).set(auth)],
    ['give a B stylist an A service', () => http().put(`/v1/service-staff/${b.staffId}/services`).set(auth).send({ services: [{ variantId: a.variantId }] })],
    ['book at the A branch', () => http().post('/v1/appointments').set(auth).send({ branchId: a.branchId, guestName: 'x', services: [{ variantId: b.serviceId, staffId: b.staffId, startsAt: '2031-03-01T10:00:00+08:00' }] })],
    ['book an A stylist', () => http().post('/v1/appointments').set(auth).send({ branchId: b.branchId, guestName: 'x', outsideHours: true, services: [{ variantId: b.serviceId, staffId: a.staffId, startsAt: '2031-03-01T10:00:00+08:00' }] })],
    ['book an A customer', () => http().post('/v1/appointments').set(auth).send({ branchId: b.branchId, customerId: a.customerId, outsideHours: true, services: [{ variantId: b.serviceId, staffId: b.staffId, startsAt: '2031-03-01T10:00:00+08:00' }] })],
    ['calendar of the A branch', () => http().get('/v1/appointments').query({ branchId: a.branchId, from: '2031-01-01T00:00:00Z', to: '2031-01-10T00:00:00Z' }).set(auth)],
    ['free times at the A branch', () => http().get('/v1/appointments/availability').query({ branchId: a.branchId, variantId: b.serviceId, date: '2031-01-06' }).set(auth)],
    ['put an A service in a B package', () => http().put(`/v1/variants/${b.bundleId}/package-items`).set(auth).send({ items: [{ serviceVariantId: a.variantId, sessions: 1 }] })],
    ['use an A package on a B sale', () => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), customerId: b.customerId, lines: [{ variantId: b.serviceId, quantity: '1', packageId: a.customerPackageId }], tenders: [{ method: 'CASH', tendered: '100.00' }] })],
    ['name an A stylist on a B sale', () => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), lines: [{ variantId: b.variantId, quantity: '1', staffId: a.staffId }], tenders: [{ method: 'CASH', tendered: '100.00' }] })],
    ['tip an A stylist', () => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), lines: [{ variantId: b.variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }], tip: { amount: '1.00', shares: [{ staffId: a.staffId, amount: '1.00' }] } })],
    ['book an A room', () => http().post('/v1/stays').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b.branchId, roomId: a.roomId, arrivalDate: '2031-06-01', departureDate: '2031-06-02', guestName: 'x' })],
    ['a B room of an A type', () => http().post('/v1/rooms').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b.branchId, roomTypeId: a.roomTypeId, number: '999' })],
    ['a room at the A branch', () => http().post('/v1/rooms').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: a.branchId, roomTypeId: b.roomTypeId, number: '999' })],
    ['block an A room', () => http().post('/v1/room-blocks').set(auth).set('Idempotency-Key', randomUUID()).send({ roomId: a.roomId, startsOn: '2031-06-01', endsOn: '2031-06-02', reason: 'x' })],
    ['charge a B sale to an A stay', () => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), lines: [{ variantId: b.variantId, quantity: '1' }], tenders: [{ method: 'ROOM_CHARGE', stayId: a.stayId }] })],
    ['pay a B folio at the A drawer', () => http().post(`/v1/folios/${b.folioId}/payments`).set(auth).set('Idempotency-Key', randomUUID()).send({ method: 'CASH', cashierSessionId: a.openSessionId, tendered: '1.00' })],
    ['reverse an A night on a B folio', () => http().post(`/v1/folios/${b.folioId}/night-reversals`).set(b.auth).set('Idempotency-Key', randomUUID()).send({ entryId: a.folioId, reason: 'x' })],
    ['in-house guests at the A branch', () => http().get('/v1/stays/in-house').query({ branchId: a.branchId }).set(auth)],
    ['availability at the A branch', () => http().get('/v1/lodging/availability').query({ branchId: a.branchId, from: '2031-01-01', to: '2031-01-03' }).set(auth)],
    ['housekeeping of the A branch', () => http().get('/v1/lodging/housekeeping').query({ branchId: a.branchId }).set(auth)],
    ['night audit at the A branch', () => http().post('/v1/lodging/night-audit').set(auth).send({ branchId: a.branchId })],
    ['guest ledger of the A entity', () => http().get('/v1/reports/guest-ledger').query({ legalEntityId: a.entityId }).set(auth)],
    ...(['occupancy', 'accommodation-tax'] as const).map(
      (r) => [`report ${r} on A branch`, () => http().get(`/v1/reports/${r}`).query({ branchId: a.branchId, from: '2026-01-01', to: '2026-12-31' }).set(auth)] as [string, () => request.Test],
    ),
    ['ring up an A appointment', () => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), appointmentId: a.appointmentId, lines: [{ variantId: b.variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }] })],
    ...(['commissions', 'service-packages', 'tips-by-staff'] as const).map(
      (r) => [`report ${r} on A branch`, () => http().get(`/v1/reports/${r}`).query({ branchId: a.branchId, from: '2026-01-01', to: '2026-12-31' }).set(auth)] as [string, () => request.Test],
    ),
    ['refund a B sale from the A drawer', () => http().post(`/v1/sales/${b.saleId}/returns`).set(auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: a.openSessionId, kind: 'VOID', reason: 'x' })],
    ...(['sales-summary', 'by-product', 'by-attribute', 'promotions', 'by-cashier', 'refund-watch', 'by-tender', 'tax-summary', 'statutory-book', ...RESTAURANT_REPORTS] as const).map(
      (r) => [`report ${r} on A branch`, () => http().get(`/v1/reports/${r}`).query({ branchId: a.branchId, from: '2026-01-01', to: '2026-12-31' }).set(auth)] as [string, () => request.Test],
    ),
    ...(['by-category', 'discounts', 'purchases-by-supplier'] as const).map(
      (r) => [`report ${r} on A branch`, () => http().get(`/v1/reports/${r}`).query({ branchId: a.branchId, from: '2026-01-01', to: '2026-12-31' }).set(auth)] as [string, () => request.Test],
    ),
    ['payment exceptions of the A branch', () => http().get('/v1/reports/payment-exceptions').query({ branchId: a.branchId }).set(auth)],
    ['consolidated report of the A entity', () => http().get('/v1/reports/by-branch').query({ legalEntityId: a.entityId, from: '2026-01-01', to: '2026-12-31' }).set(auth)],
    ['open orders of the A branch', () => http().get('/v1/reports/open-orders').query({ branchId: a.branchId, day: today() }).set(auth)],
    ['adjust stock at A branch', () => http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: a.branchId, reason: 'x', items: [{ variantId: b.variantId, quantity: '1' }] })],
    ['adjust A variant at B branch', () => http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b.branchId, reason: 'x', items: [{ variantId: a.variantId, quantity: '1' }] })],
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
    ['invoice the A receipt', () => http().post('/v1/supplier-invoices').set(auth).set('Idempotency-Key', randomUUID()).send({ supplierId: b.supplierId, invoiceNumber: 'S-1', invoiceDate: today(), goodsReceiptIds: [a.goodsReceiptId], netAmount: '1.00', vatAmount: '0' })],
    ['pay the A invoice in a B payment', () => http().post('/v1/supplier-payments').set(auth).set('Idempotency-Key', randomUUID()).send({ supplierId: b.supplierId, paidOn: today(), method: 'OTHER', allocations: [{ supplierInvoiceId: a.supplierInvoiceId, amount: '1.00' }] })],
    ['invoice a B receipt as the A supplier', () => http().post('/v1/supplier-invoices').set(auth).set('Idempotency-Key', randomUUID()).send({ supplierId: a.supplierId, invoiceNumber: 'S-2', invoiceDate: today(), goodsReceiptIds: [b.goodsReceiptId], netAmount: '1.00', vatAmount: '0' })],
    ['uninvoiced receipts at the A branch', () => http().get('/v1/uninvoiced-receipts').query({ branchId: a.branchId, supplierId: b.supplierId }).set(auth)],
    ['uninvoiced receipts of the A supplier', () => http().get('/v1/uninvoiced-receipts').query({ branchId: b.branchId, supplierId: a.supplierId }).set(auth)],
    ['supplier invoices of the A entity', () => http().get('/v1/supplier-invoices').query({ legalEntityId: a.entityId }).set(auth)],
    ['supplier invoices of the A supplier', () => http().get('/v1/supplier-invoices').query({ legalEntityId: b.entityId, supplierId: a.supplierId }).set(auth)],
    ['payables aging of the A entity', () => http().get('/v1/reports/payables-aging').query({ legalEntityId: a.entityId }).set(auth)],
    ['transfer from the A branch', () => http().post('/v1/stock/transfers').set(auth).set('Idempotency-Key', randomUUID()).send({ fromBranchId: a.branchId, toBranchId: b.branchId, lines: [{ variantId: b.variantId, quantity: '1' }] })],
    ['transfer to the A branch', () => http().post('/v1/stock/transfers').set(auth).set('Idempotency-Key', randomUUID()).send({ fromBranchId: b.branchId, toBranchId: a.branchId, lines: [{ variantId: b.variantId, quantity: '1' }] })],
    ['transfer an A variant', () => http().post('/v1/stock/transfers').set(auth).set('Idempotency-Key', randomUUID()).send({ fromBranchId: b.branchId, toBranchId: b.branch2Id, lines: [{ variantId: a.variantId, quantity: '1' }] })],
    ['count at the A branch', () => http().post('/v1/stock/counts').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: a.branchId, lines: [{ variantId: b.variantId, countedQuantity: '0' }] })],
    ['count an A variant', () => http().post('/v1/stock/counts').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b.branchId, lines: [{ variantId: a.variantId, countedQuantity: '0' }] })],
    ['reorder points at the A branch', () => http().put('/v1/stock/reorder-points').set(auth).send({ branchId: a.branchId, items: [{ variantId: b.variantId, reorderPoint: '1' }] })],
    ['reorder point for an A variant', () => http().put('/v1/stock/reorder-points').set(auth).send({ branchId: b.branchId, items: [{ variantId: a.variantId, reorderPoint: '1' }] })],
    ['low stock at the A branch', () => http().get('/v1/stock/low').query({ branchId: a.branchId }).set(auth)],
    ['reorder points of the A branch', () => http().get('/v1/stock/reorder-points').query({ branchId: a.branchId }).set(auth)],
    ['transfers at the A branch', () => http().get('/v1/stock/transfers').query({ branchId: a.branchId }).set(auth)],
    ['counts at the A branch', () => http().get('/v1/stock/counts').query({ branchId: a.branchId }).set(auth)],
    ['count sheet at the A branch', () => http().post('/v1/stock/count-sheets').set(auth).send({ branchId: a.branchId, variantIds: [b.variantId] })],
    ['count sheet of an A variant', () => http().post('/v1/stock/count-sheets').set(auth).send({ branchId: b.branchId, variantIds: [a.variantId] })],
    ['count an A variant on a B sheet', () => http().put(`/v1/stock/count-sheets/${b.sheetId}/lines`).set(auth).send({ lines: [{ variantId: a.variantId, countedQuantity: '1' }] })],
    ['count sheets of the A branch', () => http().get('/v1/stock/count-sheets').query({ branchId: a.branchId }).set(auth)],
    ['adjustments at the A branch', () => http().get('/v1/stock/adjustments').query({ branchId: a.branchId }).set(auth)],
    ['valuation of the A branch', () => http().get('/v1/reports/inventory-valuation').query({ branchId: a.branchId }).set(auth)],
    ['stock movements report of the A branch', () => http().get('/v1/reports/stock-movements').query({ branchId: a.branchId, from: '2026-01-01', to: '2026-12-31' }).set(auth)],
    ['chart of the A entity', () => http().get('/v1/accounts').query({ legalEntityId: a.entityId }).set(auth)],
    ['account in the A entity', () => http().post('/v1/accounts').set(auth).send({ legalEntityId: a.entityId, code: '9999', name: 'x', type: 'EXPENSE' })],
    ['journal of the A entity', () => http().get('/v1/journal-entries').query({ legalEntityId: a.entityId }).set(auth)],
    ['journal lines of the A entity', () => http().get('/v1/journal-lines').query({ legalEntityId: a.entityId, from: '2026-01-01', to: '2026-12-31' }).set(auth)],
    ['manual entry in the A entity', () => http().post('/v1/journal-entries').set(auth).set('Idempotency-Key', randomUUID()).send({ legalEntityId: a.entityId, entryDate: '2026-10-01', memo: 'x', lines: [{ accountId: a.cashAccountId, debit: '1' }, { accountId: a.cashAccountId, credit: '1' }] })],
    ['manual entry on an A account', () => http().post('/v1/journal-entries').set(auth).set('Idempotency-Key', randomUUID()).send({ legalEntityId: b.entityId, entryDate: '2026-10-01', memo: 'x', lines: [{ accountId: a.cashAccountId, debit: '1' }, { accountId: b.cashAccountId, credit: '1' }] })],
    ['manual entry for an A branch', () => http().post('/v1/journal-entries').set(auth).set('Idempotency-Key', randomUUID()).send({ legalEntityId: b.entityId, entryDate: '2026-10-01', memo: 'x', lines: [{ accountId: b.cashAccountId, debit: '1', branchId: a.branchId }, { accountId: b.cashAccountId, credit: '1' }] })],
    ['periods of the A entity', () => http().get('/v1/accounting/periods').query({ legalEntityId: a.entityId }).set(auth)],
    ['close an A period', () => http().post('/v1/accounting/periods/close').set(auth).send({ legalEntityId: a.entityId, month: '2020-01' })],
    ['trial balance of the A entity', () => http().get('/v1/reports/trial-balance').query({ legalEntityId: a.entityId, from: '2026-01-01', to: '2026-12-31' }).set(auth)],
    ['recipe with an A ingredient', () => http().post(`/v1/variants/${b.dishId}/recipe`).set(auth).send({ ingredients: [{ variantId: a.variantId, quantity: '1' }] })],
    ['station at the A branch', () => http().post('/v1/kitchen-stations').set(auth).send({ branchId: a.branchId, code: 'HACK', name: 'x' })],
    ['stations of the A branch', () => http().get('/v1/kitchen-stations').query({ branchId: a.branchId }).set(auth)],
    ['area at the A branch', () => http().post('/v1/dining-areas').set(auth).send({ branchId: a.branchId, name: 'x' })],
    ['floor of the A branch', () => http().get('/v1/dining-areas').query({ branchId: a.branchId }).set(auth)],
    ['table in the A area', () => http().post('/v1/restaurant-tables').set(auth).send({ areaId: a.areaId, code: 'HACK' })],
    ['move a B table into the A area', () => http().patch(`/v1/restaurant-tables/${b.tableId}`).set(auth).send({ areaId: a.areaId })],
    ['modifier option priced by an A item', () => http().post('/v1/modifier-groups').set(auth).send({ name: 'x', options: [{ name: 'x', variantId: a.variantId }] })],
    ['add an A-item option to a B group', () => http().post(`/v1/modifier-groups/${b.modifierGroupId}/options`).set(auth).send({ name: 'x', variantId: a.variantId })],
    ['B menu offering an A item', () => http().put(`/v1/menu-versions/${b.draftVersionId}/content`).set(auth).send({ sections: [{ name: 'x', items: [{ variantId: a.variantId }] }] })],
    ['B menu with an A modifier group', () => http().put(`/v1/menu-versions/${b.draftVersionId}/content`).set(auth).send({ sections: [{ name: 'x', items: [{ variantId: b.dishId, modifierGroupIds: [a.modifierGroupId] }] }] })],
    ['B branch serving the A menu', () => http().put(`/v1/branches/${b.branchId}/restaurant-settings`).set(auth).send({ dineInMenuId: a.menuId, takeawayMenuId: null, serviceChargeRate: '0', serviceChargeDineIn: true, serviceChargeTakeaway: false, serviceChargeVatTreatment: 'VATABLE' })],
    ['86 an A item at the B branch', () => http().put(`/v1/branches/${b.branchId}/sold-out`).set(auth).send({ variantId: a.variantId, soldOut: true })],
    ['open an order at the A branch', () => http().post('/v1/restaurant/orders').set(auth).send({ branchId: a.branchId, orderType: 'TAKEAWAY' })],
    ['open a B order on an A table', () => http().post('/v1/restaurant/orders').set(auth).send({ branchId: b.branchId, orderType: 'DINE_IN', tableId: a.tableId })],
    ['orders of the A branch', () => http().get('/v1/restaurant/orders').query({ branchId: a.branchId }).set(auth)],
    ['move a B order to an A table', () => http().post(`/v1/restaurant/orders/${b.liveOrderId}/transfer`).set(auth).send({ tableId: a.tableId })],
    ['merge a B order into an A order', () => http().post(`/v1/restaurant/orders/${b.liveOrderId}/merge`).set(auth).send({ intoOrderId: a.liveOrderId })],
    ['move B items into an A order', () => http().post(`/v1/restaurant/orders/${b.liveOrderId}/move-items`).set(auth).send({ itemIds: [b.liveItemId], toOrderId: a.liveOrderId })],
    ['move B items onto an A table', () => http().post(`/v1/restaurant/orders/${b.liveOrderId}/move-items`).set(auth).send({ itemIds: [b.liveItemId], toTableId: a.tableId })],
    ['move A items out of a B order', () => http().post(`/v1/restaurant/orders/${b.liveOrderId}/move-items`).set(auth).send({ itemIds: [a.liveItemId], toTableId: b.tableId })],
    ['floor stream of the A branch', () => http().get('/v1/restaurant/stream').query({ branchId: a.branchId }).set(auth)],
    ['kitchen tickets of the A branch', () => http().get('/v1/kitchen/tickets').query({ branchId: a.branchId }).set(auth)],
    ['A station on the B kitchen display', () => http().get('/v1/kitchen/tickets').query({ branchId: b.branchId, stationId: a.stationId }).set(auth)],
    ['pay an A bill from the B drawer', () =>
      http().post(`/v1/restaurant/bills/${a.billId}/checks`).set(auth).set('Idempotency-Key', randomUUID())
        .send({ cashierSessionId: b.openSessionId, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '1000.00' }] })],
    ['pay a B bill on the A session', () =>
      http().post(`/v1/restaurant/bills/${b.billId}/checks`).set(auth).set('Idempotency-Key', randomUUID())
        .send({ cashierSessionId: a.openSessionId, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '1000.00' }] })],
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
   w.supplierId, w.purchaseOrderId, w.draftOrderId, w.goodsReceiptId, w.supplierReturnId, w.supplierInvoiceId, w.supplierPaymentId, w.supplierNoteId, w.priceOverrideId, w.heldCartId, w.customerId, w.customerSaleId, w.reservationId, w.supplierItemId, w.apiKeyId, w.webhookId, w.webhookDeliveryId, w.branch2Id, w.transferId, w.countId, w.sheetId, w.zRegisterId, w.zReadingId, w.adjustmentId, w.journalEntryId, w.cashAccountId, w.dishId,
   w.stationId, w.areaId, w.tableId, w.modifierGroupId, w.modifierOptionId, w.menuId, w.draftVersionId,
   w.orderId, w.pendingItemId, w.firedItemId, w.ticketId, w.billId, w.checkSaleId, w.liveOrderId, w.liveItemId, w.supportGrantId, w.exportId,
   w.staffId, w.timeOffId, w.appointmentId, w.bundleId, w.customerPackageId, w.noteId,
   w.roomTypeId, w.roomId, w.roomBlockId, w.stayId, w.folioId, w.guestId, w.beneficiaryId];

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
    const grants = (await http().get('/v1/support-access').set(a.auth).expect(200)).body.data;
    expect(grants.map((g: { id: string; status: string }) => [g.id, g.status])).toEqual([[a.supportGrantId, 'OPEN']]);
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
    // 10 opening − 1 sold − 1 used in the dish + 3 received − 1 returned to the supplier − 1 transferred to branch 2
    // − 3 used by the restaurant check (two dishes and a priced "Extra" that is the dish again) − 1 sold offline
    // − 1 used in the card-tipped dish that was voided (cooked food is never restocked) − 1 charged to the room.
    const onHand = (variantId: string) => stock.find((x: { variantId: string }) => x.variantId === variantId)?.quantity;
    expect([stock.length, onHand(a.variantId)]).toEqual([3, '3']);
    // The pack opened in the fixture: none left, its ten pieces on hand.
    expect(onHand(a.packVariantId)).toBe('0');
    expect((await http().get('/v1/stock/pack-openings').query({ branchId: a.branchId }).set(a.auth).expect(200)).body.data.map((o: { id: string; pieces: string }) => [o.id, o.pieces])).toEqual([[a.packOpeningId, '10']]);
    expect((await http().get('/v1/pack-conversions').set(a.auth).expect(200)).body.data.map((l: { id: string; autoOpen: boolean }) => [l.id, l.autoOpen])).toEqual([[a.packLinkId, true]]);
    const t = (await http().get(`/v1/stock/transfers/${a.transferId}`).set(a.auth).expect(200)).body;
    expect([t.status, t.lines[0].receivedQuantity]).toEqual(['RECEIVED', '1']);
    const po = (await http().get(`/v1/purchase-orders/${a.draftOrderId}`).set(a.auth).expect(200)).body;
    expect([po.status, po.notes]).toEqual(['DRAFT', null]);
    const inv = (await http().get(`/v1/supplier-invoices/${a.supplierInvoiceId}`).set(a.auth).expect(200)).body;
    expect([inv.status, inv.paidAmount, inv.payments.length, inv.payments[0].status, inv.adjustments.length]).toEqual(['OPEN', '10.00', 1, 'RECORDED', 1]);
    const cust = (await http().get(`/v1/customers/${a.customerId}`).set(a.auth).expect(200)).body;
    expect([cust.displayName.endsWith('Customer'), cust.phone, cust.marketingConsent, cust.anonymisedAt, cust.archivedAt, cust.storeCredit.map((c: { balance: string }) => c.balance)]).toEqual([true, '09170000000', true, null, null, ['5.01']]);
    const keys = (await http().get('/v1/api-keys').set(a.auth).expect(200)).body.data;
    expect(keys.map((k: { id: string; revokedAt: string | null }) => [k.id, k.revokedAt])).toEqual([[a.apiKeyId, null]]);
    const hooks = (await http().get('/v1/webhooks').set(a.auth).expect(200)).body.data;
    expect(hooks.map((w: { id: string; enabled: boolean; url: string }) => [w.id, w.enabled, w.url])).toEqual([[a.webhookId, true, 'https://hooks.example.ph/fixture']]);
    const holds = (await http().get('/v1/stock/reservations').query({ branchId: a.branchId }).set(a.auth).expect(200)).body.data;
    expect(holds.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([[a.reservationId, 'ACTIVE']]);
    const catalog = (await http().get(`/v1/suppliers/${a.supplierId}/items`).set(a.auth).expect(200)).body.data;
    expect(catalog.map((i: { id: string; unitCost: string }) => [i.id, i.unitCost])).toEqual([[a.supplierItemId, '11.0000']]);
    const carts = (await http().get('/v1/held-carts').query({ registerId: a.registerId }).set(a.auth).expect(200)).body.data;
    expect(carts.map((c: { id: string; status: string }) => [c.id, c.status])).toEqual([[a.heldCartId, 'OPEN']]);
    const settings = (await http().get(`/v1/branches/${a.branchId}/restaurant-settings`).set(a.auth).expect(200)).body;
    expect([settings.dineInMenuId, settings.serviceChargeRate]).toEqual([a.menuId, '0.1']);
    const draft = (await http().get(`/v1/menu-versions/${a.draftVersionId}`).set(a.auth).expect(200)).body;
    expect([draft.status, draft.sections.length]).toEqual(['DRAFT', 1]);
    const stations = (await http().get('/v1/kitchen-stations').query({ branchId: a.branchId }).set(a.auth).expect(200)).body.data;
    expect(stations.map((s: { name: string; isDefault: boolean }) => [s.name, s.isDefault])).toEqual([['Grill', true]]);
    const soldOut = (await http().get(`/v1/branches/${a.branchId}/sold-out`).set(a.auth).expect(200)).body.data;
    expect(soldOut.map((s: { variantId: string }) => s.variantId)).toEqual([a.variantId]);
    const order = (await http().get(`/v1/restaurant/orders/${a.orderId}`).set(a.auth).expect(200)).body;
    expect([order.status, order.table.id, order.items.map((i: { status: string; quantity: string }) => [i.status, i.quantity])]).toEqual(['SETTLED', a.tableId, [['FIRED', '1'], ['FIRED', '1']]]);
    const bill = (await http().get(`/v1/restaurant/bills/${a.billId}`).set(a.auth).expect(200)).body;
    expect([bill.status, bill.checks.map((c: { id: string }) => c.id)]).toEqual(['SETTLED', [a.checkSaleId]]);
  });

  it("a terminal cannot reach the other tenant: its snapshot is its own, and naming B's snapshot or shift records nothing in B", async () => {
    const snapA = (await http().get('/v1/terminal/snapshot').set(a.terminalHeaders).expect(200)).body;
    expect(JSON.stringify(snapA)).not.toContain(b.variantId);
    expect(JSON.stringify(snapA)).not.toContain(b.openSessionId);
    const before = await asOwnerInTenant(owner, b.t.tenantId, async (c) => (await c.query('SELECT count(*)::int AS n FROM sales')).rows[0].n);
    const smuggled = (await http().post('/v1/sync/sales').set(a.terminalHeaders).send({ sales: [{
      terminalTxnId: randomUUID(), deviceSeq: 99, snapshotId: b.snapshotId, cashierSessionId: b.openSessionId, cashierUserId: b.t.userId,
      occurredAt: new Date().toISOString(), localReference: 'X', lines: [{ variantId: b.variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '22.00' }], amountDue: '22.00',
    }] }).expect(200)).body.results[0];
    expect([smuggled.status, smuggled.code]).toEqual(['QUARANTINED', 'UNKNOWN_SNAPSHOT']);
    expect(await asOwnerInTenant(owner, b.t.tenantId, async (c) => (await c.query('SELECT count(*)::int AS n FROM sales')).rows[0].n)).toBe(before);
    // The quarantine row is A's and names no B shift.
    const [row] = await asOwnerInTenant(owner, a.t.tenantId, async (c) => (await c.query(`SELECT cashier_session_id FROM terminal_transactions WHERE device_seq = 99`)).rows);
    expect(row).toEqual({ cashier_session_id: null });
  });

  it("no list or read endpoint returns any of the other tenant's ids", async () => {
    const paths = [
      '/v1/me', '/v1/business', '/v1/support-access', '/v1/data-exports', `/v1/data-exports/${b.exportId}`, '/v1/sample-data', '/v1/members', '/v1/members/mfa', '/v1/roles', '/v1/audit-logs?limit=200', `/v1/audit-logs?actorUserId=${a.t.userId}`, '/v1/subscription', '/v1/legal-entities', '/v1/branches', '/v1/registers', '/v1/terminals',
      `/v1/legal-entities/${b.entityId}/tax-profiles`, '/v1/discount-schemes',
      '/v1/uoms', '/v1/tax-categories', '/v1/categories', '/v1/products', '/v1/price-lists', `/v1/price-lists/${b.priceListId}/prices`,
      `/v1/variants/${b.variantId}/price-history`, `/v1/variants/${b.dishId}/recipe`, '/v1/invitations',
      // Names by id: A's variant asked for alongside B's comes back as nothing.
      `/v1/variants?ids=${b.variantId},${a.variantId},${b.dishId}`,
      '/v1/sync/transactions', `/v1/sync/transactions?terminalId=${b.terminalId}`,
      '/v1/pos/workstations', `/v1/held-carts?registerId=${b.registerId}`, '/v1/api-keys', '/v1/webhooks', `/v1/webhooks/${b.webhookId}/deliveries`, `/v1/stock/reservations?branchId=${b.branchId}&status=ALL`, `/v1/suppliers/${b.supplierId}/items`, `/v1/variants/${b.variantId}/suppliers`, '/v1/pack-conversions', `/v1/stock/pack-openings?branchId=${b.branchId}`, `/v1/stock/pack-openings/${b.packOpeningId}`, `/v1/stock/expiring?branchId=${b.branchId}&withinDays=365`, `/v1/stock/lots?branchId=${b.branchId}&variantId=${b.variantId}`, '/v1/customers', '/v1/customers?q=Customer', `/v1/customers/${b.customerId}`, `/v1/customers/${b.customerId}/sales`, `/v1/customers/${b.customerId}/store-credit`, `/v1/sales/${b.customerSaleId}/receipt`, '/v1/cashier-sessions', `/v1/cashier-sessions/${b.closedSessionId}`, '/v1/sales', `/v1/sales?cashierSessionId=${a.closedSessionId}`, `/v1/sales/${b.saleId}`, `/v1/sales/${b.saleId}/receipt`, `/v1/sales/${b.saleId}/returns`, `/v1/sale-returns/${b.saleReturnId}`, `/v1/sale-returns/${b.saleReturnId}/receipt`, `/v1/cash-movements/${b.cashMovementId}`,`/v1/payment-intents/${b.paymentIntentId}`, `/v1/payment-intents?cashierSessionId=${b.openSessionId}`,
      `/v1/stock/balances?branchId=${b.branchId}`, `/v1/reports/cashier-sessions/${b.closedSessionId}`,
      ...['sales-summary', 'by-product', 'by-cashier', 'refund-watch', 'by-tender', 'tax-summary', 'statutory-book', 'by-category', 'discounts', 'purchases-by-supplier'].map((r) => `/v1/reports/${r}?branchId=${b.branchId}&from=2026-01-01&to=2026-12-31`),
      '/v1/reports/by-branch?from=2026-01-01&to=2026-12-31', `/v1/reports/payment-exceptions?branchId=${b.branchId}`, `/v1/stock/movements?branchId=${b.branchId}`,
      '/v1/suppliers', `/v1/suppliers/${b.supplierId}`, '/v1/purchase-orders', `/v1/purchase-orders?branchId=${a.branchId}`, `/v1/purchase-orders/${b.purchaseOrderId}`,
      `/v1/goods-receipts?branchId=${b.branchId}`, `/v1/goods-receipts/${b.goodsReceiptId}`, `/v1/supplier-returns?branchId=${b.branchId}`, `/v1/supplier-returns/${b.supplierReturnId}`,
      `/v1/supplier-invoices?legalEntityId=${b.entityId}`, `/v1/supplier-invoices/${b.supplierInvoiceId}`, `/v1/supplier-payments/${b.supplierPaymentId}`, `/v1/supplier-notes/${b.supplierNoteId}`,
      `/v1/uninvoiced-receipts?branchId=${b.branchId}&supplierId=${b.supplierId}`, `/v1/reports/payables-aging?legalEntityId=${b.entityId}`,
      `/v1/stock/transfers?branchId=${b.branchId}`, `/v1/stock/transfers/${b.transferId}`, `/v1/stock/counts?branchId=${b.branch2Id}`, `/v1/stock/counts/${b.countId}`, `/v1/stock/count-sheets?branchId=${b.branch2Id}`, `/v1/stock/count-sheets/${b.sheetId}`, `/v1/registers/${b.zRegisterId}/z-readings`, `/v1/z-readings/${b.zReadingId}`, `/v1/branches/${b.branchId}/inventory-settings`, `/v1/stock/adjustments?branchId=${b.branchId}`, `/v1/stock/adjustments/${b.adjustmentId}`,
      `/v1/stock/low?branchId=${b.branchId}`, `/v1/stock/reorder-points?branchId=${b.branchId}`,`/v1/reports/inventory-valuation?branchId=${b.branchId}`, `/v1/reports/stock-movements?branchId=${b.branchId}&from=2026-01-01&to=2026-12-31`,
      `/v1/accounts?legalEntityId=${b.entityId}`, `/v1/journal-entries?legalEntityId=${b.entityId}`, `/v1/journal-lines?legalEntityId=${b.entityId}&from=2026-01-01&to=2026-12-31`, `/v1/journal-entries/${b.journalEntryId}`,
      `/v1/accounting/periods?legalEntityId=${b.entityId}`, `/v1/reports/trial-balance?legalEntityId=${b.entityId}&from=2026-01-01&to=2026-12-31`,
      `/v1/kitchen-stations?branchId=${b.branchId}`, `/v1/dining-areas?branchId=${b.branchId}`, '/v1/modifier-groups', '/v1/menus', `/v1/menus/${b.menuId}`,
      `/v1/menu-versions/${b.draftVersionId}`, `/v1/branches/${b.branchId}/restaurant-settings`, `/v1/branches/${b.branchId}/sold-out`, `/v1/branches/${b.branchId}/menu`,
      `/v1/restaurant/orders?branchId=${b.branchId}&status=ALL`, `/v1/restaurant/orders/${b.orderId}`, `/v1/kitchen/tickets?branchId=${b.branchId}&status=ALL`,
      `/v1/restaurant/bills/${b.billId}`, `/v1/sales/${b.checkSaleId}`, `/v1/sales/${b.checkSaleId}/receipt`,
      ...RESTAURANT_REPORTS.map((r) => `/v1/reports/${r}?branchId=${b.branchId}&from=2026-01-01&to=2026-12-31`), `/v1/reports/open-orders?branchId=${b.branchId}&day=${today()}`,
      `/v1/service-staff?branchId=${b.branchId}&includeArchived=true`, `/v1/service-staff/${b.staffId}`, `/v1/appointments?branchId=${b.branchId}&from=2031-01-01T00:00:00Z&to=2031-01-10T00:00:00Z`,
      `/v1/appointments/${b.appointmentId}`, `/v1/variants/${b.bundleId}/package-items`, `/v1/customers/${b.customerId}/packages`, `/v1/customers/${b.customerId}/visits`, `/v1/customers/${b.customerId}/notes`,
      ...['commissions', 'service-packages', 'tips-by-staff'].map((r) => `/v1/reports/${r}?branchId=${b.branchId}&from=2026-01-01&to=2026-12-31`),
      '/v1/room-types', `/v1/room-types/${b.roomTypeId}`, '/v1/rooms', `/v1/rooms/${b.roomId}`, `/v1/rooms/${b.roomId}/status-changes`, `/v1/room-blocks?branchId=${b.branchId}`,
      `/v1/branches/${b.branchId}/lodging-settings`, `/v1/lodging/housekeeping?branchId=${b.branchId}`, `/v1/lodging/availability?branchId=${b.branchId}&from=2031-01-01&to=2031-01-03`,
      '/v1/stays', `/v1/stays/in-house?branchId=${b.branchId}`, `/v1/stays/${b.stayId}`, `/v1/stays/${b.stayId}/guests`, `/v1/stays/${b.stayId}/registration-card`,
      `/v1/stays/${b.stayId}/deposits`, `/v1/stays/${b.stayId}/folio`, `/v1/folios/${b.folioId}`, `/v1/folios/${b.folioId}/statement`,
      `/v1/reports/guest-ledger?legalEntityId=${b.entityId}`,
      ...['occupancy', 'accommodation-tax'].map((r) => `/v1/reports/${r}?branchId=${b.branchId}&from=2026-01-01&to=2026-12-31`),
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
