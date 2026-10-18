import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, auditLogs, desc, eq, inArray, sql, supportGrants, users } from '@1pos/database';
import type { CreateSupportGrantInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { TokenService } from '../auth/token.service.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

type GrantRow = typeof supportGrants.$inferSelect;

const statusOf = (g: Pick<GrantRow, 'revokedAt' | 'expiresAt'>, now: Date) =>
  g.revokedAt ? 'REVOKED' : g.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'OPEN';

/**
 * Support access (ADR-0016 slice 6, SPEC §13, THREAT_MODEL T14). The business decides: an owner or
 * admin (tenant.manage) gives Tilvara support read-only access for a purpose and 1–72 hours, sees every
 * use of it, and can end it at once. Staff have no standing access to any business.
 */
@Injectable()
export class SupportService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(DatabasePool) private readonly database: DatabasePool,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {
    super(tenantDb);
  }

  // ------------------------------------------------------------------ the business's side
  listGrants(auth: AuthContext) {
    this.assertCan(auth, 'tenant.manage');
    return this.read(auth, async (db) => {
      const rows = await db
        .select({ g: supportGrants, grantedByName: users.displayName })
        .from(supportGrants)
        .leftJoin(users, eq(users.id, supportGrants.grantedBy))
        .orderBy(desc(supportGrants.grantedAt))
        .limit(100);
      const ids = rows.map((r) => r.g.id);
      // What support did with each grant, from the business's own audit log.
      const activity = ids.length
        ? await db
            .select({
              grantId: auditLogs.resourceId,
              opened: sql<number>`count(*) FILTER (WHERE ${auditLogs.action} = 'support.session_opened')::int`,
              requests: sql<number>`count(*) FILTER (WHERE ${auditLogs.action} = 'support.request')::int`,
              refusedWrites: sql<number>`count(*) FILTER (WHERE ${auditLogs.action} = 'support.write_refused')::int`,
              lastUsedAt: sql<string | null>`max(${auditLogs.occurredAt}) FILTER (WHERE ${auditLogs.action} LIKE 'support.%' AND ${auditLogs.actorType} = 'SUPPORT')`,
              staff: sql<string[]>`coalesce(array_agg(DISTINCT ${auditLogs.metadata}->>'staffName') FILTER (WHERE ${auditLogs.action} = 'support.session_opened'), '{}')`,
            })
            .from(auditLogs)
            .where(and(eq(auditLogs.resourceType, 'support_grant'), inArray(auditLogs.resourceId, ids)))
            .groupBy(auditLogs.resourceId)
        : [];
      const byGrant = new Map(activity.map((a) => [a.grantId, a]));
      const { rows: [clock] } = await db.execute<{ now: string }>(sql`SELECT now()::text AS now`);
      const now = new Date(clock!.now);
      return {
        data: rows.map(({ g, grantedByName }) => {
          const a = byGrant.get(g.id);
          return {
            id: g.id,
            purpose: g.purpose,
            ticketRef: g.ticketRef,
            access: g.access,
            status: statusOf(g, now),
            grantedBy: { id: g.grantedBy, name: grantedByName },
            grantedAt: g.grantedAt,
            expiresAt: g.expiresAt,
            revokedAt: g.revokedAt,
            revokeReason: g.revokeReason,
            activity: {
              sessions: a?.opened ?? 0,
              requests: a?.requests ?? 0,
              refusedWrites: a?.refusedWrites ?? 0,
              lastUsedAt: a?.lastUsedAt ? new Date(a.lastUsedAt) : null,
              staff: (a?.staff ?? []).filter(Boolean),
            },
          };
        }),
      };
    });
  }

  createGrant(auth: AuthContext, input: CreateSupportGrantInput) {
    this.assertCan(auth, 'tenant.manage');
    this.assertNotSupport(auth);
    return this.mutate(
      auth,
      async (db) => {
        const [row] = await db
          .insert(supportGrants)
          .values({
            tenantId: tenantOf(auth).tenantId,
            purpose: input.purpose,
            ticketRef: input.ticketRef ?? null,
            grantedBy: auth.userId,
            // The database clock decides the window, and the check constraint holds it to 72 hours.
            grantedAt: sql`now()`,
            expiresAt: sql`now() + make_interval(hours => ${input.hours})`,
          })
          .returning();
        await this.audit(db, auth, 'support.granted', 'support_grant', row!.id, { hours: input.hours, ticketRef: input.ticketRef ?? null });
        return { ...row!, status: 'OPEN' as const };
      },
      { allowReadOnlyBusiness: true },
    );
  }

  revokeGrant(auth: AuthContext, id: string, reason: string | undefined) {
    this.assertCan(auth, 'tenant.manage');
    this.assertNotSupport(auth);
    return this.mutate(
      auth,
      async (db) => {
        const [g] = await db.select().from(supportGrants).where(eq(supportGrants.id, id)).for('update');
        if (!g) throw notFound('Support access');
        const { rows: [clock] } = await db.execute<{ now: string }>(sql`SELECT now()::text AS now`);
        if (statusOf(g, new Date(clock!.now)) !== 'OPEN') {
          throw new AppError('SUPPORT_ACCESS_ENDED', 'This support access has already ended', HttpStatus.CONFLICT);
        }
        const [row] = await db
          .update(supportGrants)
          .set({ revokedAt: sql`now()`, revokedBy: auth.userId, revokeReason: reason ?? null })
          .where(eq(supportGrants.id, id))
          .returning();
        await this.audit(db, auth, 'support.revoked', 'support_grant', id, { reason: reason ?? null });
        return { ...row!, status: 'REVOKED' as const };
      },
      { allowReadOnlyBusiness: true },
    );
  }

  /** A support session never manages support access itself (it is read-only anyway). */
  private assertNotSupport(auth: AuthContext): void {
    if (auth.support) throw new AppError('SUPPORT_READ_ONLY', 'Support access is read-only', HttpStatus.FORBIDDEN);
  }

  // ------------------------------------------------------------------ the staff side
  /** Open grants across businesses, for an active staff member whose session passed two-step sign-in. */
  async openGrants(auth: AuthContext) {
    await this.assertStaff(auth);
    const { rows } = await this.database.pool.query<{
      grant_id: string;
      tenant_id: string;
      tenant_name: string;
      tenant_slug: string;
      purpose: string;
      ticket_ref: string | null;
      granted_at: Date;
      expires_at: Date;
    }>('SELECT * FROM support_list_grants($1)', [auth.userId]);
    return {
      data: rows.map((r) => ({
        id: r.grant_id,
        tenant: { id: r.tenant_id, name: r.tenant_name, slug: r.tenant_slug },
        purpose: r.purpose,
        ticketRef: r.ticket_ref,
        grantedAt: r.granted_at,
        expiresAt: r.expires_at,
      })),
    };
  }

  /**
   * Start a support session: an access token for the grant's business, read-only, that ends with
   * the grant at the latest (AuthGuard re-checks the grant on every request). Recorded on both sides.
   */
  async openGrant(auth: AuthContext, grantId: string) {
    if (auth.support) throw new AppError('SUPPORT_READ_ONLY', 'Support access is read-only', HttpStatus.FORBIDDEN);
    // Anyone who is not active staff learns nothing: the same answer as a grant that does not exist.
    if (!(await this.isStaff(auth.userId))) throw notFound('Support access');
    this.assertVerified(auth);
    const { rows } = await this.database.pool.query<{ tenant_id: string; tenant_name: string; expires_at: Date; purpose: string }>(
      'SELECT * FROM support_open_grant($1, $2, $3, $4)',
      [auth.userId, auth.sessionId, grantId, auth.correlationId ?? null],
    );
    const g = rows[0];
    if (!g) throw notFound('Support access');
    const access = await this.tokens.signAccess({ sub: auth.userId, sid: auth.sessionId, tid: g.tenant_id, sgr: grantId }, g.expires_at);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      grant: { id: grantId, purpose: g.purpose, expiresAt: g.expires_at },
      tenant: { id: g.tenant_id, name: g.tenant_name },
    };
  }

  private async isStaff(userId: string): Promise<boolean> {
    const { rows } = await this.database.pool.query<{ v: boolean }>('SELECT auth_staff_active($1) AS v', [userId]);
    return rows[0]!.v;
  }

  private async assertStaff(auth: AuthContext): Promise<void> {
    if (!(await this.isStaff(auth.userId))) {
      throw new AppError('NOT_SUPPORT_STAFF', 'Only Tilvara support staff can see support requests', HttpStatus.FORBIDDEN);
    }
    this.assertVerified(auth);
  }

  /** Support always needs a session that passed two-step sign-in (staff accounts must have it on). */
  private assertVerified(auth: AuthContext): void {
    if (!auth.mfa.sessionVerified) {
      throw new AppError('MFA_REQUIRED', 'Sign in again with your authenticator code', HttpStatus.FORBIDDEN, { enrolled: auth.mfa.enrolled });
    }
  }
}
