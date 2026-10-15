import { sql, type Database } from '@1pos/database';

/**
 * One clock for effective dating: the database's. Effective-dated rows (prices, tax profiles)
 * are stamped and resolved against DB now(); mixing in the API host's clock misplaces changes
 * made moments ago whenever the clocks drift (they do: Docker VM vs host).
 */
export async function dbNow(db: Database): Promise<Date> {
  const { rows } = await db.execute<{ now: string | Date }>(sql`SELECT now() AS now`);
  return new Date(rows[0]!.now);
}
