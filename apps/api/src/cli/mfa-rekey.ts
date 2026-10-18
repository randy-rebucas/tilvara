import { loadServerEnv } from '@1pos/config';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { rekeyMfaSecrets, UnreadableSecretsError } from '../auth/mfa-rekey.js';
import { SecretBox } from '../auth/totp.js';

const USAGE = `Re-seal every two-step sign-in secret with the current MFA_ENCRYPTION_KEY (runbook: docs/operations/security-incident.md, "Rotating the MFA key").
Connects with ops credentials (DATABASE_MIGRATOR_URL). Needs MFA_ENCRYPTION_KEY (new) and MFA_ENCRYPTION_KEY_PREVIOUS (old).

  pnpm --filter @1pos/api mfa-rekey --check
      Counts secrets per key; changes nothing.
  pnpm --filter @1pos/api mfa-rekey --reason "<why>" --ticket <ref> [--actor <name>]
      Re-seals, in one transaction; refuses to change anything if a secret opens with neither key.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      reason: { type: 'string', default: '' },
      ticket: { type: 'string', default: '' },
      actor: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const env = loadServerEnv();
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) {
    console.error('DATABASE_MIGRATOR_URL is not set');
    return 2;
  }
  if (!env.MFA_ENCRYPTION_KEY_PREVIOUS && !values.check) {
    console.error('MFA_ENCRYPTION_KEY_PREVIOUS is not set: there is no old key to re-seal from.');
    return 2;
  }
  if (!values.check && (values.reason.trim().length < 5 || !values.ticket.trim())) {
    console.error('--reason and --ticket are required (recorded in the audit log)');
    return 2;
  }
  const box = new SecretBox(env.MFA_ENCRYPTION_KEY, env.JWT_ACCESS_SECRET, env.MFA_ENCRYPTION_KEY_PREVIOUS);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await rekeyMfaSecrets(client, box, {
      actor: values.actor ?? userInfo().username,
      reason: values.check ? 'check only' : values.reason,
      ticket: values.check ? '-' : values.ticket,
      check: values.check,
    });
    console.log(
      values.check
        ? `${r.total} secret(s): ${r.alreadyCurrent} on the current key, ${r.resealed} on the previous key. Nothing changed.`
        : `${r.resealed} secret(s) re-sealed, ${r.alreadyCurrent} already on the current key. MFA_ENCRYPTION_KEY_PREVIOUS can now be removed.`,
    );
    return 0;
  } catch (e) {
    if (e instanceof UnreadableSecretsError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
