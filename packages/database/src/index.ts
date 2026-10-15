export * from './schema/index.js';
// Query builders re-exported so apps depend on one database package, not drizzle directly.
export { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
export * from './tenant-context.js';
export * from './platform.js';
export { runMigrations, MIGRATIONS_FOLDER } from './migrate.js';
