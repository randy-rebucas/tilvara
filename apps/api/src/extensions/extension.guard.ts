import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withTenant } from '@1pos/database';
import { REQUIRES_EXTENSION, type AuthedRequest } from '../auth/auth-context.js';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { extensionNotEnabled } from './gate.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard after `AuthGuard` (ADR-0026): a write to a route marked `@RequiresExtension(code)` is
 * refused unless the business may use that extension. Reads pass, as with plan features.
 */
@Injectable()
export class ExtensionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DatabasePool) private readonly database: DatabasePool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const code = this.reflector.getAllAndOverride<string | undefined>(REQUIRES_EXTENSION, [context.getHandler(), context.getClass()]);
    if (!code) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (SAFE_METHODS.has(req.method)) return true;
    const tenant = req.auth?.tenant;
    if (!tenant) throw new AppError('TENANT_REQUIRED', 'Select a business first', HttpStatus.FORBIDDEN);
    const usable = await withTenant(
      this.database.pool,
      tenant.tenantId,
      async (_db, client) => (await client.query<{ ok: boolean }>('SELECT app_extension_usable($1) AS ok', [code])).rows[0]?.ok ?? false,
      { userId: req.auth!.userId },
    );
    if (!usable) throw extensionNotEnabled(code);
    return true;
  }
}
