import { HttpStatus } from '@nestjs/common';
import { sql, type Database } from '@1pos/database';
import { AppError } from '../infrastructure/http-error.filter.js';

export const extensionNotEnabled = (code: string) =>
  new AppError('EXTENSION_NOT_ENABLED', `The ${code} extension is not switched on for this business`, HttpStatus.FORBIDDEN, { extension: code });

/** The business's usable extensions (ADR-0026): switched on, active in the catalog and allowed by the current plan. */
export async function usableExtensions(db: Database): Promise<string[]> {
  const { rows } = await db.execute<{ v: string[] }>(sql`SELECT app_usable_extensions() AS v`);
  return rows[0]?.v ?? [];
}

/**
 * Inside a tenant transaction: refuse what needs an extension the business may not use. For core code
 * with an extension branch and for extension services; routes take `@RequiresExtension` as well.
 * Never on the offline path: an offline sale is flagged, never refused (ADR-0015, ADR-0026 §5).
 */
export async function assertExtension(db: Database, code: string): Promise<void> {
  const { rows } = await db.execute<{ ok: boolean }>(sql`SELECT app_extension_usable(${code}) AS ok`);
  if (!rows[0]?.ok) throw extensionNotEnabled(code);
}
