import { sql, type Database } from '@1pos/database';

/** Today in a timezone, by the DB clock (the calendar `post()` dates entries by). */
export async function localToday(db: Database, timezone: string): Promise<string> {
  const { rows } = await db.execute<{ d: string }>(sql`SELECT (now() AT TIME ZONE ${timezone})::date::text AS d`);
  return rows[0]!.d;
}

/** A legal entity's today: the latest local date among its branches (Asia/Manila without one). */
export async function entityToday(db: Database, legalEntityId: string): Promise<string> {
  const { rows } = await db.execute<{ d: string }>(sql`
    SELECT coalesce(max((now() AT TIME ZONE b.timezone)::date), (now() AT TIME ZONE 'Asia/Manila')::date)::text AS d
      FROM branches b WHERE b.legal_entity_id = ${legalEntityId}`);
  return rows[0]!.d;
}
