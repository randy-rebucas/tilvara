import pg from 'pg';

/**
 * Drop and recreate the integration-test database (`pnpm test:db:reset`). Every integration run adds
 * rows to `onepos_test` (639 MB on 2026-10-18) and the suites slow down with it; the next suite's
 * global setup migrates the fresh database. Recreated exactly as infra/docker/postgres/init does.
 * Uses DRILL_ADMIN_URL (a superuser login on the dev cluster). Refuses any database but onepos_test.
 */
const TEST_DB = 'onepos_test';

async function main(): Promise<number> {
  const adminUrl = process.env.DRILL_ADMIN_URL;
  const testUrl = process.env.TEST_DATABASE_MIGRATOR_URL;
  if (!adminUrl || !testUrl) {
    console.error('DRILL_ADMIN_URL and TEST_DATABASE_MIGRATOR_URL must be set (see .env.example)');
    return 2;
  }
  if (new URL(testUrl).pathname !== `/${TEST_DB}`) {
    console.error(`TEST_DATABASE_MIGRATOR_URL does not point at ${TEST_DB}; refusing`);
    return 2;
  }
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ size: string }>(`SELECT pg_size_pretty(pg_database_size($1)) AS size FROM pg_database WHERE datname = $1`, [TEST_DB]);
    // FORCE ends any session still connected (a test run that was interrupted).
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB} OWNER onepos_migrator`);
    console.log(`Recreated ${TEST_DB}${rows[0] ? ` (was ${rows[0].size})` : ''}.`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${TEST_DB}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    await db.query('ALTER SCHEMA public OWNER TO onepos_migrator');
    await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await db.query('GRANT USAGE ON SCHEMA public TO onepos_app, onepos_worker, onepos_readonly');
  } finally {
    await db.end();
  }
  console.log('The next integration suite migrates it.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
