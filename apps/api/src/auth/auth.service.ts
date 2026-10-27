import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { membershipRoles, tenantMemberships, type BusinessType, type PlanFeature, type Tx } from '@1pos/database';
import {
  isSubdomainSlug,
  roleTemplatesFor,
  type AuthResponse,
  type LoginInput,
  type LoginResponse,
  type MembershipSummary,
  type MfaVerifyInput,
  type SignupInput,
  type TokenPair,
} from '@1pos/validation';
import { recordAudit } from '../audit/audit.js';
import { seedCatalogDefaults } from '../catalog/catalog-defaults.js';
import { TRIAL_DAYS, TRIAL_PLAN } from '../billing/entitlements.js';
import { emitEvent } from '../outbox/outbox.js';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import type { AuthContext } from './auth-context.js';
import { PasswordService } from './password.service.js';
import { addRoleTemplates } from './role-templates.js';
import { InvalidTokenError, TokenService } from './token.service.js';
import { hashRecoveryCode, matchTotp, SecretBox } from './totp.js';

/** How long a handoff to a business's own address may wait to be redeemed (session 41). */
const HANDOFF_TTL_MS = 60_000;

const invalidCredentials = () =>
  new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect', HttpStatus.UNAUTHORIZED);

const invalidChallenge = () =>
  new AppError('INVALID_MFA_CHALLENGE', 'Your sign-in expired. Enter your email and password again.', HttpStatus.UNAUTHORIZED);

function assertNotLocked(lockedUntil: Date | null): void {
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    const retryAfter = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
    throw new AppError('TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS, {
      retryAfterSeconds: retryAfter,
    });
  }
}

export interface MfaFactorRow {
  secret_ciphertext: string | null;
  confirmed: boolean | null;
  last_used_step: number | null;
  recovery_codes_left: number | null;
  user_status: string;
  locked_until: Date | null;
}

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


/** The business's look as every screen needs it (the band, the till); the images by hash, fetched apart. */
export interface MeBranding {
  displayName: string | null;
  brandColor: string | null;
  logoSha256: string | null;
  backgroundSha256: string | null;
}
@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabasePool) private readonly database: DatabasePool,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(SecretBox) private readonly secrets: SecretBox,
  ) {}

  /** Self-service onboarding: user + tenant + system roles + owner membership, atomically. */
  async signup(input: SignupInput, meta: RequestMeta): Promise<AuthResponse> {
    // The slug is also the business's subdomain (session 40): Tilvara's own names and non-DNS labels are refused.
    if (!isSubdomainSlug(input.tenantSlug)) {
      throw new AppError('SLUG_RESERVED', 'This business URL cannot be used', HttpStatus.UNPROCESSABLE_ENTITY);
    }
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
          await tx.client.query('UPDATE tenants SET business_type = $1 WHERE id = $2', [input.businessType, tenantId]);
          await this.seedTenantAccess(tx, tenantId, userId, meta.correlationId);
          await seedCatalogDefaults(tx.db, tenantId);
          await tx.client.query('SELECT platform_start_trial($1, $2, $3)', [tenantId, TRIAL_PLAN, TRIAL_DAYS]);
          await emitEvent(tx.db, {
            tenantId,
            topic: 'tenant.onboarded',
            payload: { ownerUserId: userId, businessType: input.businessType },
            correlationId: meta.correlationId,
          });
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

  async login(input: LoginInput, meta: RequestMeta): Promise<LoginResponse> {
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
    assertNotLocked(rec.locked_until);
    const ok = await this.passwords.verify(input.password, rec.password_hash);
    if (!ok || rec.status !== 'ACTIVE') {
      if (!ok) await this.recordLoginResult(rec.user_id, false);
      throw invalidCredentials();
    }

    const memberships = await this.memberships(rec.user_id);
    const tenantId = this.pickTenant(memberships, input.tenantId);
    // With two-step sign-in the password alone resets nothing: failed codes keep counting towards the lock.
    if ((await this.mfaFactor(rec.user_id))?.confirmed) {
      const challenge = await this.tokens.signMfaChallenge(rec.user_id, tenantId);
      return { mfaRequired: true, challengeToken: challenge.token, challengeExpiresAt: challenge.expiresAt.toISOString() };
    }
    await this.recordLoginResult(rec.user_id, true);
    return this.completeLogin(rec.user_id, tenantId, meta, memberships, false);
  }

  /** Second step: a code from the authenticator app (each time step once) or one recovery code. */
  async verifyMfa(input: MfaVerifyInput, meta: RequestMeta): Promise<AuthResponse> {
    let claims: { userId: string; tenantId: string | null };
    try {
      claims = await this.tokens.verifyMfaChallenge(input.challengeToken);
    } catch (e) {
      if (e instanceof InvalidTokenError) throw invalidChallenge();
      throw e;
    }
    const factor = await this.mfaFactor(claims.userId);
    if (!factor?.confirmed || factor.user_status !== 'ACTIVE') throw invalidChallenge();
    assertNotLocked(factor.locked_until);

    let ok: boolean;
    if (input.code !== undefined) {
      const step = matchTotp(this.secrets.open(factor.secret_ciphertext!), input.code);
      ok = step !== null && (await this.scalarPool<boolean>('SELECT auth_mfa_use_step($1, $2) AS v', [claims.userId, step]));
    } else {
      const left = await this.scalarPool<number>('SELECT auth_mfa_use_recovery($1, $2, $3) AS v', [
        claims.userId,
        hashRecoveryCode(input.recoveryCode!),
        meta.correlationId ?? null,
      ]);
      ok = left >= 0;
    }
    if (!ok) {
      await this.recordLoginResult(claims.userId, false);
      throw new AppError('INVALID_MFA_CODE', 'That code is not right. Try the newest code from your app.', HttpStatus.UNAUTHORIZED);
    }
    await this.recordLoginResult(claims.userId, true);
    const memberships = await this.memberships(claims.userId);
    // Membership may have changed during the 5 minutes: re-check.
    const tenantId = claims.tenantId && memberships.some((m) => m.tenantId === claims.tenantId) ? claims.tenantId : this.pickTenant(memberships);
    return this.completeLogin(claims.userId, tenantId, meta, memberships, true);
  }

  /**
   * A second person confirming an action at someone else's counter (a price override, session 20):
   * the same checks as signing in — lockout, password, the account active, the 6-digit code when they
   * use two-step sign-in — without opening a session. Failures count towards their lockout. Answers
   * 403 rather than 401, so the cashier's own sign-in is not taken for expired. Returns the user id.
   */
  async verifySecondPerson(email: string, password: string, code: string | undefined, tenantId: string): Promise<string> {
    const refused = () => new AppError('APPROVER_INVALID_CREDENTIALS', 'Email or password is incorrect', HttpStatus.FORBIDDEN);
    const { rows } = await this.database.pool.query<{ user_id: string; password_hash: string; status: string; locked_until: Date | null }>(
      'SELECT * FROM auth_get_login_record($1)',
      [email],
    );
    const rec = rows[0];
    // Someone outside this business is answered as an unknown email, before their password is looked at
    // (session 40): the till must not test other businesses' passwords, nor lock their accounts.
    if (!rec || !(await this.memberOf(tenantId, rec.user_id))) {
      await this.passwords.verifyAgainstDummy(password);
      throw refused();
    }
    assertNotLocked(rec.locked_until);
    const ok = await this.passwords.verify(password, rec.password_hash);
    if (!ok || rec.status !== 'ACTIVE') {
      if (!ok) await this.recordLoginResult(rec.user_id, false);
      throw refused();
    }
    const factor = await this.mfaFactor(rec.user_id);
    if (factor?.confirmed) {
      if (code === undefined) throw new AppError('APPROVER_CODE_REQUIRED', 'Enter the code from the approver\'s authenticator app', HttpStatus.FORBIDDEN);
      const step = matchTotp(this.secrets.open(factor.secret_ciphertext!), code);
      const used = step !== null && (await this.scalarPool<boolean>('SELECT auth_mfa_use_step($1, $2) AS v', [rec.user_id, step]));
      if (!used) {
        await this.recordLoginResult(rec.user_id, false);
        throw new AppError('APPROVER_INVALID_CODE', 'That code is not right. Try the newest code from the app.', HttpStatus.FORBIDDEN);
      }
    }
    await this.recordLoginResult(rec.user_id, true);
    return rec.user_id;
  }

  private pickTenant(memberships: MembershipSummary[], requested?: string): string | null {
    if (requested) {
      if (!memberships.some((m) => m.tenantId === requested)) throw this.notMember();
      return requested;
    }
    return memberships.length === 1 ? memberships[0]!.tenantId : null;
  }

  private async completeLogin(
    userId: string,
    tenantId: string | null,
    meta: RequestMeta,
    memberships: MembershipSummary[],
    mfa: boolean,
  ): Promise<AuthResponse> {
    if (tenantId) {
      await this.tenantDb.tx(
        async (tx) => {
          await tx.setTenant(tenantId);
          await recordAudit(tx.db, {
            tenantId,
            actorUserId: userId,
            action: 'auth.login',
            resourceType: 'user',
            resourceId: userId,
            correlationId: meta.correlationId,
            metadata: { mfa },
          });
        },
        { userId, correlationId: meta.correlationId },
      );
    }
    return this.issueSession(userId, tenantId, meta, memberships, mfa);
  }

  private async recordLoginResult(userId: string, ok: boolean): Promise<void> {
    await this.database.pool.query('SELECT auth_record_login_result($1, $2)', [userId, ok]);
  }

  async mfaFactor(userId: string): Promise<MfaFactorRow | undefined> {
    const { rows } = await this.database.pool.query<MfaFactorRow>('SELECT * FROM auth_mfa_get($1)', [userId]);
    return rows[0];
  }

  private async scalarPool<T>(sql: string, params: unknown[]): Promise<T> {
    const { rows } = await this.database.pool.query<{ v: T }>(sql, params);
    return rows[0]!.v;
  }

  /**
   * The database checks membership before rotating (a refresh for a business the person left keeps the
   * session), and keeps a hand-off session to its own business (another one ends it, migration 0126).
   */
  async refresh(refreshToken: string, tenantId: string | undefined): Promise<{ activeTenantId: string | null; tokens: TokenPair }> {
    const next = this.tokens.newRefreshToken();
    const { rows } = await this.database.pool.query<{
      outcome: string;
      user_id: string | null;
      family_id: string | null;
      active_tenant_id: string | null;
    }>('SELECT * FROM auth_rotate_session($1, $2, $3, $4)', [TokenService.hashRefresh(refreshToken), next.hash, next.expiresAt, tenantId ?? null]);
    const r = rows[0]!;
    if (r.outcome === 'NOT_A_MEMBER') throw this.notMember();
    if (r.outcome !== 'ROTATED') {
      throw new AppError('INVALID_REFRESH_TOKEN', 'Session expired. Please sign in again.', HttpStatus.UNAUTHORIZED);
    }
    const activeTenantId = r.active_tenant_id;
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
    if (auth.tenant) await this.tenantAudit(auth.tenant.tenantId, auth.userId, 'auth.logout', auth.correlationId);
    else await this.platformEvent(auth.userId, 'auth.logout', {}, auth.correlationId);
  }

  /** New access token for another tenant within the same session (refresh token unchanged). */
  async switchTenant(auth: AuthContext, tenantId: string): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
    const memberships = await this.memberships(auth.userId);
    if (!memberships.some((m) => m.tenantId === tenantId)) throw this.notMember();
    const access = await this.tokens.signAccess({ sub: auth.userId, sid: auth.sessionId, tid: tenantId });
    await this.tenantAudit(tenantId, auth.userId, 'auth.switch_tenant', auth.correlationId);
    return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString() };
  }

  /**
   * A one-time sign-in for this session's business on its own address, `<slug>.<shop domain>` (session 41):
   * the admin's cookies belong to one address, so after signing in on the main one the browser carries this
   * code there. It is the refresh token of a new session that lasts 60 s, redeemed by the ordinary refresh
   * (one use: a second is refresh-token reuse and ends that session). It keeps this session's two-step mark.
   * Only for a business whose own sign-in page is on, and never for a support session or an API key.
   */
  async handoff(auth: AuthContext, meta: RequestMeta): Promise<{ code: string; expiresAt: string; tenantSlug: string }> {
    if (!auth.tenant || auth.support || auth.apiKey) {
      throw new AppError('FORBIDDEN', 'Choose a business first', HttpStatus.FORBIDDEN);
    }
    const tenantId = auth.tenant.tenantId;
    const shop = await this.tenantDb.tx(
      async (tx) => {
        await tx.setTenant(tenantId);
        const { rows } = await tx.client.query<{ slug: string; public_sign_in: boolean | null }>(
          'SELECT t.slug, b.public_sign_in FROM tenants t LEFT JOIN tenant_branding b ON b.tenant_id = t.id WHERE t.id = $1',
          [tenantId],
        );
        return rows[0];
      },
      { userId: auth.userId, correlationId: auth.correlationId },
    );
    if (!shop?.public_sign_in || !isSubdomainSlug(shop.slug)) {
      throw new AppError('NO_OWN_ADDRESS', 'This business has no address of its own', HttpStatus.CONFLICT);
    }
    const code = this.tokens.newRefreshToken();
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
    // Bound to this business and to this session (migration 0126): redeemed for another business it ends,
    // and signing out here ends it too. The two-step mark is the parent session's.
    await this.tenantDb.tx(
      (tx) =>
        tx.client.query('SELECT auth_create_handoff_session($1, $2, $3, $4, $5, $6)', [
          auth.sessionId,
          auth.userId,
          tenantId,
          code.hash,
          expiresAt,
          meta.userAgent ?? null,
        ]),
      { userId: auth.userId, correlationId: auth.correlationId },
    );
    await this.tenantAudit(tenantId, auth.userId, 'auth.handoff', auth.correlationId);
    return { code: code.token, expiresAt: expiresAt.toISOString(), tenantSlug: shop.slug };
  }

  private tenantAudit(tenantId: string, userId: string, action: string, correlationId: string | undefined): Promise<void> {
    return this.tenantDb.tx(
      async (tx) => {
        await tx.setTenant(tenantId);
        await recordAudit(tx.db, { tenantId, actorUserId: userId, action, resourceType: 'user', resourceId: userId, correlationId });
      },
      { userId, correlationId },
    );
  }

  /** An account event outside any tenant (visible to no tenant; ADR-0016). */
  async platformEvent(userId: string, action: string, metadata: Record<string, unknown>, correlationId: string | undefined): Promise<void> {
    await this.database.pool.query('SELECT auth_record_event($1, $2, $3, $4)', [userId, action, metadata, correlationId ?? null]);
  }

  /** The signed-in user's own profile (RLS: a user can always read themself). */
  profile(userId: string): Promise<{ email: string; displayName: string }> {
    return this.tenantDb.tx(
      async (tx) => {
        const { rows } = await tx.client.query<{ email: string; display_name: string }>(
          'SELECT email, display_name FROM users WHERE id = $1',
          [userId],
        );
        return { email: rows[0]!.email, displayName: rows[0]!.display_name };
      },
      { userId },
    );
  }

  /** An active Tilvara support staff account (ADR-0016 slice 6). */
  async isStaff(userId: string): Promise<boolean> {
    return this.scalarPool<boolean>('SELECT auth_staff_active($1) AS v', [userId]);
  }

  /**
   * The business's name, type, the features its plan includes, its usable extensions (what the
   * screens offer) and its look (session 39), read in its own context (support sessions have no membership row).
   */
  tenantProfile(tenantId: string, auth: AuthContext): Promise<{ name: string; businessType: BusinessType; features: PlanFeature[]; extensions: string[]; branding: MeBranding }> {
    return this.tenantDb.tx(
      async (tx) => {
        await tx.setTenant(tenantId);
        const { rows } = await tx.client.query<{
          name: string; business_type: BusinessType; features: PlanFeature[] | null; extensions: string[];
          display_name: string | null; brand_color: string | null; logo_sha256: string | null; background_sha256: string | null;
        }>(
          `SELECT t.name, t.business_type, p.features, app_usable_extensions() AS extensions,
                  b.display_name, b.brand_color, l.sha256 AS logo_sha256, g.sha256 AS background_sha256
             FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id LEFT JOIN plans p ON p.code = s.plan_code
             LEFT JOIN tenant_branding b ON b.tenant_id = t.id
             LEFT JOIN brand_assets l ON l.tenant_id = t.id AND l.id = b.logo_asset_id
             LEFT JOIN brand_assets g ON g.tenant_id = t.id AND g.id = b.background_asset_id
            WHERE t.id = $1`,
          [tenantId],
        );
        return {
          name: rows[0]?.name ?? '',
          businessType: rows[0]?.business_type ?? 'RETAIL',
          features: rows[0]?.features ?? [],
          extensions: rows[0]?.extensions ?? [],
          branding: {
            displayName: rows[0]?.display_name ?? null,
            brandColor: rows[0]?.brand_color ?? null,
            logoSha256: rows[0]?.logo_sha256 ?? null,
            backgroundSha256: rows[0]?.background_sha256 ?? null,
          },
        };
      },
      { userId: auth.userId, correlationId: auth.correlationId },
    );
  }

  /**
   * Every business of the signed-in person, or of the person a password or code just proved. The database
   * answers only for `app.user_id` (migration 0126); someone else's membership of this business is
   * `memberOf`'s question.
   */
  async memberships(userId: string): Promise<MembershipSummary[]> {
    const rows = await this.tenantDb.tx(
      async (tx) =>
        (
          await tx.client.query<{
            membership_id: string;
            tenant_id: string;
            tenant_slug: string;
            tenant_name: string;
            tenant_status: string;
          }>('SELECT * FROM auth_list_memberships($1)', [userId])
        ).rows,
      { userId },
    );
    return rows.map((r) => ({
      membershipId: r.membership_id,
      tenantId: r.tenant_id,
      tenantSlug: r.tenant_slug,
      tenantName: r.tenant_name,
      tenantStatus: r.tenant_status,
    }));
  }

  /** Someone's active membership of this business (e.g. an approver at the till), read under its RLS. */
  async memberOf(tenantId: string, userId: string): Promise<string | null> {
    return this.tenantDb.tx(async (tx) => {
      await tx.setTenant(tenantId);
      const { rows } = await tx.client.query<{ id: string }>(
        `SELECT m.id FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND t.status IN ('ACTIVE', 'SUSPENDED')`,
        [userId],
      );
      return rows[0]?.id ?? null;
    });
  }

  /** Create a session and token pair (also used by invitation acceptance). */
  async issueSession(
    userId: string,
    tenantId: string | null,
    meta: RequestMeta,
    memberships?: MembershipSummary[],
    mfa = false,
  ): Promise<AuthResponse> {
    const refresh = this.tokens.newRefreshToken();
    const family = await this.database.pool.query<{ v: string }>('SELECT auth_create_session($1, $2, $3, $4, $5) AS v', [
      userId,
      refresh.hash,
      refresh.expiresAt,
      meta.userAgent ?? null,
      mfa,
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

  /** A new business has no extensions, so it gets the base roles. */
  private async seedTenantAccess(tx: Tx, tenantId: string, userId: string, correlationId: string | undefined): Promise<void> {
    const idByKey = await addRoleTemplates(tx.db, tenantId, roleTemplatesFor());
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
      metadata: { ownerMembershipId: membership!.id, roles: [...idByKey.keys()] },
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
