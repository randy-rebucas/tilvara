import { Controller, Get, Inject, Injectable, Query } from '@nestjs/common';
import { and, auditLogs, desc, eq, sql, users } from '@1pos/database';
import { auditLogQuerySchema, type AuditLogQuery } from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { TenantService, type ConflictMap } from '../common/tenant-service.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';

/** Philippine businesses: the audit log's dates are Manila days (no DST). */
const ZONE = 'Asia/Manila';
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The business's own audit log (append-only; RLS shows this business's rows only, never the
 * platform's NULL-tenant rows). Read-only, for whoever holds audit.read for the whole business.
 */
@Injectable()
export class AuditLogService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  list(auth: AuthContext, q: AuditLogQuery) {
    this.assertCan(auth, 'audit.read');
    return this.read(auth, async (db) => {
      const rows = await db
        .select({ log: auditLogs, actorName: users.displayName })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(
          and(
            q.from ? sql`${auditLogs.occurredAt} >= (${q.from}::date)::timestamp AT TIME ZONE ${ZONE}` : undefined,
            q.to ? sql`${auditLogs.occurredAt} < ((${q.to}::date + 1)::timestamp AT TIME ZONE ${ZONE})` : undefined,
            q.action ? sql`${auditLogs.action} LIKE ${`${escapeLike(q.action)}%`}` : undefined,
            q.actorUserId ? eq(auditLogs.actorUserId, q.actorUserId) : undefined,
            q.resourceType ? eq(auditLogs.resourceType, q.resourceType) : undefined,
            q.resourceId ? eq(auditLogs.resourceId, q.resourceId) : undefined,
            q.cursor ? sql`${auditLogs.id} < ${q.cursor}` : undefined,
          ),
        )
        .orderBy(desc(auditLogs.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return {
        data: page.map(({ log, actorName }) => ({ ...log, actorName })),
        nextCursor: rows.length > q.limit ? page[page.length - 1]!.log.id : null,
      };
    });
  }
}

@RequireTenant()
@Controller()
export class AuditLogController {
  constructor(@Inject(AuditLogService) private readonly audit: AuditLogService) {}

  @Get('audit-logs')
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(auditLogQuerySchema)) q: AuditLogQuery) {
    return this.audit.list(auth, q);
  }
}
