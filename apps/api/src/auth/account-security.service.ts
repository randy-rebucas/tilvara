import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import type { MfaStatus, PasswordResetConfirmInput } from '@1pos/validation';
import { createHash, randomBytes } from 'node:crypto';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { Mailer } from '../notifications/mailer.js';
import type { AuthContext } from './auth-context.js';
import { AuthService, type RequestMeta } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { base32Encode, hashRecoveryCode, matchTotp, newRecoveryCodes, newTotpSecret, otpauthUri, SecretBox } from './totp.js';

const RESET_TTL_MS = 30 * 60_000;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

const wrongPassword = () => new AppError('WRONG_PASSWORD', 'Your password is not right', HttpStatus.FORBIDDEN);
const wrongCode = () =>
  new AppError('INVALID_MFA_CODE', 'That code is not right. Try the newest code from your app.', HttpStatus.UNPROCESSABLE_ENTITY);

/** Two-step sign-in set-up and password reset (ADR-0016 slice 1). Sign-in itself is in AuthService. */
@Injectable()
export class AccountSecurityService {
  private readonly logger = new Logger('AccountSecurity');

  constructor(
    @Inject(DatabasePool) private readonly database: DatabasePool,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SecretBox) private readonly secrets: SecretBox,
    @Inject(Mailer) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {}

  async status(auth: AuthContext): Promise<MfaStatus & { recoveryCodesLeft: number }> {
    const f = await this.auth.mfaFactor(auth.userId);
    return { ...mfaStatus(auth), recoveryCodesLeft: f?.confirmed ? (f.recovery_codes_left ?? 0) : 0 };
  }

  /** A new secret to scan; nothing changes until it is confirmed with a code. */
  async enroll(auth: AuthContext, password: string): Promise<{ secret: string; otpauthUri: string }> {
    const email = await this.checkPassword(auth.userId, password);
    const secret = newTotpSecret();
    try {
      await this.database.pool.query('SELECT auth_mfa_begin($1, $2)', [auth.userId, this.secrets.seal(secret)]);
    } catch (e) {
      const pg = (e as { cause?: { constraint?: string }; constraint?: string });
      if ((pg.cause ?? pg).constraint === 'mfa_already_enabled') {
        throw new AppError('MFA_ALREADY_ENABLED', 'Two-step sign-in is already on', HttpStatus.CONFLICT);
      }
      throw e;
    }
    return { secret: base32Encode(secret).replace(/(.{4})/g, '$1 ').trim(), otpauthUri: otpauthUri(secret, email) };
  }

  /** The first code turns it on; the recovery codes are shown this once only. */
  async confirm(auth: AuthContext, code: string): Promise<{ recoveryCodes: string[] }> {
    const f = await this.auth.mfaFactor(auth.userId);
    if (!f?.secret_ciphertext) throw new AppError('MFA_NOT_STARTED', 'Start setting up two-step sign-in first', HttpStatus.CONFLICT);
    if (f.confirmed) throw new AppError('MFA_ALREADY_ENABLED', 'Two-step sign-in is already on', HttpStatus.CONFLICT);
    const step = matchTotp(this.secrets.open(f.secret_ciphertext), code);
    if (step === null) throw wrongCode();
    const recoveryCodes = newRecoveryCodes();
    const { rows } = await this.database.pool.query<{ v: boolean }>('SELECT auth_mfa_confirm($1, $2, $3, $4, $5) AS v', [
      auth.userId,
      step,
      recoveryCodes.map(hashRecoveryCode),
      auth.sessionId,
      auth.correlationId ?? null,
    ]);
    if (!rows[0]!.v) throw wrongCode();
    return { recoveryCodes };
  }

  /** Needs the password and a current code; refused while the active business requires it. */
  async disable(auth: AuthContext, password: string, code: string): Promise<void> {
    if (auth.mfa.required) {
      throw new AppError('MFA_REQUIRED_FOR_ROLE', 'Your role in this business requires two-step sign-in', HttpStatus.CONFLICT);
    }
    await this.checkPassword(auth.userId, password);
    const f = await this.auth.mfaFactor(auth.userId);
    if (!f?.confirmed || !f.secret_ciphertext) throw new AppError('MFA_NOT_ENABLED', 'Two-step sign-in is not on', HttpStatus.CONFLICT);
    const step = matchTotp(this.secrets.open(f.secret_ciphertext), code);
    const spent = step !== null && (await this.scalar<boolean>('SELECT auth_mfa_use_step($1, $2) AS v', [auth.userId, step]));
    if (!spent) throw wrongCode();
    await this.database.pool.query('SELECT auth_mfa_disable($1, $2)', [auth.userId, auth.correlationId ?? null]);
  }

  /**
   * Always answers the same (no account discovery). The mail goes out after the token commits and
   * is not awaited, so the answer time does not tell whether the email exists either.
   */
  async requestReset(email: string, meta: RequestMeta): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const userId = await this.scalar<string | null>('SELECT auth_password_reset_create($1, $2, $3, $4) AS v', [
      email,
      hashToken(token),
      new Date(Date.now() + RESET_TTL_MS),
      meta.correlationId ?? null,
    ]);
    if (!userId) return;
    void this.mailer
      .send({
        to: email,
        template: 'auth.password_reset',
        subject: 'Reset your 1POS password',
        text: `Set a new password: ${this.env.APP_PUBLIC_URL}/reset-password?token=${token}\nThis link expires in 30 minutes. If you did not ask for it, ignore this email.`,
      })
      .catch((e: unknown) => this.logger.error(`password reset mail failed: ${(e as Error).name}`));
  }

  /** Sets the password, unlocks the account and signs out every session. Two-step sign-in stays on. */
  async confirmReset(input: PasswordResetConfirmInput, meta: RequestMeta): Promise<void> {
    const hash = await this.passwords.hash(input.password);
    const userId = await this.scalar<string | null>('SELECT auth_password_reset_consume($1, $2, $3) AS v', [
      hashToken(input.token),
      hash,
      meta.correlationId ?? null,
    ]);
    if (!userId) {
      throw new AppError('RESET_LINK_INVALID', 'This link has expired or was already used. Ask for a new one.', HttpStatus.BAD_REQUEST);
    }
  }

  /** The user's email when the password is right; a wrong one counts towards the sign-in lock. */
  private async checkPassword(userId: string, password: string): Promise<string> {
    const { email } = await this.auth.profile(userId);
    const { rows } = await this.database.pool.query<{ password_hash: string; locked_until: Date | null }>(
      'SELECT * FROM auth_get_login_record($1)',
      [email],
    );
    const rec = rows[0]!;
    if (rec.locked_until && rec.locked_until.getTime() > Date.now()) {
      throw new AppError('TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!(await this.passwords.verify(password, rec.password_hash))) {
      await this.database.pool.query('SELECT auth_record_login_result($1, false)', [userId]);
      throw wrongPassword();
    }
    return email;
  }

  private async scalar<T>(sql: string, params: unknown[]): Promise<T> {
    const { rows } = await this.database.pool.query<{ v: T }>(sql, params);
    return rows[0]!.v;
  }
}

export function mfaStatus(auth: AuthContext): MfaStatus {
  return {
    enabled: auth.mfa.enrolled,
    sessionVerified: auth.mfa.sessionVerified,
    required: auth.mfa.required,
    dueAt: auth.mfa.dueAt?.toISOString() ?? null,
  };
}
