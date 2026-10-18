import type pg from 'pg';
import type { SecretBox } from './totp.js';

export interface RekeyOptions {
  actor: string;
  reason: string;
  ticket: string;
  /** Count only; change nothing. */
  check?: boolean;
  /** Only these accounts (a single account, or a test's own rows); default every factor. */
  userIds?: string[];
}

export interface RekeyResult {
  total: number;
  /** Sealed with the previous key: re-sealed with the current one (or would be, with `check`). */
  resealed: number;
  alreadyCurrent: number;
}

export class UnreadableSecretsError extends Error {
  constructor(readonly count: number) {
    super(`${count} two-step sign-in secret(s) open with neither key: nothing was changed. Is MFA_ENCRYPTION_KEY_PREVIOUS the key being replaced?`);
  }
}

/**
 * Re-seal every TOTP secret with the current MFA_ENCRYPTION_KEY (ADR-0016, key rotation). One
 * transaction as onepos_platform (credential tables have no other grants), rows locked: all or
 * nothing. A secret that opens with neither key aborts the whole run, so a wrong previous key never
 * leaves a mix. Writes a NULL-tenant audit row `platform.mfa.rekeyed` with the counts.
 * `client` is an ops (migrator) connection that may SET ROLE onepos_platform.
 */
export async function rekeyMfaSecrets(client: pg.ClientBase, box: SecretBox, opts: RekeyOptions): Promise<RekeyResult> {
  if (opts.actor.trim().length < 2 || opts.reason.trim().length < 5 || opts.ticket.trim().length < 1) {
    throw new Error('actor, reason and ticket are required (recorded in the audit log)');
  }
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE onepos_platform');
    const { rows } = await client.query<{ user_id: string; secret_ciphertext: string }>(
      `SELECT user_id, secret_ciphertext FROM user_mfa_factors WHERE ($1::uuid[] IS NULL OR user_id = ANY ($1)) ORDER BY user_id FOR UPDATE`,
      [opts.userIds ?? null],
    );
    const updates: { userId: string; sealed: string }[] = [];
    let unreadable = 0;
    for (const r of rows) {
      try {
        const { plain, current } = box.openKeyed(r.secret_ciphertext);
        if (!current) updates.push({ userId: r.user_id, sealed: box.seal(plain) });
      } catch {
        unreadable++;
      }
    }
    if (unreadable > 0) throw new UnreadableSecretsError(unreadable);
    const result = { total: rows.length, resealed: updates.length, alreadyCurrent: rows.length - updates.length };
    if (opts.check) {
      await client.query('ROLLBACK');
      return result;
    }
    for (const u of updates) {
      await client.query('UPDATE user_mfa_factors SET secret_ciphertext = $2 WHERE user_id = $1', [u.userId, u.sealed]);
    }
    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
       VALUES (NULL, 'SYSTEM', NULL, 'platform.mfa.rekeyed', 'platform', 'mfa', $1)`,
      [{ actor: opts.actor.trim().slice(0, 100), reason: opts.reason.trim().slice(0, 500), ticket: opts.ticket.trim().slice(0, 100), ...result }],
    );
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}
