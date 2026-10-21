import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import {
  claimKitchenTicketsSchema,
  type ClaimKitchenTicketsInput,
  snapshotItemsQuerySchema,
  snapshotPageQuerySchema,
  syncSalesBatchSchema,
  type SnapshotItemsQuery,
  type SnapshotPageQuery,
  type SyncSalesBatch,
} from '@1pos/sync-protocol';
import { dismissOfflineSchema, idParamSchema, offlineListQuerySchema, type DismissOfflineInput, type OfflineListQuery } from '@1pos/validation';
import { Auth, RequireTenant, TerminalAuth, type AuthContext, type AuthedRequest } from '../auth/auth-context.js';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { SyncService } from './sync.service.js';

const id = new ZodPipe(idParamSchema);
/**
 * A terminal syncing a long outage sends many batches; a stolen credential still cannot flood.
 * Counted per terminal, plus a looser per-IP cap (a shop's tills share one address) so made-up
 * terminal ids cannot each get a fresh allowance.
 */
const TERMINAL_LIMITS = [
  { bucket: 'terminal', limit: 600, windowSeconds: 60, by: 'terminal' as const },
  { bucket: 'terminal-ip', limit: 3000, windowSeconds: 60 },
];

/** Offline sync (ADR-0015). Terminal routes authenticate with the terminal credential, not a user token. */
@Controller()
export class SyncController {
  constructor(@Inject(SyncService) private readonly sync: SyncService) {}

  /** Asked every half minute by an online till: has anything its snapshot is made of changed? */
  @TerminalAuth()
  @RateLimit(...TERMINAL_LIMITS)
  @Get('terminal/catalog-version')
  async catalogVersion(@Req() req: AuthedRequest) {
    return this.sync.catalogVersion(await this.sync.authenticate((h) => req.header(h), req.correlationId));
  }

  @TerminalAuth()
  @RateLimit(...TERMINAL_LIMITS)
  @Get('terminal/snapshot')
  async snapshot(@Req() req: AuthedRequest, @Query(new ZodPipe(snapshotPageQuerySchema)) q: SnapshotPageQuery) {
    return this.sync.snapshot(await this.sync.authenticate((h) => req.header(h), req.correlationId), q.pageSize);
  }

  /** Further pages of a paged snapshot (ADR-0016 slice 5), priced as of the same instant. */
  @TerminalAuth()
  @RateLimit(...TERMINAL_LIMITS)
  @Get('terminal/snapshot/:id/items')
  async snapshotItems(@Req() req: AuthedRequest, @Param('id', id) snapshotId: string, @Query(new ZodPipe(snapshotItemsQuerySchema)) q: SnapshotItemsQuery) {
    return this.sync.snapshotItems(await this.sync.authenticate((h) => req.header(h), req.correlationId), snapshotId, q.after, q.pageSize);
  }

  @TerminalAuth()
  @RateLimit(...TERMINAL_LIMITS)
  @HttpCode(200)
  @Post('sync/sales')
  async syncSales(@Req() req: AuthedRequest, @Body(new ZodPipe(syncSalesBatchSchema)) body: SyncSalesBatch) {
    // Only each envelope's head is checked here: the service checks each one alone (a malformed one is quarantined).
    const terminal = await this.sync.authenticate((h) => req.header(h), req.correlationId);
    return { results: await this.sync.syncSales(terminal, body.sales, req.receivedAt) };
  }

  /** Kitchen printing (session 25): the stations a till can print for. */
  @TerminalAuth()
  @RateLimit(...TERMINAL_LIMITS)
  @Get('terminal/kitchen-stations')
  async kitchenStations(@Req() req: AuthedRequest) {
    return this.sync.kitchenStations(await this.sync.authenticate((h) => req.header(h), req.correlationId));
  }

  /** The next unprinted tickets of these stations, claimed for this till for a minute. */
  @TerminalAuth()
  @RateLimit(...TERMINAL_LIMITS)
  @HttpCode(200)
  @Post('terminal/kitchen-tickets/claim')
  async claimKitchenTickets(@Req() req: AuthedRequest, @Body(new ZodPipe(claimKitchenTicketsSchema)) body: ClaimKitchenTicketsInput) {
    return this.sync.claimKitchenTickets(await this.sync.authenticate((h) => req.header(h), req.correlationId), body.stationIds);
  }

  @TerminalAuth()
  @RateLimit(...TERMINAL_LIMITS)
  @HttpCode(200)
  @Post('terminal/kitchen-tickets/:id/printed')
  async kitchenTicketPrinted(@Req() req: AuthedRequest, @Param('id', id) ticketId: string) {
    return this.sync.settleKitchenPrint(await this.sync.authenticate((h) => req.header(h), req.correlationId), ticketId, 'printed');
  }

  /** The printer did not take it: give the ticket back for the next round. */
  @TerminalAuth()
  @RateLimit(...TERMINAL_LIMITS)
  @HttpCode(200)
  @Post('terminal/kitchen-tickets/:id/release')
  async kitchenTicketRelease(@Req() req: AuthedRequest, @Param('id', id) ticketId: string) {
    return this.sync.settleKitchenPrint(await this.sync.authenticate((h) => req.header(h), req.correlationId), ticketId, 'released');
  }

  @RequireTenant()
  @Get('sync/terminals')
  terminals(@Auth() auth: AuthContext) {
    return this.sync.terminalHealth(auth);
  }

  @RequireTenant()
  @Get('sync/transactions')
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(offlineListQuerySchema)) q: OfflineListQuery) {
    return this.sync.list(auth, q);
  }

  @RequireTenant()
  @Get('sync/transactions/:id')
  get(@Auth() auth: AuthContext, @Param('id', id) txId: string) {
    return this.sync.get(auth, txId);
  }

  @RequireTenant()
  @HttpCode(200)
  @Post('sync/transactions/:id/retry')
  retry(@Auth() auth: AuthContext, @Param('id', id) txId: string) {
    return this.sync.retry(auth, txId);
  }

  @RequireTenant()
  @HttpCode(200)
  @Post('sync/transactions/:id/dismiss')
  dismiss(@Auth() auth: AuthContext, @Param('id', id) txId: string, @Body(new ZodPipe(dismissOfflineSchema)) body: DismissOfflineInput) {
    return this.sync.dismiss(auth, txId, body);
  }
}
