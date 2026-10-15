import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { membershipRoles, rolePermissions, roles, tenantMemberships, type Tx } from '@1pos/database';
import {
  ROLE_TEMPLATES,
  type AuthResponse,
  type LoginInput,
  type MembershipSummary,
  type SignupInput,
  type TokenPair,
} from '@1pos/validation';
import { recordAudit } from '../audit/audit.js';
import { seedCatalogDefaults } from '../catalog/catalog-defaults.js';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import type { AuthContext } from './auth-context.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

const invalidCredentials = () =>
  new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect', HttpStatus.UNAUTHORIZED);

interface PgError {
  code?: string;
  constraint?: string;
}

function pgCause(e: unknown): PgError {
  const err = e as PgError & { cause?: PgError };
  return err.cause ?? err;
}

export interface RequestMeta {
  userAgent?: string | undefined;
  correlationId?: string | undefined;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabasePool) private readonly database: DatabasePool,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  /** Self-service onboarding: user + tenant + system roles + owner membership, atomically. */
  async signup(input: SignupInput, meta: RequestMeta): Promise<AuthResponse> {
    const passwordHash = await this.passwords.hash(input.password);
    let ids: { userId: string; tenantId: string };
    try {
      ids = await this.tenantDb.tx(
        async (tx) => {
          const userId = await this.scalar<string>(tx, 'SELECT auth_register_user($1, $2, $3) AS v', [
            input.email,
            input.displayName,
            passwordHash,
          ]);
          await tx.setUser(userId);
          const tenantId = await this.scalar<string>(tx, `SELECT platform_create_tenant($1, $2, 'Asia/Manila', 'PHP') AS v`, [
            input.tenantSlug,
            input.businessName,
          ]);
          await tx.setTenant(tenantId);
          await this.seedTenantAccess(tx, tenantId, userId, meta.correlationId);
          await seedCatalogDefaults(tx.db, tenantId);
          return { userId, tenantId };
        },
        { correlationId: meta.correlationId },
      );
    } catch (e) {
      const pg = pgCause(e);
      if (pg.code === '23505' && pg.constraint === 'users_email_unique') {
        throw new AppError('EMAIL_UNAVAILABLE', 'An account with this email already exists', HttpStatus.CONFLICT);
      }
      if (pg.code === '23505' && pg.constraint === 'tenants_slug_unique') {
        throw new AppError('SLUG_UNAVAILABLE', 'This business URL is already taken', HttpStatus.CONFLICT);
      }
      throw e;
    }
    return this.issueSession(ids.userId, ids.tenantId, meta);
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthResponse> {
    const { rows } = await this.database.pool.query<{
      user_id: string;
      password_hash: string;
      status: string;
      locked_until: Date | null;
    }>('SELECT * FROM auth_get_login_record($1)', [input.email]);
    const rec = rows[0];
    if (!rec) {
      await this.passwords.verifyAgainstDummy(input.password);
      throw invalidCredentials();
    }
    if (rec.locked_until && rec.locked_until.getTime() > Date.now()) {
      const retryAfter = Math.ceil((rec.locked_until.getTime() - Date.now()) / 1000);
      throw new AppError('TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS, {
        retryAfterSeconds: retryAfter,
      });
    }
    const ok = await this.passwords.verify(input.password, rec.password_hash);
    await this.database.pool.query('SELECT auth_record_login_result($1, $2)', [rec.user_id, ok]);
    if (!ok || rec.status !== 'ACTIVE') throw invalidCredentials();

    const memberships = await this.memberships(rec.user_id);
    let tenantId: string | null = null;
    if (input.tenantId) {
      if (!memberships.some((m) => m.tenantId === input.tenantId)) throw this.notMember();
      tenantId = input.tenantId;
    } else if (memberships.length === 1) {
      tenantId = memberships[0]!.tenantId;
    }
    if (tenantId) {
      await this.tenantDb.tx(
        async (tx) => {
          await tx.setTenant(tenantId);
          await recordAudit(tx.db, {
            tenantId,
            actorUserId: rec.user_id,
            action: 'auth.login',
            resourceType: 'user',
            resourceId: rec.user_id,
            correlationId: meta.correlationId,
          });
        },
        { userId: rec.user_id, correlationId: meta.correlationId },
      );
    }
    return this.issueSession(rec.user_id, tenantId, meta, memberships);
  }

  async refresh(refreshToken: string, tenantId: string | undefined): Promise<{ activeTenantId: string | null; tokens: TokenPair }> {
    const next = this.tokens.newRefreshToken();
    const { rows } = await this.database.pool.query<{ outcome: string; user_id: string | null; family_id: string | null }>(
      'SELECT * FROM auth_rotate_session($1, $2, $3)',
      [TokenService.hashRefresh(refreshToken), next.hash, next.expiresAt],
    );
    const r = rows[0]!;
    if (r.outcome !== 'ROTATED') {
      throw new AppError('INVALID_REFRESH_TOKEN', 'Session expired. Please sign in again.', HttpStatus.UNAUTHORIZED);
    }
    let activeTenantId: string | null = null;
    if (tenantId) {
      const memberships = await this.memberships(r.user_id!);
      if (!memberships.some((m) => m.tenantId === tenantId)) throw this.notMember();
      activeTenantId = tenantId;
    }
    const access = await this.tokens.signAccess({ sub: r.user_id!, sid: r.family_id!, tid: activeTenantId });
    return {
      activeTenantId,
      tokens: {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt.toISOString(),
        refreshToken: next.token,
        refreshTokenExpiresAt: next.expiresAt.toISOString(),
      },
    };
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.database.pool.query('SELECT auth_revoke_session($1, $2, $3)', [auth.sessionId, auth.userId, 'LOGOUT']);
  }

  /** New access token for another tenant within the same session (refresh token unchanged). */
  async switchTenant(auth: AuthContext, tenantId: string): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
    const memberships = await this.memberships(auth.userId);
    if (!memberships.some((m) => m.tenantId === tenantId)) throw this.notMember();
    const access = await this.tokens.signAccess({ sub: auth.userId, sid: auth.sessionId, tid: tenantId });
    return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString() };
  }

  async memberships(userId: string): Promise<MembershipSummary[]> {
    const { rows } = await this.database.pool.query<{
      membership_id: string;
      tenant_id: string;
      tenant_slug: string;
      tenant_name: string;
      tenant_status: string;
    }>('SELECT * FROM auth_list_memberships($1)', [userId]);
    return rows.map((r) => ({
      membershipId: r.membership_id,
      tenantId: r.tenant_id,
      tenantSlug: r.tenant_slug,
      tenantName: r.tenant_name,
      tenantStatus: r.tenant_status,
    }));
  }

  /** Create a session and token pair (also used by invitation acceptance). */
  async issueSession(
    userId: string,
    tenantId: string | null,
    meta: RequestMeta,
    memberships?: MembershipSummary[],
  ): Promise<AuthResponse> {
    const refresh = this.tokens.newRefreshToken();
    const family = await this.database.pool.query<{ v: string }>('SELECT auth_create_session($1, $2, $3, $4) AS v', [
      userId,
      refresh.hash,
      refresh.expiresAt,
      meta.userAgent ?? null,
    ]);
    const access = await this.tokens.signAccess({ sub: userId, sid: family.rows[0]!.v, tid: tenantId });
    const user = await this.tenantDb.tx(
      async (tx) => {
        const { rows } = await tx.client.query<{ id: string; email: string; display_name: string }>(
          'SELECT id, email, display_name FROM users WHERE id = $1',
          [userId],
        );
        return rows[0]!;
      },
      { userId },
    );
    return {
      user: { id: user.id, email: user.email, displayName: user.display_name },
      activeTenantId: tenantId,
      memberships: memberships ?? (await this.memberships(userId)),
      tokens: {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt.toISOString(),
        refreshToken: refresh.token,
        refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
      },
    };
  }

  private async seedTenantAccess(tx: Tx, tenantId: string, userId: string, correlationId: string | undefined): Promise<void> {
    const created = await tx.db
      .insert(roles)
      .values(ROLE_TEMPLATES.map((t) => ({ tenantId, key: t.key, name: t.name, isSystem: true })))
      .returning({ id: roles.id, key: roles.key });
    const idByKey = new Map(created.map((r) => [r.key, r.id]));
    await tx.db.insert(rolePermissions).values(
      ROLE_TEMPLATES.flatMap((t) => t.permissions.map((p) => ({ tenantId, roleId: idByKey.get(t.key)!, permissionCode: p }))),
    );
    const [membership] = await tx.db
      .insert(tenantMemberships)
      .values({ tenantId, userId, status: 'ACTIVE' })
      .returning({ id: tenantMemberships.id });
    await tx.db
      .insert(membershipRoles)
      .values({ tenantId, membershipId: membership!.id, roleId: idByKey.get('owner')!, scopeType: 'TENANT', scopeId: null });
    await recordAudit(tx.db, {
      tenantId,
      actorUserId: userId,
      action: 'tenant.onboarded',
      resourceType: 'tenant',
      resourceId: tenantId,
      correlationId,
      metadata: { ownerMembershipId: membership!.id, roles: created.map((r) => r.key) },
    });
  }

  private async scalar<T>(tx: Tx, sql: string, params: unknown[]): Promise<T> {
    const { rows } = await tx.client.query<{ v: T }>(sql, params);
    return rows[0]!.v;
  }

  private notMember(): AppError {
    return new AppError('NOT_A_MEMBER', 'You are not a member of this business', HttpStatus.FORBIDDEN);
  }
}
