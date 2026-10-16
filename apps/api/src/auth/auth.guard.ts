import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withTenant } from '@1pos/database';
import type { Pool } from 'pg';
import { enrichLogContext } from '@1pos/observability';
import { isPermissionCode, type PermissionCode } from '@1pos/validation';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { AuthContext, AuthedRequest, IS_PUBLIC, REQUIRED_PERMISSIONS, REQUIRES_TENANT } from './auth-context.js';
import { Grant, hasPermission } from './authorization.js';
import { InvalidTokenError, TokenService } from './token.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Authentication required', HttpStatus.UNAUTHORIZED);

/**
 * Global guard. Every non-@Public route: verify JWT → re-validate session, user,
 * membership and tenant status in the DB (so logout/suspension apply immediately)
 * → load grants under RLS → enforce @RequirePermissions at tenant scope.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(DatabasePool) private readonly database: DatabasePool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthenticated();

    let claims;
    try {
      claims = await this.tokens.verifyAccess(header.slice(7));
    } catch (e) {
      if (e instanceof InvalidTokenError) throw unauthenticated();
      throw e;
    }

    const { rows } = await this.database.pool.query<{
      session_active: boolean;
      user_active: boolean;
      membership_id: string | null;
      tenant_status: string | null;
    }>('SELECT * FROM auth_resolve_context($1, $2, $3)', [claims.sub, claims.sid, claims.tid]);
    const ctx = rows[0];
    if (!ctx?.session_active || !ctx.user_active) throw unauthenticated();

    const auth: AuthContext = { userId: claims.sub, sessionId: claims.sid, correlationId: req.correlationId, tenant: null };

    if (claims.tid) {
      if (!ctx.membership_id || !ctx.tenant_status || !['ACTIVE', 'SUSPENDED'].includes(ctx.tenant_status)) {
        throw new AppError('TENANT_ACCESS_REVOKED', 'You no longer have access to this business', HttpStatus.FORBIDDEN);
      }
      const grants = await loadGrants(this.database.pool, claims.tid, ctx.membership_id, claims.sub);
      auth.tenant = { tenantId: claims.tid, membershipId: ctx.membership_id, status: ctx.tenant_status, grants };
    }
    req.auth = auth;
    // Only verified ids go into logs: the tenant after membership was re-checked above.
    enrichLogContext({ userId: auth.userId, tenantId: auth.tenant?.tenantId });

    const required = this.reflector.getAllAndOverride<PermissionCode[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const needsTenant = required.length > 0 || this.reflector.getAllAndOverride<boolean>(REQUIRES_TENANT, targets);
    if (!needsTenant) return true;

    if (!auth.tenant) {
      throw new AppError('TENANT_REQUIRED', 'Select a business first', HttpStatus.FORBIDDEN);
    }
    // Suspended tenants keep read access to their records (legal retention) but cannot write.
    if (auth.tenant.status === 'SUSPENDED' && !SAFE_METHODS.has(req.method)) {
      throw new AppError('TENANT_SUSPENDED', 'This business is suspended; records are read-only', HttpStatus.FORBIDDEN);
    }
    const missing = required.filter((p) => !hasPermission(auth.tenant!.grants, p));
    if (missing.length > 0) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing });
    }
    return true;
  }
}

/** A member's grants in a tenant, read under RLS (the guard, and the cashier behind an offline sale). */
export function loadGrants(pool: Pool, tenantId: string, membershipId: string, userId: string): Promise<Grant[]> {
  return withTenant(
    pool,
    tenantId,
    async (_db, client) => {
      const { rows } = await client.query<{ permission_code: string; scope_type: Grant['scopeType']; scope_id: string | null }>(
        `SELECT DISTINCT rp.permission_code, mr.scope_type, mr.scope_id
           FROM membership_roles mr
           JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.archived_at IS NULL
           JOIN role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
          WHERE mr.membership_id = $1`,
        [membershipId],
      );
      return rows
        .filter((r) => isPermissionCode(r.permission_code))
        .map((r) => ({ permission: r.permission_code as PermissionCode, scopeType: r.scope_type, scopeId: r.scope_id }));
    },
    { userId },
  );
}
