import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core';
import { tenants } from './platform.js';

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Global identities (a person may belong to several tenants). Not tenant-owned:
 * RLS lets a session see itself and members of the current tenant only.
 * `password_hash` has no SELECT grant for the runtime role — login goes through
 * SECURITY DEFINER functions.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: text('status').$type<UserStatus>().notNull().default('ACTIVE'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** First time the guard saw this user hold a privileged permission without MFA: start of the MFA grace period (ADR-0016). */
    privilegedSince: timestamp('privileged_since', { withTimezone: true }),
    /**
     * Set when the person closed their own account (status DISABLED from then on). The account is
     * blocked now and anonymised later, once the retention schedule allows (privacy pack). Platform-only.
     */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    check('users_status_check', sql`${t.status} IN ('ACTIVE','DISABLED')`),
    check('users_email_format', sql`${t.email} ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'`),
    check('users_closed_disabled', sql`${t.closedAt} IS NULL OR ${t.status} = 'DISABLED'`),
  ],
);

/**
 * One row per refresh token. Rotation inserts a new row in the same `family_id`
 * and stamps `replaced_at` on the old one; presenting a replaced/revoked token
 * revokes the whole family (reuse detection). `family_id` is the session id (`sid`).
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    familyId: uuid('family_id').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    userAgent: text('user_agent'),
    /** Set when the session passed a second factor (at sign-in or by enrolling); copied on rotation. */
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('user_sessions_family_idx').on(t.familyId), index('user_sessions_user_idx').on(t.userId)],
);

/**
 * A user's TOTP factor (RFC 6238). The secret is AES-256-GCM ciphertext made by the API
 * (`MFA_ENCRYPTION_KEY`), so a dump or backup does not reveal it. `last_used_step` refuses a
 * code twice. No runtime access: only auth_mfa_* SECURITY DEFINER functions.
 */
export const userMfaFactors = pgTable('user_mfa_factors', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  secretCiphertext: text('secret_ciphertext').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  lastUsedStep: integer('last_used_step').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One-time recovery codes, SHA-256 only. No runtime access. */
export const userMfaRecoveryCodes = pgTable(
  'user_mfa_recovery_codes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('user_mfa_recovery_codes_hash_unique').on(t.userId, t.codeHash)],
);

/** One-time password reset tokens (SHA-256 only), 30 minutes. No runtime access. */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('password_reset_tokens_user_idx').on(t.userId)],
);

/**
 * A requested change of sign-in email (SHA-256 of the link token only), 24 hours. The link goes to
 * the new address, so using it proves the person controls it. Only the newest works. No runtime
 * access: only auth_email_change_* functions.
 */
export const emailChangeTokens = pgTable(
  'email_change_tokens',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    newEmail: text('new_email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('email_change_tokens_user_idx').on(t.userId),
    check('email_change_tokens_email_format', sql`${t.newEmail} ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'`),
  ],
);

/** Global permission catalog, seeded by migration. Codes are referenced by role_permissions. */
export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(),
  description: text('description').notNull(),
});

export const MEMBERSHIP_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').$type<MembershipStatus>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tenant_memberships_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('tenant_memberships_tenant_user_unique').on(t.tenantId, t.userId),
    index('tenant_memberships_user_idx').on(t.userId),
    check('tenant_memberships_status_check', sql`${t.status} IN ('INVITED','ACTIVE','SUSPENDED','REMOVED')`),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('roles_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('roles_tenant_key_unique').on(t.tenantId, t.key),
    check('roles_key_format', sql`${t.key} ~ '^[a-z][a-z0-9_]{1,62}$'`),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    tenantId: uuid('tenant_id').notNull(),
    roleId: uuid('role_id').notNull(),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code),
  },
  (t) => [
    unique('role_permissions_unique').on(t.tenantId, t.roleId, t.permissionCode),
    foreignKey({ columns: [t.tenantId, t.roleId], foreignColumns: [roles.tenantId, roles.id] }).onDelete('cascade'),
  ],
);

export const SCOPE_TYPES = ['TENANT', 'LEGAL_ENTITY', 'BRANCH', 'REGISTER'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/**
 * Role assignment with a scope. TENANT scope has NULL scope_id. Scope ids for
 * LEGAL_ENTITY/BRANCH/REGISTER get FK-like validation once those tables exist (Phase 1 org slice).
 */
export const membershipRoles = pgTable(
  'membership_roles',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
    scopeType: text('scope_type').$type<ScopeType>().notNull(),
    scopeId: uuid('scope_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('membership_roles_tenant_id_id_unique').on(t.tenantId, t.id),
    uniqueIndex('membership_roles_assignment_unique').on(
      t.tenantId,
      t.membershipId,
      t.roleId,
      t.scopeType,
      sql`coalesce(${t.scopeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    foreignKey({
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.roleId], foreignColumns: [roles.tenantId, roles.id] }),
    check('membership_roles_scope_type_check', sql`${t.scopeType} IN ('TENANT','LEGAL_ENTITY','BRANCH','REGISTER')`),
    check(
      'membership_roles_scope_id_check',
      sql`(${t.scopeType} = 'TENANT') = (${t.scopeId} IS NULL)`,
    ),
  ],
);
