import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '@1pos/validation';
import type { CorrelatedRequest } from '../infrastructure/correlation-id.middleware.js';
import type { Grant } from './authorization.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  correlationId: string | undefined;
  /** Present only when the token carries an active tenant AND membership was verified this request. */
  tenant: {
    tenantId: string;
    membershipId: string;
    status: string;
    grants: Grant[];
  } | null;
}

export type AuthedRequest = CorrelatedRequest & { auth?: AuthContext };

export const IS_PUBLIC = 'onepos:isPublic';
/** Route needs no access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const TERMINAL_AUTH = 'onepos:terminalAuth';
/** Route authenticates a terminal by its credential (in the service), not a user token (ADR-0015 §2). */
export const TerminalAuth = () => applyDecorators(Public(), SetMetadata(TERMINAL_AUTH, true));

export const REQUIRED_PERMISSIONS = 'onepos:requiredPermissions';
/**
 * Route requires an active tenant and these permissions at TENANT scope.
 * Branch/register-scoped checks happen in the service with `hasPermission(…, scope)`.
 */
export const RequirePermissions = (...perms: PermissionCode[]) => SetMetadata(REQUIRED_PERMISSIONS, perms);

export const REQUIRES_TENANT = 'onepos:requiresTenant';
/** Route requires an active tenant but no specific permission (e.g. /me within a tenant). */
export const RequireTenant = () => SetMetadata(REQUIRES_TENANT, true);

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new Error('Auth context missing — route is not behind AuthGuard');
  return req.auth;
});

/** Narrow helper for handlers that ran behind RequirePermissions/RequireTenant. */
export function tenantOf(auth: AuthContext): NonNullable<AuthContext['tenant']> {
  if (!auth.tenant) throw new Error('Tenant context missing — add @RequirePermissions or @RequireTenant');
  return auth.tenant;
}
