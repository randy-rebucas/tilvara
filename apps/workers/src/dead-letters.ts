import type { Pool } from 'pg';

export interface DeadEvent {
  id: string;
  tenantId: string;
  topic: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  failedAt: Date;
}

/**
 * DEAD outbox events (ADR-0016 slice 3), oldest first, without their payload. Runs as the worker
 * role through `outbox_dead_list()`; nothing else can read across tenants.
 */
export async function listDead(pool: Pool, o: { limit?: number; topic?: string } = {}): Promise<DeadEvent[]> {
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    topic: string;
    attempts: number;
    last_error: string | null;
    created_at: Date;
    failed_at: Date;
  }>('SELECT * FROM outbox_dead_list($1, $2)', [o.limit ?? 50, o.topic ?? null]);
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    topic: r.topic,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    failedAt: r.failed_at,
  }));
}

/**
 * Put a DEAD event back in the queue with a fresh set of attempts. Audited (platform-level row with
 * the actor and the reason). False when the event is not DEAD (already replayed, or unknown id).
 */
export async function replayDead(pool: Pool, id: string, actor: string, reason: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>('SELECT outbox_dead_replay($1, $2, $3) AS ok', [id, actor, reason]);
  return rows[0]?.ok === true;
}
