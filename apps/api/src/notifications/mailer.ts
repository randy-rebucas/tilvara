import { Injectable, Logger } from '@nestjs/common';
import { maskEmail } from '@1pos/observability';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Machine-readable kind, e.g. 'member.invitation'. */
  template: string;
}

/** Outbound email port. Real providers implement this; DevMailer is the only implementation today. */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/**
 * Development mailer: keeps messages in memory (tests read them) and logs the template and a
 * masked recipient only — never bodies, which may contain one-time tokens. Refused in production
 * by @1pos/config.
 */
@Injectable()
export class DevMailer extends Mailer {
  private readonly logger = new Logger('DevMailer');
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > 500) this.sent.shift();
    this.logger.log(`[dev mail] ${message.template} → ${maskEmail(message.to)}`);
  }

  lastTo(email: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === email.toLowerCase());
  }
}
