import { sql, type Database } from '@1pos/database';

/**
 * One clock for effective dating: the database's. Effective-dated rows (prices, tax profiles)
 * are stamped with DB now() and resolved against it; the API host's clock is never mixed in.
 *
 * Even the DB clock is not monotonic across transactions: VM/NTP resyncs step it backwards
 * (observed ~0.9 s in the Docker dev VM), so a change stamped "now" could read as not yet in
 * force a moment later. "In force now" therefore allows EFFECTIVE_SKEW: a change takes effect
 * at most this much before its timestamp. Sales snapshot what they used, so history is unaffected.
 */
export const EFFECTIVE_SKEW = "interval '5 seconds'";

/** SQL for "now, for effective-date resolution". */
export const effectiveNowSql = sql.raw(`(now() + ${EFFECTIVE_SKEW})`);

/** Plain DB now() (e.g. for the backdating rule). */
export async function dbNow(db: Database): Promise<Date> {
  const { rows } = await db.execute<{ now: string | Date }>(sql`SELECT now() AS now`);
  return new Date(rows[0]!.now);
}

/** DB now() plus the skew allowance, as an instant to resolve effective-dated rows against. */
export async function effectiveNow(db: Database): Promise<Date> {
  const { rows } = await db.execute<{ now: string | Date }>(sql`SELECT ${effectiveNowSql} AS now`);
  return new Date(rows[0]!.now);
}
