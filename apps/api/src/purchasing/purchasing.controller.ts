import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  cancelSupplierInvoiceSchema,
  createSupplierInvoiceSchema,
  createSupplierBatchPaymentSchema,
  createSupplierNoteSchema,
  createSupplierPaymentSchema,
  voidSupplierPaymentSchema,
  payablesAgingQuerySchema,
  supplierInvoiceListQuerySchema,
  uninvoicedReceiptsQuerySchema,
  type CancelSupplierInvoiceInput,
  type CreateSupplierInvoiceInput,
  type CreateSupplierBatchPaymentInput,
  type CreateSupplierNoteInput,
  type CreateSupplierPaymentInput,
  type VoidSupplierPaymentInput,
  type PayablesAgingQuery,
  type SupplierInvoiceListQuery,
  type UninvoicedReceiptsQuery,
  createGoodsReceiptSchema,
  createPurchaseOrderSchema,
  createSupplierReturnSchema,
  createSupplierSchema,
  createSupplierItemSchema,
  updateSupplierItemSchema,
  type CreateSupplierItemInput,
  type UpdateSupplierItemInput,
  endPurchaseOrderSchema,
  goodsReceiptListQuerySchema,
  idParamSchema,
  purchaseOrderListQuerySchema,
  supplierListQuerySchema,
  supplierReturnListQuerySchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
  type CreateGoodsReceiptInput,
  type CreatePurchaseOrderInput,
  type CreateSupplierInput,
  type CreateSupplierReturnInput,
  type EndPurchaseOrderInput,
  type GoodsReceiptListQuery,
  type PurchaseOrderListQuery,
  type SupplierListQuery,
  type SupplierReturnListQuery,
  type UpdatePurchaseOrderInput,
  type UpdateSupplierInput,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { PayablesService } from './payables.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { ReceivingService } from './receiving.service.js';
import { SuppliersService } from './suppliers.service.js';
import { SupplierItemsService } from './supplier-items.service.js';

const id = new ZodPipe(idParamSchema);

/** Suppliers, purchase orders, goods receipts, supplier returns, invoices and payments. Scope-aware permissions are checked in the services. */
@RequireTenant()
@Controller()
export class PurchasingController {
  constructor(
    @Inject(SuppliersService) private readonly suppliers: SuppliersService,
    @Inject(PurchaseOrdersService) private readonly orders: PurchaseOrdersService,
    @Inject(ReceivingService) private readonly receiving: ReceivingService,
    @Inject(PayablesService) private readonly payables: PayablesService,
    @Inject(SupplierItemsService) private readonly catalog: SupplierItemsService,
  ) {}

  // supplier catalog (session 20)
  @Get('suppliers/:id/items')
  listSupplierItems(@Auth() auth: AuthContext, @Param('id', id) supplierId: string) {
    return this.catalog.list(auth, supplierId);
  }

  @Post('suppliers/:id/items')
  createSupplierItem(@Auth() auth: AuthContext, @Param('id', id) supplierId: string, @Body(new ZodPipe(createSupplierItemSchema)) body: CreateSupplierItemInput) {
    return this.catalog.create(auth, supplierId, body);
  }

  @Patch('supplier-items/:id')
  updateSupplierItem(@Auth() auth: AuthContext, @Param('id', id) itemId: string, @Body(new ZodPipe(updateSupplierItemSchema)) body: UpdateSupplierItemInput) {
    return this.catalog.update(auth, itemId, body);
  }

  @HttpCode(200)
  @Post('supplier-items/:id/archive')
  archiveSupplierItem(@Auth() auth: AuthContext, @Param('id', id) itemId: string) {
    return this.catalog.archive(auth, itemId);
  }

  @Get('variants/:id/suppliers')
  variantSuppliers(@Auth() auth: AuthContext, @Param('id', id) variantId: string) {
    return this.catalog.forVariant(auth, variantId);
  }

  // suppliers
  @Idempotent()
  @Post('suppliers')
  createSupplier(@Auth() auth: AuthContext, @Body(new ZodPipe(createSupplierSchema)) body: CreateSupplierInput) {
    return this.suppliers.create(auth, body);
  }

  @Get('suppliers')
  listSuppliers(@Auth() auth: AuthContext, @Query(new ZodPipe(supplierListQuerySchema)) q: SupplierListQuery) {
    return this.suppliers.list(auth, q);
  }

  @Get('suppliers/:id')
  getSupplier(@Auth() auth: AuthContext, @Param('id', id) supplierId: string) {
    return this.suppliers.get(auth, supplierId);
  }

  @Patch('suppliers/:id')
  updateSupplier(@Auth() auth: AuthContext, @Param('id', id) supplierId: string, @Body(new ZodPipe(updateSupplierSchema)) body: UpdateSupplierInput) {
    return this.suppliers.update(auth, supplierId, body);
  }

  @HttpCode(200)
  @Post('suppliers/:id/archive')
  archiveSupplier(@Auth() auth: AuthContext, @Param('id', id) supplierId: string) {
    return this.suppliers.archive(auth, supplierId);
  }

  // purchase orders
  @Idempotent()
  @Post('purchase-orders')
  createOrder(@Auth() auth: AuthContext, @Body(new ZodPipe(createPurchaseOrderSchema)) body: CreatePurchaseOrderInput) {
    return this.orders.create(auth, body);
  }

  @Get('purchase-orders')
  listOrders(@Auth() auth: AuthContext, @Query(new ZodPipe(purchaseOrderListQuerySchema)) q: PurchaseOrderListQuery) {
    return this.orders.list(auth, q);
  }

  @Get('purchase-orders/:id')
  getOrder(@Auth() auth: AuthContext, @Param('id', id) orderId: string) {
    return this.orders.get(auth, orderId);
  }

  @Patch('purchase-orders/:id')
  updateOrder(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(updatePurchaseOrderSchema)) body: UpdatePurchaseOrderInput) {
    return this.orders.update(auth, orderId, body);
  }

  @HttpCode(200)
  @Post('purchase-orders/:id/approve')
  approveOrder(@Auth() auth: AuthContext, @Param('id', id) orderId: string) {
    return this.orders.approve(auth, orderId);
  }

  @HttpCode(200)
  @Post('purchase-orders/:id/cancel')
  cancelOrder(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(endPurchaseOrderSchema)) body: EndPurchaseOrderInput) {
    return this.orders.cancel(auth, orderId, body);
  }

  @HttpCode(200)
  @Post('purchase-orders/:id/close')
  closeOrder(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(endPurchaseOrderSchema)) body: EndPurchaseOrderInput) {
    return this.orders.close(auth, orderId, body);
  }

  // receiving — inventory evidence: Idempotency-Key is mandatory
  @Idempotent({ required: true })
  @Post('goods-receipts')
  receive(@Auth() auth: AuthContext, @Body(new ZodPipe(createGoodsReceiptSchema)) body: CreateGoodsReceiptInput) {
    return this.receiving.receive(auth, body);
  }

  @Get('goods-receipts')
  listReceipts(@Auth() auth: AuthContext, @Query(new ZodPipe(goodsReceiptListQuerySchema)) q: GoodsReceiptListQuery) {
    return this.receiving.listReceipts(auth, q);
  }

  @Get('goods-receipts/:id')
  getReceipt(@Auth() auth: AuthContext, @Param('id', id) receiptId: string) {
    return this.receiving.getReceipt(auth, receiptId);
  }

  @Idempotent({ required: true })
  @Post('supplier-returns')
  returnToSupplier(@Auth() auth: AuthContext, @Body(new ZodPipe(createSupplierReturnSchema)) body: CreateSupplierReturnInput) {
    return this.receiving.returnToSupplier(auth, body);
  }

  @Get('supplier-returns')
  listReturns(@Auth() auth: AuthContext, @Query(new ZodPipe(supplierReturnListQuerySchema)) q: SupplierReturnListQuery) {
    return this.receiving.listReturns(auth, q);
  }

  @Get('supplier-returns/:id')
  getReturn(@Auth() auth: AuthContext, @Param('id', id) returnId: string) {
    return this.receiving.getReturn(auth, returnId);
  }

  // payables — books evidence: Idempotency-Key is mandatory
  @Get('uninvoiced-receipts')
  uninvoicedReceipts(@Auth() auth: AuthContext, @Query(new ZodPipe(uninvoicedReceiptsQuerySchema)) q: UninvoicedReceiptsQuery) {
    return this.payables.uninvoicedReceipts(auth, q);
  }

  @Idempotent({ required: true })
  @Post('supplier-invoices')
  createInvoice(@Auth() auth: AuthContext, @Body(new ZodPipe(createSupplierInvoiceSchema)) body: CreateSupplierInvoiceInput) {
    return this.payables.createInvoice(auth, body);
  }

  @Get('supplier-invoices')
  listInvoices(@Auth() auth: AuthContext, @Query(new ZodPipe(supplierInvoiceListQuerySchema)) q: SupplierInvoiceListQuery) {
    return this.payables.listInvoices(auth, q);
  }

  @Get('supplier-invoices/:id')
  getInvoice(@Auth() auth: AuthContext, @Param('id', id) invoiceId: string) {
    return this.payables.getInvoice(auth, invoiceId);
  }

  @Idempotent({ required: true })
  @HttpCode(200)
  @Post('supplier-invoices/:id/cancel')
  cancelInvoice(@Auth() auth: AuthContext, @Param('id', id) invoiceId: string, @Body(new ZodPipe(cancelSupplierInvoiceSchema)) body: CancelSupplierInvoiceInput) {
    return this.payables.cancelInvoice(auth, invoiceId, body);
  }

  @Idempotent({ required: true })
  @Post('supplier-invoices/:id/payments')
  pay(@Auth() auth: AuthContext, @Param('id', id) invoiceId: string, @Body(new ZodPipe(createSupplierPaymentSchema)) body: CreateSupplierPaymentInput) {
    return this.payables.pay(auth, invoiceId, body);
  }

  @Idempotent({ required: true })
  @Post('supplier-invoices/:id/notes')
  createNote(@Auth() auth: AuthContext, @Param('id', id) invoiceId: string, @Body(new ZodPipe(createSupplierNoteSchema)) body: CreateSupplierNoteInput) {
    return this.payables.createNote(auth, invoiceId, body);
  }

  @Get('supplier-notes/:id')
  getNote(@Auth() auth: AuthContext, @Param('id', id) noteId: string) {
    return this.payables.getNote(auth, noteId);
  }

  /** One payment over several open invoices of one supplier and legal entity (session 22). */
  @Idempotent({ required: true })
  @Post('supplier-payments')
  payMany(@Auth() auth: AuthContext, @Body(new ZodPipe(createSupplierBatchPaymentSchema)) body: CreateSupplierBatchPaymentInput) {
    return this.payables.payMany(auth, body);
  }

  @Get('supplier-payments/:id')
  getPayment(@Auth() auth: AuthContext, @Param('id', id) paymentId: string) {
    return this.payables.getPayment(auth, paymentId);
  }

  @Idempotent({ required: true })
  @HttpCode(200)
  @Post('supplier-payments/:id/void')
  voidPayment(@Auth() auth: AuthContext, @Param('id', id) paymentId: string, @Body(new ZodPipe(voidSupplierPaymentSchema)) body: VoidSupplierPaymentInput) {
    return this.payables.voidPayment(auth, paymentId, body);
  }

  @Get('reports/payables-aging')
  aging(@Auth() auth: AuthContext, @Query(new ZodPipe(payablesAgingQuerySchema)) q: PayablesAgingQuery) {
    return this.payables.aging(auth, q);
  }
}
