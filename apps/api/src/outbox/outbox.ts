import { outboxEvents, type Database } from '@1pos/database';

export interface DomainEvent {
  tenantId: string;
  /** dotted lowercase, e.g. "tenant.onboarded" */
  topic: string;
  /** IDs and non-sensitive facts only — never secrets, tokens, or PII beyond what the consumer strictly needs. */
  payload: Record<string, unknown>;
  correlationId?: string | null | undefined;
}

/**
 * Record an event in the caller's transaction (transactional outbox, ADR-0003). It is
 * delivered by apps/workers at least once after commit — consumers must be idempotent.
 */
export async function emitEvent(db: Database, e: DomainEvent): Promise<void> {
  await db.insert(outboxEvents).values({
    tenantId: e.tenantId,
    topic: e.topic,
    payload: e.payload,
    correlationId: e.correlationId ?? null,
  });
}
