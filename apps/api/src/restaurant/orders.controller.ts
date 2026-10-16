import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  addOrderItemsSchema,
  cancelOrderSchema,
  fireOrderSchema,
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
import { KitchenService } from './kitchen.service.js';
import { OrdersService } from './orders.service.js';

const id = new ZodPipe(idParamSchema);

/** Restaurant orders and the kitchen display (ADR-0014 §6, §7). Branch-scoped permissions are checked in the services. */
@RequireTenant()
@Controller()
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(KitchenService) private readonly kitchen: KitchenService,
  ) {}

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
}
