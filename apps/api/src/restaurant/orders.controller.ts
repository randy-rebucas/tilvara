import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { branchQuerySchema, type BranchQuery } from '@1pos/validation';
import { tenantOf } from '../auth/auth-context.js';
import { FloorEvents } from './floor-events.js';
import {
  addOrderItemsSchema,
  cancelOrderSchema,
  createBillSchema,
  voidBillSchema,
  type CreateBillInput,
  type VoidBillInput,
  fireOrderSchema,
  courseNoteSchema,
  idParamSchema,
  itemStatusSchema,
  kitchenTicketQuerySchema,
  mergeOrderSchema,
  moveOrderItemsSchema,
  openOrderSchema,
  orderListQuerySchema,
  transferOrderSchema,
  updateOrderItemSchema,
  voidOrderItemSchema,
  type AddOrderItemsInput,
  type CancelOrderInput,
  type FireOrderInput,
  type CourseNoteInput,
  type ItemStatusInput,
  type KitchenTicketQuery,
  type MergeOrderInput,
  type MoveOrderItemsInput,
  type OpenOrderInput,
  type OrderListQuery,
  type TransferOrderInput,
  type UpdateOrderItemInput,
  type VoidOrderItemInput,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { BillsService } from './bills.service.js';
import { KitchenService } from './kitchen.service.js';
import { OrdersService } from './orders.service.js';

const id = new ZodPipe(idParamSchema);
const STREAM_MAX_MS = 10 * 60_000;

/** Restaurant orders and the kitchen display (ADR-0014 §6, §7). Branch-scoped permissions are checked in the services. */
@RequireTenant()
@Controller()
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(KitchenService) private readonly kitchen: KitchenService,
    @Inject(BillsService) private readonly bills: BillsService,
    @Inject(FloorEvents) private readonly events: FloorEvents,
  ) {}

  /** Freeze the order's price (ADR-0014 §8). Idempotency-Key is mandatory (financial snapshot). */
  @Idempotent({ required: true })
  @Post('restaurant/orders/:id/bill')
  bill(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(createBillSchema)) body: CreateBillInput) {
    return this.bills.create(auth, orderId, body);
  }

  @Get('restaurant/bills/:id')
  getBill(@Auth() auth: AuthContext, @Param('id', id) billId: string) {
    return this.bills.get(auth, billId);
  }

  @Idempotent()
  @HttpCode(200)
  @Post('restaurant/bills/:id/void')
  voidBill(@Auth() auth: AuthContext, @Param('id', id) billId: string, @Body(new ZodPipe(voidBillSchema)) body: VoidBillInput) {
    return this.bills.voidBill(auth, billId, body);
  }

  @Idempotent()
  @Post('restaurant/orders')
  open(@Auth() auth: AuthContext, @Body(new ZodPipe(openOrderSchema)) body: OpenOrderInput) {
    return this.orders.open(auth, body);
  }

  @Get('restaurant/orders')
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(orderListQuerySchema)) q: OrderListQuery) {
    return this.orders.list(auth, q);
  }

  @Get('restaurant/orders/:id')
  get(@Auth() auth: AuthContext, @Param('id', id) orderId: string) {
    return this.orders.get(auth, orderId);
  }

  /** Tablets retry on bad networks: Idempotency-Key is mandatory so an order is never doubled. */
  @Idempotent({ required: true })
  @Post('restaurant/orders/:id/items')
  addItems(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(addOrderItemsSchema)) body: AddOrderItemsInput) {
    return this.orders.addItems(auth, orderId, body);
  }

  /**
   * Server-Sent Events for a branch's floor and kitchen (session 16): `changed` whenever an order,
   * item, ticket or bill there changes (coalesced over 150 ms), a comment every 25 s to keep proxies
   * from closing it, and the end after 10 minutes so the client reconnects with a fresh token (access
   * is checked again then). No data travels on it: clients re-read through their normal routes.
   */
  @Get('restaurant/stream')
  async stream(@Auth() auth: AuthContext, @Query(new ZodPipe(branchQuerySchema)) q: BranchQuery, @Req() req: Request, @Res() res: Response) {
    await this.orders.checkFloorAccess(auth, q.branchId);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\nevent: ready\ndata: {}\n\n');
    let pending: NodeJS.Timeout | null = null;
    const off = this.events.subscribe(tenantOf(auth).tenantId, q.branchId, () => {
      pending ??= setTimeout(() => {
        pending = null;
        res.write('event: changed\ndata: {}\n\n');
      }, 150);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const end = setTimeout(() => res.end(), STREAM_MAX_MS);
    req.on('close', () => {
      off();
      clearInterval(ping);
      clearTimeout(end);
      if (pending) clearTimeout(pending);
    });
  }

  @Put('restaurant/orders/:id/course-notes')
  setCourseNote(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(courseNoteSchema)) body: CourseNoteInput) {
    return this.orders.setCourseNote(auth, orderId, body);
  }

  @Idempotent()
  @HttpCode(200)
  @Post('restaurant/orders/:id/fire')
  fire(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(fireOrderSchema)) body: FireOrderInput) {
    return this.orders.fire(auth, orderId, body);
  }

  @Idempotent()
  @HttpCode(200)
  @Post('restaurant/orders/:id/transfer')
  transfer(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(transferOrderSchema)) body: TransferOrderInput) {
    return this.orders.transfer(auth, orderId, body);
  }

  @Idempotent()
  @HttpCode(200)
  @Post('restaurant/orders/:id/merge')
  merge(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(mergeOrderSchema)) body: MergeOrderInput) {
    return this.orders.merge(auth, orderId, body);
  }

  @Idempotent()
  @HttpCode(200)
  @Post('restaurant/orders/:id/move-items')
  moveItems(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(moveOrderItemsSchema)) body: MoveOrderItemsInput) {
    return this.orders.moveItems(auth, orderId, body);
  }

  @Idempotent()
  @HttpCode(200)
  @Post('restaurant/orders/:id/cancel')
  cancel(@Auth() auth: AuthContext, @Param('id', id) orderId: string, @Body(new ZodPipe(cancelOrderSchema)) body: CancelOrderInput) {
    return this.orders.cancel(auth, orderId, body);
  }

  @Patch('order-items/:id')
  updateItem(@Auth() auth: AuthContext, @Param('id', id) itemId: string, @Body(new ZodPipe(updateOrderItemSchema)) body: UpdateOrderItemInput) {
    return this.orders.updateItem(auth, itemId, body);
  }

  @HttpCode(200)
  @Post('order-items/:id/remove')
  removeItem(@Auth() auth: AuthContext, @Param('id', id) itemId: string) {
    return this.orders.removeItem(auth, itemId);
  }

  /** Writes stock off when `wasted`: Idempotency-Key is mandatory (inventory evidence). */
  @Idempotent({ required: true })
  @HttpCode(200)
  @Post('order-items/:id/void')
  voidItem(@Auth() auth: AuthContext, @Param('id', id) itemId: string, @Body(new ZodPipe(voidOrderItemSchema)) body: VoidOrderItemInput) {
    return this.orders.voidItem(auth, itemId, body);
  }

  @HttpCode(200)
  @Post('order-items/:id/status')
  setItemStatus(@Auth() auth: AuthContext, @Param('id', id) itemId: string, @Body(new ZodPipe(itemStatusSchema)) body: ItemStatusInput) {
    return this.kitchen.setItemStatus(auth, itemId, body);
  }

  @Get('kitchen/tickets')
  tickets(@Auth() auth: AuthContext, @Query(new ZodPipe(kitchenTicketQuerySchema)) q: KitchenTicketQuery) {
    return this.kitchen.tickets(auth, q);
  }

  @HttpCode(200)
  @Post('kitchen/tickets/:id/bump')
  bump(@Auth() auth: AuthContext, @Param('id', id) ticketId: string) {
    return this.kitchen.bump(auth, ticketId);
  }

  @HttpCode(200)
  @Post('kitchen/tickets/:id/unbump')
  unbump(@Auth() auth: AuthContext, @Param('id', id) ticketId: string) {
    return this.kitchen.unbump(auth, ticketId);
  }
}
