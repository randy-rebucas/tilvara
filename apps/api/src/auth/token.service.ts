import { Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { jwtVerify, SignJWT } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { ENV } from '../infrastructure/env.provider.js';

const ISSUER = '1pos-api';
const AUDIENCE = '1pos';

export interface AccessClaims {
  /** user id */
  sub: string;
  /** session family id */
  sid: string;
  /** active tenant, or null before a tenant is chosen */
  tid: string | null;
}

export class InvalidTokenError extends Error {
  constructor() {
    super('Invalid or expired access token');
    this.name = 'InvalidTokenError';
  }
}

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(ENV) private readonly env: ServerEnv) {
    this.key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  }

  async signAccess(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.env.JWT_ACCESS_TTL_SECONDS * 1000);
    const token = await new SignJWT({ sid: claims.sid, tid: claims.tid, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new InvalidTokenError();
      }
      const tid = payload.tid;
      if (tid !== null && typeof tid !== 'string') throw new InvalidTokenError();
      return { sub: payload.sub, sid: payload.sid, tid };
    } catch {
      throw new InvalidTokenError();
    }
  }

  /** Opaque refresh token; only its SHA-256 is stored. */
  newRefreshToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    return { token, hash: TokenService.hashRefresh(token), expiresAt };
  }

  static hashRefresh(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
