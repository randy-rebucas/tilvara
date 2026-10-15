import { eq, users } from '@1pos/database';
import type { Logger, OutboxHandler } from './outbox-processor.js';

export interface WorkerMailer {
  send(message: { to: string; subject: string; text: string; template: string }): Promise<void>;
}

/** Dev mailer for workers: logs recipient + template only. Refused in production by @1pos/config. */
export class DevWorkerMailer implements WorkerMailer {
  readonly sent: { to: string; subject: string; text: string; template: string }[] = [];
  constructor(private readonly logger: Logger) {}
  async send(message: { to: string; subject: string; text: string; template: string }): Promise<void> {
    this.sent.push(message);
    this.logger.info('[dev mail]', { template: message.template, to: message.to });
  }
}

export function buildHandlers(mailer: WorkerMailer): Record<string, OutboxHandler> {
  return {
    /** Welcome email to the owner. RLS guarantees we can only read users of this event's tenant. */
    'tenant.onboarded': async (event, db) => {
      const ownerUserId = String(event.payload.ownerUserId ?? '');
      const [owner] = await db.select({ email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, ownerUserId));
      if (!owner) throw new Error(`owner ${ownerUserId} not visible in tenant ${event.tenantId}`);
      await mailer.send({
        to: owner.email,
        template: 'tenant.welcome',
        subject: 'Welcome to 1POS',
        text: `Hi ${owner.displayName}, your business is ready. Your 14-day trial has started.`,
      });
    },
  };
}
