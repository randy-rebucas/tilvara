import { sql, type Database } from '@1pos/database';

/**
 * Next value of a gapless per-scope counter (e.g. per-register sale or return numbers), taken
 * under the counter row's lock inside the caller's transaction — a rollback returns the number.
 */
export async function nextNumber(db: Database, tenantId: string, scopeId: string, name: string): Promise<number> {
  const { rows } = await db.execute<{ value: string }>(sql`
    INSERT INTO sequence_counters (tenant_id, scope_id, name, next_value) VALUES (${tenantId}, ${scopeId}, ${name}, 2)
    ON CONFLICT (tenant_id, scope_id, name) DO UPDATE SET next_value = sequence_counters.next_value + 1
    RETURNING (next_value - 1)::text AS value`);
  return Number(rows[0]!.value);
}
