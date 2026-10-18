import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withTenant } from '@1pos/database';
import type { Pool } from 'pg';
import { enrichLogContext } from '@1pos/observability';
import { isPermissionCode, isPrivilegedSet, SUPPORT_PERMISSIONS, type PermissionCode } from '@1pos/validation';
import type { ServerEnv } from '@1pos/config';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { recordAudit } from '../audit/audit.js';
import { ALLOW_READ_ONLY_BUSINESS, AuthContext, AuthedRequest, IS_PUBLIC, REQUIRED_PERMISSIONS, REQUIRES_TENANT } from './auth-context.js';
import { Grant, hasPermission } from './authorization.js';
import { InvalidTokenError, TokenService } from './token.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Authentication required', HttpStatus.UNAUTHORIZED);

/** A support session reads the whole business; it never writes (ADR-0016 slice 6). */
const SUPPORT_GRANTS: Grant[] = SUPPORT_PERMISSIONS.map((permission) => ({ permission, scopeType: 'TENANT', scopeId: null }));
/** The one write a support token may make: ending its own sign-in. */
const SUPPORT_WRITES = new Set(['/v1/auth/logout']);

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
    @Inject(ENV) private readonly env: ServerEnv,
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
    if (claims.sgr) return this.supportSession(req, claims as Required<typeof claims> & { tid: string }, targets);

    const { rows } = await this.database.pool.query<{
      session_active: boolean;
      user_active: boolean;
      membership_id: string | null;
      tenant_status: string | null;
      session_mfa: boolean;
      mfa_enrolled: boolean;
      privileged_since: Date | null;
    }>('SELECT * FROM auth_resolve_context($1, $2, $3)', [claims.sub, claims.sid, claims.tid]);
    const ctx = rows[0];
    if (!ctx?.session_active || !ctx.user_active) throw unauthenticated();

    const auth: AuthContext = {
      userId: claims.sub,
      sessionId: claims.sid,
      correlationId: req.correlationId,
      tenant: null,
      mfa: { enrolled: ctx.mfa_enrolled, sessionVerified: ctx.session_mfa, required: false, dueAt: null },
    };

    if (claims.tid) {
      if (!ctx.membership_id || !ctx.tenant_status || !['ACTIVE', 'SUSPENDED'].includes(ctx.tenant_status)) {
        throw new AppError('TENANT_ACCESS_REVOKED', 'You no longer have access to this business', HttpStatus.FORBIDDEN);
      }
      const grants = await loadGrants(this.database.pool, claims.tid, ctx.membership_id, claims.sub);
      auth.tenant = { tenantId: claims.tid, membershipId: ctx.membership_id, status: ctx.tenant_status, grants };
      if (isPrivilegedSet(grants.map((g) => g.permission))) {
        auth.mfa.required = true;
        if (!ctx.session_mfa && !ctx.mfa_enrolled) {
          const since = ctx.privileged_since ?? (await this.notePrivileged(claims.sub));
          auth.mfa.dueAt = new Date(since.getTime() + this.env.MFA_GRACE_DAYS * 86_400_000);
        }
      }
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
    // Suspended tenants keep read access to their records (legal retention) but cannot write,
    // except to take a copy of them (offboarding).
    if (auth.tenant.status === 'SUSPENDED' && !SAFE_METHODS.has(req.method) && !this.reflector.getAllAndOverride<boolean>(ALLOW_READ_ONLY_BUSINESS, targets)) {
      throw new AppError('TENANT_SUSPENDED', 'This business is suspended; records are read-only', HttpStatus.FORBIDDEN);
    }
    // Privileged members need a session that passed two-step sign-in: always once they have it
    // (an older session must sign in again), otherwise after the grace period (ADR-0016).
    // /me, sign-out, switching business and the MFA routes need no tenant, so they stay open.
    if (auth.mfa.required && !auth.mfa.sessionVerified) {
      if (auth.mfa.enrolled) {
        throw new AppError('MFA_REQUIRED', 'Sign in again with your authenticator code', HttpStatus.FORBIDDEN, { enrolled: true });
      }
      if (auth.mfa.dueAt && auth.mfa.dueAt.getTime() <= Date.now()) {
        throw new AppError('MFA_REQUIRED', 'Turn on two-step sign-in to continue', HttpStatus.FORBIDDEN, {
          enrolled: false,
          dueAt: auth.mfa.dueAt.toISOString(),
        });
      }
    }
    const missing = required.filter((p) => !hasPermission(auth.tenant!.grants, p));
    if (missing.length > 0) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing });
    }
    return true;
  }

  /**
   * A Tilvara staff member acting under a business's support grant (ADR-0016 slice 6). Every request
   * re-checks the session (two-step sign-in passed), the staff account and the grant, so revoking
   * the grant or disabling the account ends access at the next request. Every request is written to
   * the business's audit log (route template only, never ids or query strings), and every write is
   * refused, even where the read permissions would not have allowed it anyway.
   */
  private async supportSession(
    req: AuthedRequest,
    claims: { sub: string; sid: string; tid: string; sgr: string },
    targets: Parameters<Reflector['getAllAndOverride']>[1],
  ): Promise<boolean> {
    const { rows } = await this.database.pool.query<{
      session_active: boolean;
      session_mfa: boolean;
      staff_active: boolean;
      staff_name: string | null;
      tenant_id: string | null;
      tenant_status: string | null;
      grant_open: boolean;
      expires_at: Date | null;
    }>('SELECT * FROM auth_resolve_support($1, $2, $3)', [claims.sub, claims.sid, claims.sgr]);
    const r = rows[0];
    if (!r?.session_active) throw unauthenticated();
    if (!r.staff_active || !r.session_mfa || !r.grant_open || r.tenant_id !== claims.tid || !['ACTIVE', 'SUSPENDED'].includes(r.tenant_status ?? '')) {
      throw new AppError('SUPPORT_ACCESS_ENDED', 'This support access has ended', HttpStatus.FORBIDDEN);
    }
    const auth: AuthContext = {
      userId: claims.sub,
      sessionId: claims.sid,
      correlationId: req.correlationId,
      tenant: { tenantId: claims.tid, membershipId: null, status: r.tenant_status!, grants: SUPPORT_GRANTS },
      mfa: { enrolled: true, sessionVerified: true, required: false, dueAt: null },
      support: { grantId: claims.sgr, staffName: r.staff_name ?? '', expiresAt: r.expires_at! },
    };
    req.auth = auth;
    enrichLogContext({ userId: auth.userId, tenantId: claims.tid });

    const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
    const write = !SAFE_METHODS.has(req.method) && !SUPPORT_WRITES.has(route);
    await withTenant(
      this.database.pool,
      claims.tid,
      (db) =>
        recordAudit(db, {
          tenantId: claims.tid,
          actorType: 'SUPPORT',
          actorUserId: claims.sub,
          action: write ? 'support.write_refused' : 'support.request',
          resourceType: 'support_grant',
          resourceId: claims.sgr,
          correlationId: req.correlationId ?? null,
          metadata: { method: req.method, route, staffName: r.staff_name },
        }),
      { userId: claims.sub, correlationId: req.correlationId },
    );
    if (write) throw new AppError('SUPPORT_READ_ONLY', 'Support access is read-only', HttpStatus.FORBIDDEN);

    const required = this.reflector.getAllAndOverride<PermissionCode[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const missing = required.filter((p) => !hasPermission(SUPPORT_GRANTS, p));
    if (missing.length > 0) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing });
    }
    return true;
  }

  private async notePrivileged(userId: string): Promise<Date> {
    const { rows } = await this.database.pool.query<{ v: Date }>('SELECT auth_note_privileged($1) AS v', [userId]);
    return rows[0]!.v;
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
