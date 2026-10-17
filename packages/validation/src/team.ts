import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth.js';
import { PERMISSIONS } from './permissions.js';

export const roleAssignmentSchema = z
  .object({
    roleId: z.uuid(),
    scopeType: z.enum(['TENANT', 'LEGAL_ENTITY', 'BRANCH', 'REGISTER']),
    scopeId: z.uuid().nullable().default(null),
  })
  .refine((a) => (a.scopeType === 'TENANT') === (a.scopeId === null), {
    message: 'scopeId is required for LEGAL_ENTITY/BRANCH/REGISTER and must be null for TENANT',
    path: ['scopeId'],
  });
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

const assignments = z
  .array(roleAssignmentSchema)
  .min(1)
  .max(20)
  .refine(
    (list) => new Set(list.map((a) => `${a.roleId}:${a.scopeType}:${a.scopeId}`)).size === list.length,
    'Duplicate role assignment',
  );

export const createInvitationSchema = z.object({ email: emailSchema, roles: assignments });
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(32).max(128),
  displayName: z.string().trim().min(1).max(200),
  password: passwordSchema,
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const acceptInvitationExistingSchema = z.object({ token: z.string().min(32).max(128) });
export type AcceptInvitationExistingInput = z.infer<typeof acceptInvitationExistingSchema>;

/** The business's audit log, newest first (audit.read for the whole business). Dates are Manila days. */
export const auditLogQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    /** An action or its prefix: "sale", "member.", "stock.reorder_points_set". */
    action: z.string().trim().toLowerCase().regex(/^[a-z_.]{2,80}$/).optional(),
    actorUserId: z.uuid().optional(),
    resourceType: z.string().trim().regex(/^[a-z_]{2,40}$/).optional(),
    resourceId: z.string().trim().min(1).max(100).optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '"from" must not be after "to"', path: ['from'] });
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

/** Why an owner/admin clears a member's two-step sign-in (kept in the audit log). */
export const resetMemberMfaSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type ResetMemberMfaInput = z.infer<typeof resetMemberMfaSchema>;

export const setMemberRolesSchema = z.object({ roles: assignments });
export type SetMemberRolesInput = z.infer<typeof setMemberRolesSchema>;

const permissionList = z
  .array(z.enum(PERMISSIONS))
  .min(1)
  .max(PERMISSIONS.length)
  .transform((l) => [...new Set(l)].sort());

export const createRoleSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,62}$/, 'Use lowercase letters, digits and underscores'),
  name: z.string().trim().min(1).max(100),
  permissions: permissionList,
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({ name: z.string().trim().min(1).max(100), permissions: permissionList })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
