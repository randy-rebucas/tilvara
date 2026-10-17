import { Controller, Get, Inject } from '@nestjs/common';
import { asc, eq, membershipRoles, rolePermissions, roles, tenantMemberships, users } from '@1pos/database';
import { Auth, RequirePermissions, type AuthContext } from '../auth/auth-context.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

/** Read side of team & roles for the current tenant (write side: next slice — invitations/assignments). */
@Controller()
export class AccessController {
  constructor(@Inject(TenantDb) private readonly tenantDb: TenantDb) {}

  @RequirePermissions('members.read')
  @Get('members')
  members(@Auth() auth: AuthContext) {
    return this.tenantDb.run(auth, async (db) => {
      const rows = await db
        .select({
          membershipId: tenantMemberships.id,
          status: tenantMemberships.status,
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          roleId: roles.id,
          roleKey: roles.key,
          scopeType: membershipRoles.scopeType,
          scopeId: membershipRoles.scopeId,
        })
        .from(tenantMemberships)
        .innerJoin(users, eq(users.id, tenantMemberships.userId))
        .leftJoin(membershipRoles, eq(membershipRoles.membershipId, tenantMemberships.id))
        .leftJoin(roles, eq(roles.id, membershipRoles.roleId))
        .orderBy(asc(users.displayName));
      type Assignment = { roleId: string; roleKey: string; scopeType: string; scopeId: string | null };
      const byId = new Map<string, { membershipId: string; status: string; user: { id: string; email: string; displayName: string }; roles: Assignment[] }>();
      for (const r of rows) {
        const m =
          byId.get(r.membershipId) ??
          { membershipId: r.membershipId, status: r.status, user: { id: r.userId, email: r.email, displayName: r.displayName }, roles: [] };
        if (r.roleId && r.roleKey && r.scopeType) m.roles.push({ roleId: r.roleId, roleKey: r.roleKey, scopeType: r.scopeType, scopeId: r.scopeId });
        byId.set(r.membershipId, m);
      }
      return { data: [...byId.values()] };
    });
  }

  @RequirePermissions('roles.read')
  @Get('roles')
  roles(@Auth() auth: AuthContext) {
    return this.tenantDb.run(auth, async (db) => {
      const rows = await db
        .select({ id: roles.id, key: roles.key, name: roles.name, isSystem: roles.isSystem, archivedAt: roles.archivedAt, permission: rolePermissions.permissionCode })
        .from(roles)
        .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .orderBy(asc(roles.name));
      const byId = new Map<string, { id: string; key: string; name: string; isSystem: boolean; archivedAt: Date | null; permissions: string[] }>();
      for (const r of rows) {
        const role = byId.get(r.id) ?? { id: r.id, key: r.key, name: r.name, isSystem: r.isSystem, archivedAt: r.archivedAt, permissions: [] };
        if (r.permission) role.permissions.push(r.permission);
        byId.set(r.id, role);
      }
      return { data: [...byId.values()].map((r) => ({ ...r, permissions: r.permissions.sort() })) };
    });
  }
}
