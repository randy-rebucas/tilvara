import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ServerEnv } from '@1pos/config';
import { AccessController } from '../access/access.controller.js';
import { ENV } from '../infrastructure/env.provider.js';
import { RateLimitGuard } from '../infrastructure/rate-limit.guard.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AccountSecurityService } from './account-security.service.js';
import { AccountService } from './account.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { SecretBox } from './totp.js';

@Module({
  imports: [NotificationsModule],
  controllers: [AuthController, AccessController],
  providers: [
    PasswordService,
    TokenService,
    {
      provide: SecretBox,
      useFactory: (env: ServerEnv) => new SecretBox(env.MFA_ENCRYPTION_KEY, env.JWT_ACCESS_SECRET, env.MFA_ENCRYPTION_KEY_PREVIOUS),
      inject: [ENV],
    },
    AuthService,
    AccountSecurityService,
    AccountService,
    // Order matters: rate limit first (cheap), then authentication/authorization.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TokenService, AuthService, PasswordService],
})
export class AuthModule {}
