import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { syncSalesRequestSchema, type SyncSalesRequest } from '@1pos/sync-protocol';
import { dismissOfflineSchema, idParamSchema, offlineListQuerySchema, type DismissOfflineInput, type OfflineListQuery } from '@1pos/validation';
import { Auth, RequireTenant, TerminalAuth, type AuthContext, type AuthedRequest } from '../auth/auth-context.js';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { SyncService } from './sync.service.js';

const id = new ZodPipe(idParamSchema);
/** A terminal syncing a long outage sends many batches; a stolen credential still cannot flood. */
const TERMINAL_LIMIT = { bucket: 'terminal', limit: 600, windowSeconds: 60 };

/** Offline sync (ADR-0015). Terminal routes authenticate with the terminal credential, not a user token. */
@Controller()
export class SyncController {
  constructor(@Inject(SyncService) private readonly sync: SyncService) {}

  @TerminalAuth()
  @RateLimit(TERMINAL_LIMIT)
  @Get('terminal/snapshot')
  async snapshot(@Req() req: AuthedRequest) {
    return this.sync.snapshot(await this.sync.authenticate((h) => req.header(h), req.correlationId));
  }

  @TerminalAuth()
  @RateLimit(TERMINAL_LIMIT)
  @HttpCode(200)
  @Post('sync/sales')
  async syncSales(@Req() req: AuthedRequest, @Body(new ZodPipe(syncSalesRequestSchema)) body: SyncSalesRequest) {
    const terminal = await this.sync.authenticate((h) => req.header(h), req.correlationId);
    return { results: await this.sync.syncSales(terminal, body.sales) };
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
