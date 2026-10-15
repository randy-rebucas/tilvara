import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessController } from '../access/access.controller.js';
import { RateLimitGuard } from '../infrastructure/rate-limit.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController, AccessController],
  providers: [
    PasswordService,
    TokenService,
    AuthService,
    // Order matters: rate limit first (cheap), then authentication/authorization.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TokenService, AuthService, PasswordService],
})
export class AuthModule {}
