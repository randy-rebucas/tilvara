import { Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { jwtVerify, SignJWT } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { ENV } from '../infrastructure/env.provider.js';

const ISSUER = '1pos-api';
const AUDIENCE = '1pos';
const MFA_CHALLENGE_SECONDS = 300;

export interface AccessClaims {
  /** user id */
  sub: string;
  /** session family id */
  sid: string;
  /** active tenant, or null before a tenant is chosen */
  tid: string | null;
  /**
   * Support grant (ADR-0016 slice 6): the token is a support session in `tid` under this grant, for
   * a Tilvara staff member who is not a member of the business. Read-only; re-checked on every request.
   */
  sgr?: string;
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

  /** `notAfter` caps the expiry (a support session never outlives its grant). */
  async signAccess(claims: AccessClaims, notAfter?: Date): Promise<{ token: string; expiresAt: Date }> {
    const ttl = Date.now() + this.env.JWT_ACCESS_TTL_SECONDS * 1000;
    const expiresAt = new Date(notAfter ? Math.min(ttl, notAfter.getTime()) : ttl);
    const token = await new SignJWT({ sid: claims.sid, tid: claims.tid, typ: 'access', ...(claims.sgr ? { sgr: claims.sgr } : {}) })
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
      const sgr = payload.sgr;
      if (sgr !== undefined && (typeof sgr !== 'string' || !tid)) throw new InvalidTokenError();
      return { sub: payload.sub, sid: payload.sid, tid, ...(sgr ? { sgr } : {}) };
    } catch {
      throw new InvalidTokenError();
    }
  }

  /**
   * Second-step challenge after a correct password (ADR-0016): 5 minutes, its own `typ`, so it is
   * never accepted as an access token (verifyAccess requires typ=access) and vice versa.
   */
  async signMfaChallenge(userId: string, tenantId: string | null): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + MFA_CHALLENGE_SECONDS * 1000);
    const token = await new SignJWT({ tid: tenantId, typ: 'mfa_challenge' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  async verifyMfaChallenge(token: string): Promise<{ userId: string; tenantId: string | null }> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
      if (payload.typ !== 'mfa_challenge' || typeof payload.sub !== 'string') throw new InvalidTokenError();
      const tid = payload.tid;
      if (tid !== null && typeof tid !== 'string') throw new InvalidTokenError();
      return { userId: payload.sub, tenantId: tid };
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
