import { loadServerEnv } from '@1pos/config';
import { describe, expect, it } from 'vitest';
import { hasPermission, permissionCodes, type Grant } from '../../src/auth/authorization.js';
import { PasswordService } from '../../src/auth/password.service.js';
import { InvalidTokenError, TokenService } from '../../src/auth/token.service.js';

const env = loadServerEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  JWT_ACCESS_SECRET: 'unit-test-secret-unit-test-secret-0123',
} as NodeJS.ProcessEnv);

describe('hasPermission', () => {
  const B1 = '0199a000-0000-7000-8000-000000000001';
  const B2 = '0199a000-0000-7000-8000-000000000002';
  const R1 = '0199a000-0000-7000-8000-000000000011';
  const grants: Grant[] = [
    { permission: 'reports.read', scopeType: 'TENANT', scopeId: null },
    { permission: 'sales.refund', scopeType: 'BRANCH', scopeId: B1 },
    { permission: 'cash.session', scopeType: 'REGISTER', scopeId: R1 },
  ];

  it('tenant grant applies everywhere', () => {
    expect(hasPermission(grants, 'reports.read')).toBe(true);
    expect(hasPermission(grants, 'reports.read', { branchId: B2 })).toBe(true);
  });

  it('branch grant applies to that branch and its registers only', () => {
    expect(hasPermission(grants, 'sales.refund', { branchId: B1 })).toBe(true);
    expect(hasPermission(grants, 'sales.refund', { branchId: B1, registerId: R1 })).toBe(true);
    expect(hasPermission(grants, 'sales.refund', { branchId: B2 })).toBe(false);
  });

  it('scoped grants never satisfy an unscoped (tenant-wide) check', () => {
    expect(hasPermission(grants, 'sales.refund')).toBe(false);
    expect(hasPermission(grants, 'cash.session')).toBe(false);
  });

  it('register grant does not leak to the branch', () => {
    expect(hasPermission(grants, 'cash.session', { branchId: B1 })).toBe(false);
    expect(hasPermission(grants, 'cash.session', { branchId: B1, registerId: R1 })).toBe(true);
  });

  it('lists distinct codes', () => {
    expect(permissionCodes([...grants, grants[0]!])).toEqual(['cash.session', 'reports.read', 'sales.refund']);
  });
});

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('produces salted argon2id PHC hashes that verify', async () => {
    const a = await svc.hash('correct horse battery staple');
    const b = await svc.hash('correct horse battery staple');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(await svc.verify('correct horse battery staple', a)).toBe(true);
    expect(await svc.verify('correct horse battery stapl', a)).toBe(false);
  });

  it('rejects malformed hashes', async () => {
    expect(await svc.verify('x', 'plaintext')).toBe(false);
    expect(await svc.verify('x', '$2b$10$bcrypthash')).toBe(false);
  });
});

describe('TokenService', () => {
  const svc = new TokenService(env);

  it('round-trips access claims', async () => {
    const { token } = await svc.signAccess({ sub: 'u1', sid: 's1', tid: null });
    expect(await svc.verifyAccess(token)).toEqual({ sub: 'u1', sid: 's1', tid: null });
  });

  it('rejects tampered, foreign-key and alg:none tokens', async () => {
    const { token } = await svc.signAccess({ sub: 'u1', sid: 's1', tid: 't1' });
    const [h, p, s] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), tid: 't2' })).toString('base64url');
    await expect(svc.verifyAccess(`${h}.${forgedPayload}.${s}`)).rejects.toBeInstanceOf(InvalidTokenError);

    const other = new TokenService({ ...env, JWT_ACCESS_SECRET: 'another-secret-another-secret-012345' });
    const foreign = await other.signAccess({ sub: 'u1', sid: 's1', tid: 't1' });
    await expect(svc.verifyAccess(foreign.token)).rejects.toBeInstanceOf(InvalidTokenError);

    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`;
    await expect(svc.verifyAccess(none)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects expired tokens', async () => {
    const short = new TokenService({ ...env, JWT_ACCESS_TTL_SECONDS: -10 } as typeof env);
    const { token } = await short.signAccess({ sub: 'u1', sid: 's1', tid: null });
    await expect(svc.verifyAccess(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('stores only a hash of refresh tokens', () => {
    const r = svc.newRefreshToken();
    expect(r.token.length).toBeGreaterThanOrEqual(43);
    expect(r.hash).toBe(TokenService.hashRefresh(r.token));
    expect(r.hash).not.toContain(r.token);
  });
});
