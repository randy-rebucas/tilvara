import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import pg from 'pg';

const USAGE = `Tilvara support tool. Connects with ops credentials (DATABASE_MIGRATOR_URL), never the runtime role.

  support mfa-reset --email <owner email> --reason "<how identity was checked>" --ticket <ref> [--actor <name>]
      Clears the two-step sign-in of an owner who lost both their phone and their recovery codes.
      Members other than the owner are reset by an owner or admin on the member's page instead.
      Follow docs/operations/support-mfa-reset.md: verify identity first; every reset is audited.

  support account-disable --email <email> --reason "<why>" --ticket <ref> [--actor <name>]
      Blocks sign-in and ends every session of an account at its next request: a compromised
      account (security-incident.md 2.1) or a data subject's erasure/objection request
      (privacy/data-subject-requests.md). Audited as platform.user.disabled.

  support account-enable --email <email> --reason "<how identity was checked>" --ticket <ref> [--actor <name>]
      Lets a disabled or closed account sign in again (sessions stay ended). Audited.

  support staff-add --email <staff email> --reason "<why>" [--actor <name>]
  support staff-disable --email <staff email> --reason "<why>" [--actor <name>]
  support staff-list
      Tilvara support staff (docs/operations/support-access.md). Staff see a business only while that
      business has given support access; the account must already use two-step sign-in.`;

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
  const commands = ['mfa-reset', 'account-disable', 'account-enable', 'staff-add', 'staff-disable', 'staff-list'];
  if (values.help || !command || !commands.includes(command)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const needed = ['mfa-reset', 'account-disable', 'account-enable'].includes(command) ? (['email', 'reason', 'ticket'] as const) : command === 'staff-list' ? ([] as const) : (['email', 'reason'] as const);
  const missing = needed.filter((k) => !values[k] || values[k]!.trim().length < 3);
  if (missing.length) {
    console.error(`${command} needs ${missing.map((m) => `--${m}`).join(', ')} (recorded in the audit log)`);
    return 2;
  }
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) {
    console.error('DATABASE_MIGRATOR_URL is not set');
    return 2;
  }
  const actor = values.actor ?? userInfo().username;
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    switch (command) {
      case 'mfa-reset': {
        const { rows } = await pool.query<{ v: string | null }>('SELECT auth_mfa_support_reset($1, $2, $3, $4) AS v', [values.email, actor, values.reason, values.ticket]);
        if (!rows[0]!.v) {
          console.error('Nothing reset: no active account with that email uses two-step sign-in.');
          return 1;
        }
        console.log(`Reset two-step sign-in for user ${rows[0]!.v}. Their sessions ended; they set it up again at the next sign-in.`);
        return 0;
      }
      case 'account-disable':
      case 'account-enable': {
        const fn = command === 'account-disable' ? 'platform_account_disable' : 'platform_account_enable';
        const { rows } = await pool.query<{ v: string | null }>(`SELECT ${fn}($1, $2, $3, $4) AS v`, [values.email, actor, values.reason, values.ticket]);
        if (!rows[0]!.v) {
          console.error(`Nothing changed: no ${command === 'account-disable' ? 'active' : 'disabled'} account with that email.`);
          return 1;
        }
        console.log(
          command === 'account-disable'
            ? `Account ${rows[0]!.v} disabled; its sessions end at their next request.`
            : `Account ${rows[0]!.v} can sign in again. Its old sessions stay ended.`,
        );
        return 0;
      }
      case 'staff-add': {
        const { rows } = await pool.query<{ v: string }>('SELECT support_staff_add($1, $2, $3) AS v', [values.email, actor, values.reason]);
        console.log(`Support staff ${rows[0]!.v} is active. They see a business only while it gives support access.`);
        return 0;
      }
      case 'staff-disable': {
        const { rows } = await pool.query<{ v: string | null }>('SELECT support_staff_disable($1, $2, $3) AS v', [values.email, actor, values.reason]);
        if (!rows[0]!.v) {
          console.error('Nothing changed: no active support staff with that email.');
          return 1;
        }
        console.log(`Support staff ${rows[0]!.v} disabled; any support session they hold stops at its next request.`);
        return 0;
      }
      default: {
        const { rows } = await pool.query<{ email: string; display_name: string; status: string; added_at: Date; added_by: string }>('SELECT * FROM support_staff_list()');
        for (const r of rows) console.log(`${r.status.padEnd(8)} ${r.email}  (${r.display_name}; added ${r.added_at.toISOString().slice(0, 10)} by ${r.added_by})`);
        if (rows.length === 0) console.log('No support staff.');
        return 0;
      }
    }
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
