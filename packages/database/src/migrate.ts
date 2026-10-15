import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Apply all pending migrations. Must connect as the schema owner (onepos_migrator). */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) {
    console.error('DATABASE_MIGRATOR_URL is not set');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('Migrations applied'))
    .catch((err: unknown) => {
      console.error('Migration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
