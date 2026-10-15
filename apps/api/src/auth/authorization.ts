import type { ScopeType } from '@1pos/database';
import type { PermissionCode } from '@1pos/validation';

export interface Grant {
  permission: PermissionCode;
  scopeType: ScopeType;
  scopeId: string | null;
}

/** Where an action happens. Absent fields mean "not tied to that level". */
export interface ResourceScope {
  legalEntityId?: string;
  branchId?: string;
  registerId?: string;
}

/**
 * Pure permission check. A grant applies when its scope contains the resource:
 * TENANT ⊇ LEGAL_ENTITY ⊇ BRANCH ⊇ REGISTER. Without a resource scope, only
 * tenant-wide grants satisfy the check (no accidental escalation from a branch role).
 * Callers pass the FULL chain resolved server-side from the resource (a register action
 * passes its registerId, branchId and legalEntityId), so a branch grant covers its registers.
 */
export function hasPermission(grants: readonly Grant[], permission: PermissionCode, scope: ResourceScope = {}): boolean {
  return grants.some((g) => {
    if (g.permission !== permission) return false;
    switch (g.scopeType) {
      case 'TENANT':
        return true;
      case 'LEGAL_ENTITY':
        return scope.legalEntityId !== undefined && g.scopeId === scope.legalEntityId;
      case 'BRANCH':
        return scope.branchId !== undefined && g.scopeId === scope.branchId;
      case 'REGISTER':
        return scope.registerId !== undefined && g.scopeId === scope.registerId;
    }
  });
}

/** Distinct permission codes (for UI capability hints only — never for server decisions without scope). */
export function permissionCodes(grants: readonly Grant[]): PermissionCode[] {
  return [...new Set(grants.map((g) => g.permission))].sort();
}
