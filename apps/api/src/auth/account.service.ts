import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { maskEmail } from '@1pos/observability';
import type { AccountCloseInput, EmailChangeRequestInput } from '@1pos/validation';
import { createHash, randomBytes } from 'node:crypto';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { Mailer, type MailMessage } from '../notifications/mailer.js';
import { AccountSecurityService } from './account-security.service.js';
import type { AuthContext } from './auth-context.js';
import type { RequestMeta } from './auth.service.js';

const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60_000;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface ClosureStatus {
  canClose: boolean;
  /** Businesses the person still belongs to: an owner or admin removes them, or the business is closed. */
  businesses: string[];
  /** Active Tilvara support staff: ops disable that first. */
  staff: boolean;
}

/**
 * A person's own account (privacy pack): correct their name and sign-in email, and close the
 * account. Closing blocks it now; anonymisation waits for the retention schedule (not built).
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger('Account');

  constructor(
    @Inject(DatabasePool) private readonly database: DatabasePool,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AccountSecurityService) private readonly security: AccountSecurityService,
    @Inject(Mailer) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {}

  /** Own display name (RLS: a user may update only their own row and only this column). Audited without the values. */
  updateProfile(auth: AuthContext, displayName: string): Promise<{ email: string; displayName: string }> {
    return this.tenantDb.tx(
      async (tx) => {
        const { rows } = await tx.client.query<{ email: string; display_name: string }>(
          'UPDATE users SET display_name = $2 WHERE id = $1 RETURNING email, display_name',
          [auth.userId, displayName],
        );
        await tx.client.query('SELECT auth_record_event($1, $2, $3, $4)', [
          auth.userId,
          'auth.profile.updated',
          { fields: ['displayName'] },
          auth.correlationId ?? null,
        ]);
        return { email: rows[0]!.email, displayName: rows[0]!.display_name };
      },
      { userId: auth.userId, correlationId: auth.correlationId },
    );
  }

  /** A link to the new address (24 hours); nothing changes until it is used. The current address is told. */
  async requestEmailChange(auth: AuthContext, input: EmailChangeRequestInput): Promise<{ newEmail: string; expiresAt: string }> {
    const currentEmail = await this.security.reauthenticate(auth.userId, input.password, input.code);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);
    const { rows } = await this.database.pool.query<{ v: string }>('SELECT auth_email_change_request($1, $2, $3, $4, $5) AS v', [
      auth.userId,
      input.newEmail,
      hashToken(token),
      expiresAt,
      auth.correlationId ?? null,
    ]);
    switch (rows[0]!.v) {
      case 'CREATED':
        break;
      case 'SAME_EMAIL':
        throw new AppError('SAME_EMAIL', 'This is already your sign-in email', HttpStatus.CONFLICT);
      case 'EMAIL_TAKEN':
        throw new AppError('EMAIL_UNAVAILABLE', 'An account with this email already exists', HttpStatus.CONFLICT);
      case 'TOO_MANY':
        throw new AppError('RATE_LIMITED', 'Too many email changes asked for. Try again in an hour.', HttpStatus.TOO_MANY_REQUESTS);
      default:
        throw new AppError('UNAUTHENTICATED', 'Session expired. Please sign in again.', HttpStatus.UNAUTHORIZED);
    }
    this.mail({
      to: input.newEmail,
      template: 'auth.email_change.confirm',
      subject: 'Confirm your new Tilvara sign-in email',
      text: `Use this email to sign in to Tilvara: ${this.env.APP_PUBLIC_URL}/confirm-email?token=${token}\nThis link expires in 24 hours. Until you open it, nothing changes. If you did not ask for it, ignore this email.`,
    });
    this.mail({
      to: currentEmail,
      template: 'auth.email_change.requested',
      subject: 'Your Tilvara sign-in email is being changed',
      text: `Someone signed in to your Tilvara account asked to sign in with ${maskEmail(input.newEmail)} instead of this address. It changes only when the link sent there is opened. If this was not you, reset your password now: ${this.env.APP_PUBLIC_URL}/forgot-password`,
    });
    return { newEmail: input.newEmail, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Applies the change and signs out every session; the old address is told it happened. Answers
   * whose account changed, so a browser signed in as someone else keeps its own session.
   */
  async confirmEmailChange(token: string, meta: RequestMeta): Promise<{ userId: string }> {
    const { rows } = await this.database.pool.query<{ outcome: string; user_id: string | null; old_email: string | null }>(
      'SELECT * FROM auth_email_change_confirm($1, $2)',
      [hashToken(token), meta.correlationId ?? null],
    );
    const r = rows[0]!;
    if (r.outcome === 'EMAIL_TAKEN') {
      throw new AppError('EMAIL_UNAVAILABLE', 'Another account now uses this email. Ask for the change again with a different one.', HttpStatus.CONFLICT);
    }
    if (r.outcome !== 'CHANGED') {
      throw new AppError('EMAIL_CHANGE_LINK_INVALID', 'This link has expired or was already used. Ask for the change again.', HttpStatus.BAD_REQUEST);
    }
    this.mail({
      to: r.old_email!,
      template: 'auth.email_change.completed',
      subject: 'Your Tilvara sign-in email was changed',
      text: `Your Tilvara account no longer signs in with this address. If this was not you, contact Tilvara support at once.`,
    });
    return { userId: r.user_id! };
  }

  async closureStatus(userId: string): Promise<ClosureStatus> {
    const rows = await this.tenantDb.tx(
      async (tx) => (await tx.client.query<{ kind: string; name: string | null }>('SELECT * FROM auth_account_closure_blockers($1)', [userId])).rows,
      { userId },
    );
    const businesses = rows.filter((r) => r.kind === 'MEMBERSHIP').map((r) => r.name!);
    const staff = rows.some((r) => r.kind === 'STAFF');
    return { canClose: businesses.length === 0 && !staff, businesses, staff };
  }

  /** Blocks the account at once: sessions end, the second factor and pending links go. */
  async close(auth: AuthContext, input: AccountCloseInput): Promise<void> {
    await this.security.reauthenticate(auth.userId, input.password, input.code);
    const status = await this.closureStatus(auth.userId);
    if (!status.canClose) throw blocked(status);
    try {
      await this.tenantDb.tx((tx) => tx.client.query('SELECT auth_account_close($1, $2)', [auth.userId, auth.correlationId ?? null]), {
        userId: auth.userId,
        correlationId: auth.correlationId,
      });
    } catch (e) {
      const pg = (e as { cause?: { constraint?: string }; constraint?: string });
      // A membership or staff role added between the check and the lock.
      if ((pg.cause ?? pg).constraint === 'account_closure_blocked') throw blocked(await this.closureStatus(auth.userId));
      throw e;
    }
  }

  private mail(message: MailMessage): void {
    void this.mailer.send(message).catch((e: unknown) => this.logger.error(`${message.template} mail failed: ${(e as Error).name}`));
  }
}

function blocked(status: ClosureStatus): AppError {
  return new AppError(
    'ACCOUNT_CLOSURE_BLOCKED',
    status.staff ? 'This account is Tilvara support staff. Ask Tilvara to end that first.' : 'You are still a member of a business. Ask its owner to remove you first.',
    HttpStatus.CONFLICT,
    { businesses: status.businesses, staff: status.staff },
  );
}
