import { Global, Module } from '@nestjs/common';
import { DevMailer, Mailer } from './mailer.js';

@Global()
@Module({
  providers: [DevMailer, { provide: Mailer, useExisting: DevMailer }],
  exports: [Mailer, DevMailer],
})
export class NotificationsModule {}
