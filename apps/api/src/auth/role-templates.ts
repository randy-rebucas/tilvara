import { rolePermissions, roles, type Database } from '@1pos/database';
import type { RoleTemplate } from '@1pos/validation';

/**
 * Adds the built-in roles the business does not have yet, with their permissions; a role whose key
 * is already taken (built in, or a custom role of that key) is left as it is. Answers the keys added.
 */
export async function addRoleTemplates(db: Database, tenantId: string, templates: readonly RoleTemplate[]): Promise<Map<string, string>> {
  if (!templates.length) return new Map();
  const created = await db
    .insert(roles)
    .values(templates.map((t) => ({ tenantId, key: t.key, name: t.name, isSystem: true })))
    .onConflictDoNothing()
    .returning({ id: roles.id, key: roles.key });
  const idByKey = new Map(created.map((r) => [r.key, r.id]));
  const grants = templates.flatMap((t) => (idByKey.has(t.key) ? t.permissions.map((p) => ({ tenantId, roleId: idByKey.get(t.key)!, permissionCode: p })) : []));
  if (grants.length) await db.insert(rolePermissions).values(grants);
  return idByKey;
}
