import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ScopeType } from './identity.js';
import { tenants } from './platform.js';

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface InvitedRole {
  roleId: string;
  scopeType: ScopeType;
  scopeId: string | null;
}

/**
 * Invitation to join a tenant. Only a SHA-256 of the one-time token is stored. An
 * expired invitation stays PENDING in storage and is treated as expired by `expires_at`.
 */
export const memberInvitations = pgTable(
  'member_invitations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    email: text('email').notNull(),
    roles: jsonb('roles').$type<InvitedRole[]>().notNull(),
    tokenHash: text('token_hash').notNull(),
    status: text('status').$type<InvitationStatus>().notNull().default('PENDING'),
    invitedBy: uuid('invited_by').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedUserId: uuid('accepted_user_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('member_invitations_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('member_invitations_token_hash_unique').on(t.tokenHash),
    uniqueIndex('member_invitations_one_pending')
      .on(t.tenantId, sql`lower(${t.email})`)
      .where(sql`${t.status} = 'PENDING'`),
    index('member_invitations_tenant_idx').on(t.tenantId, t.createdAt),
    check('member_invitations_status_check', sql`${t.status} IN ('PENDING','ACCEPTED','REVOKED')`),
    check('member_invitations_roles_nonempty', sql`jsonb_typeof(${t.roles}) = 'array' AND jsonb_array_length(${t.roles}) > 0`),
  ],
);
