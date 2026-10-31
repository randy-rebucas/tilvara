import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { IS_PUBLIC, REQUIRED_PERMISSIONS, REQUIRES_TENANT, TERMINAL_AUTH } from '../../src/auth/auth-context.js';

/**
 * Audit 47 #2: `AuthGuard` runs the two-step sign-in, grace and suspended-business checks only on a
 * route that needs a business (`@RequireTenant` or `@RequirePermissions`, on the method or the class).
 * A route with neither is about the person signed in, not a business. Each such route is listed here
 * on purpose; a new route that forgets its gate fails this test.
 */
const PERSONAL_ROUTES = new Set([
  // Account and sign-in: no business needed, so a person blocked by MFA can still see why and fix it.
  'GET /v1/auth/mfa',
  'POST /v1/auth/mfa/enroll',
  'POST /v1/auth/mfa/confirm',
  'POST /v1/auth/mfa/disable',
  'POST /v1/auth/mfa/recovery-codes',
  'PATCH /v1/me',
  'GET /v1/me',
  'POST /v1/auth/email-change',
  'GET /v1/auth/account/closure',
  'POST /v1/auth/account/close',
  'POST /v1/auth/logout',
  'POST /v1/auth/switch-tenant',
  'POST /v1/auth/handoff',
  // Joining another business with the account one is signed in with.
  'POST /v1/invitations/accept-existing',
  // Tilvara staff, who are in no business: the service checks the staff account and a two-step session.
  'GET /v1/support/grants',
  'POST /v1/support/grants/:id/open',
]);

type Ctor = abstract new (...args: never[]) => unknown;

function controllersOf(module: unknown, seen = new Set<unknown>()): Ctor[] {
  if (!module || seen.has(module)) return [];
  seen.add(module);
  const own = (Reflect.getMetadata('controllers', module as object) ?? []) as Ctor[];
  const imports = (Reflect.getMetadata('imports', module as object) ?? []) as unknown[];
  return [...own, ...imports.flatMap((m) => controllersOf(m, seen))];
}

const joinPath = (...parts: string[]) => '/' + parts.flatMap((p) => p.split('/')).filter(Boolean).join('/');

function ungatedRoutes(): string[] {
  const out: string[] = [];
  for (const ctrl of controllersOf(AppModule)) {
    const base = (Reflect.getMetadata(PATH_METADATA, ctrl) as string | undefined) ?? '/';
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (sub === undefined || method === undefined) continue;
      const meta = <T>(key: string) => (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, ctrl)) as T | undefined;
      const gated =
        meta<boolean>(IS_PUBLIC) === true ||
        meta<boolean>(TERMINAL_AUTH) === true ||
        meta<boolean>(REQUIRES_TENANT) === true ||
        (meta<string[]>(REQUIRED_PERMISSIONS)?.length ?? 0) > 0;
      if (!gated) out.push(`${RequestMethod[method]} ${joinPath('/v1', base, sub)}`);
    }
  }
  return out.sort();
}

describe('route gates (audit 47 #2)', () => {
  it('every route is public, a terminal route, or needs a business, unless it is a listed personal route', () => {
    const unlisted = ungatedRoutes().filter((r) => !PERSONAL_ROUTES.has(r));
    expect(unlisted).toEqual([]);
  });

  it('the allow-list names only routes that exist and are still ungated', () => {
    const ungated = new Set(ungatedRoutes());
    expect([...PERSONAL_ROUTES].filter((r) => !ungated.has(r))).toEqual([]);
  });

  it('resetting and listing members’ two-step sign-in need a business (and so pass its MFA gate)', () => {
    const ungated = ungatedRoutes();
    expect(ungated).not.toContain('POST /v1/members/:id/reset-mfa');
    expect(ungated).not.toContain('GET /v1/members/mfa');
  });
});
