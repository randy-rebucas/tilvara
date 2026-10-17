import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import pg from 'pg';

const USAGE = `1POS support tool. Connects with ops credentials (DATABASE_MIGRATOR_URL), never the runtime role.

  support mfa-reset --email <owner email> --reason "<how identity was checked>" --ticket <ref> [--actor <name>]

Clears the two-step sign-in of an owner who lost both their phone and their recovery codes.
Members other than the owner are reset by an owner or admin on the member's page instead.
Follow docs/operations/support-mfa-reset.md: verify identity first; every reset is audited.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      reason: { type: 'string' },
      ticket: { type: 'string' },
      actor: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command] = positionals;
  if (values.help || command !== 'mfa-reset') {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const missing = (['email', 'reason', 'ticket'] as const).filter((k) => !values[k] || values[k]!.trim().length < 3);
  if (missing.length) {
    console.error(`mfa-reset needs ${missing.map((m) => `--${m}`).join(', ')} (recorded in the audit log)`);
    return 2;
  }
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) {
    console.error('DATABASE_MIGRATOR_URL is not set');
    return 2;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<{ v: string | null }>('SELECT auth_mfa_support_reset($1, $2, $3, $4) AS v', [
      values.email,
      values.actor ?? userInfo().username,
      values.reason,
      values.ticket,
    ]);
    if (!rows[0]!.v) {
      console.error('Nothing reset: no active account with that email uses two-step sign-in.');
      return 1;
    }
    console.log(`Reset two-step sign-in for user ${rows[0]!.v}. Their sessions ended; they set it up again at the next sign-in.`);
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
