/**
 * What the viewer may grant, as the API checks it (`assertCanGrantAll`): a role whose every code the
 * viewer holds, and a member all of whose roles are such. An Administrator therefore cannot change an
 * Owner (Owner holds subscription.manage). `/me` lists the viewer's codes at any scope, so a
 * branch-scoped manager may still be refused for another branch; the API says so.
 */
export const canGrantRole = (role: { permissions: readonly string[] }, viewer: readonly string[]): boolean =>
  role.permissions.every((p) => viewer.includes(p));

export function canManageMember(
  member: { roles: readonly { roleId: string }[] },
  roles: readonly { id: string; permissions: readonly string[] }[],
  viewer: readonly string[],
): boolean {
  return member.roles.every((a) => {
    const role = roles.find((r) => r.id === a.roleId);
    return role !== undefined && canGrantRole(role, viewer);
  });
}
