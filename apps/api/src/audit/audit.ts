import { auditLogs, type AuditActorType, type Database } from '@1pos/database';

export interface AuditEvent {
  tenantId: string;
  actorType?: AuditActorType;
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  correlationId?: string | null;
  /** Never put secrets, passwords, tokens or customer PII here. */
  metadata?: Record<string, unknown>;
}

/** Write an audit row inside the caller's transaction so it commits or rolls back with the change. */
export async function recordAudit(db: Database, e: AuditEvent): Promise<void> {
  await db.insert(auditLogs).values({
    tenantId: e.tenantId,
    actorType: e.actorType ?? 'USER',
    actorUserId: e.actorUserId ?? null,
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId ?? null,
    correlationId: e.correlationId ?? null,
    metadata: e.metadata ?? {},
  });
}
