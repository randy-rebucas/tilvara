import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import {
  and,
  asc,
  branches,
  eq,
  inArray,
  memberInvitations,
  membershipRoles,
  registers,
  rolePermissions,
  roles,
  sql,
  tenantMemberships,
  users,
  type Database,
  type InvitedRole,
  type Tx,
} from '@1pos/database';
import type {
  AcceptInvitationInput,
  CreateInvitationInput,
  CreateRoleInput,
  PermissionCode,
  RoleAssignment,
  SetMemberRolesInput,
  UpdateRoleInput,
} from '@1pos/validation';
import { createHash, randomBytes } from 'node:crypto';
import { recordAudit } from '../audit/audit.js';
import { assertWithinLimit, assertWritable } from '../billing/entitlements.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { hasPermission, type ResourceScope } from '../auth/authorization.js';
import { AuthService, type RequestMeta } from '../auth/auth.service.js';
import { PasswordService } from '../auth/password.service.js';
import { archived, notFound, pgError, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { Mailer } from '../notifications/mailer.js';

const INVITATION_TTL_MS = 7 * 86_400_000;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const invalidInvitation = () =>
  new AppError('INVITATION_INVALID', 'This invitation is invalid, expired or already used', HttpStatus.NOT_FOUND);
const escalation = () =>
  new AppError('PRIVILEGE_ESCALATION', 'You cannot grant or change access beyond your own', HttpStatus.FORBIDDEN);

interface RoleInfo {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  archivedAt: Date | null;
  permissions: PermissionCode[];
}

@Injectable()
export class TeamService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    member_invitations_one_pending: ['INVITATION_PENDING', 'This email already has a pending invitation'],
    roles_tenant_key_unique: ['KEY_TAKEN', 'A role with this key already exists'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(Mailer) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- invitations
  async createInvitation(auth: AuthContext, input: CreateInvitationInput) {
    const token = randomBytes(32).toString('base64url');
    const invitation = await this.mutate(auth, async (db) => {
      await this.assertCanGrantAll(db, auth, input.roles);
      const existing = await db
        .select({ id: tenantMemberships.id })
        .from(tenantMemberships)
        .innerJoin(users, eq(users.id, tenantMemberships.userId))
        .where(and(sql`lower(${users.email}) = ${input.email}`, eq(tenantMemberships.status, 'ACTIVE')));
      if (existing.length) throw new AppError('ALREADY_MEMBER', 'This person is already a member', HttpStatus.CONFLICT);
      // A pending invitation reserves a seat, so acceptance needs no second check.
      await assertWithinLimit(db, 'maxUsers');
      const [row] = await db
        .insert(memberInvitations)
        .values({
          tenantId: tenantOf(auth).tenantId,
          email: input.email,
          roles: input.roles as InvitedRole[],
          tokenHash: hashToken(token),
          invitedBy: auth.userId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        })
        .returning(this.invitationColumns);
      await this.audit(db, auth, 'invitation.created', 'invitation', row!.id, { roles: input.roles });
      return row!;
    });
    // Sent after commit: a mail failure never leaves a half-created invitation. Resend = revoke + invite.
    await this.mailer.send({
      to: input.email,
      template: 'member.invitation',
      subject: 'You have been invited to a business on Tilvara',
      text: `Accept your invitation: ${this.env.APP_PUBLIC_URL}/accept-invite?token=${token}\nThis link expires in 7 days.`,
    });
    return this.present(invitation);
  }

  listInvitations(auth: AuthContext) {
    this.assertCan(auth, 'members.read');
    return this.read(auth, async (db) =>
      (await db.select(this.invitationColumns).from(memberInvitations).orderBy(asc(memberInvitations.createdAt))).map((r) =>
        this.present(r),
      ),
    );
  }

  revokeInvitation(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const [inv] = await db.select(this.invitationColumns).from(memberInvitations).where(eq(memberInvitations.id, id));
      if (!inv) throw notFound('Invitation');
      await this.assertCanGrantAll(db, auth, inv.roles);
      if (inv.status !== 'PENDING') return this.present(inv);
      const [row] = await db
        .update(memberInvitations)
        .set({ status: 'REVOKED', revokedAt: new Date() })
        .where(eq(memberInvitations.id, id))
        .returning(this.invitationColumns);
      await this.audit(db, auth, 'invitation.revoked', 'invitation', id);
      return this.present(row!);
    });
  }

  /** New person: creates the account and joins the tenant atomically, then signs them in. */
  async acceptAsNewUser(input: AcceptInvitationInput, meta: RequestMeta) {
    const inv = await this.findPendingInvitation(input.token);
    const passwordHash = await this.passwords.hash(input.password);
    try {
      const userId = await this.tenantDb.tx(
        async (tx) => {
          const { rows } = await tx.client.query<{ id: string }>('SELECT auth_register_user($1, $2, $3) AS id', [
            inv.email,
            input.displayName,
            passwordHash,
          ]);
          const id = rows[0]!.id;
          await tx.setUser(id);
          await tx.setTenant(inv.tenant_id);
          await this.join(tx, inv.invitation_id, inv.tenant_id, id, meta.correlationId);
          return id;
        },
        { correlationId: meta.correlationId },
      );
      return this.authService.issueSession(userId, inv.tenant_id, meta);
    } catch (e) {
      const pg = pgError(e);
      if (pg.code === '23505' && pg.constraint === 'users_email_unique') {
        throw new AppError('ACCOUNT_EXISTS', 'You already have an account — sign in and accept the invitation', HttpStatus.CONFLICT);
      }
      throw e;
    }
  }

  /** Signed-in person whose email matches the invitation. */
  async acceptAsExistingUser(auth: AuthContext, token: string) {
    const inv = await this.findPendingInvitation(token);
    return this.tenantDb.tx(
      async (tx) => {
        const { rows } = await tx.client.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId]);
        if (rows[0]?.email.toLowerCase() !== inv.email.toLowerCase()) {
          throw new AppError('INVITATION_EMAIL_MISMATCH', 'This invitation was sent to a different email address', HttpStatus.FORBIDDEN);
        }
        await tx.setTenant(inv.tenant_id);
        const membershipId = await this.join(tx, inv.invitation_id, inv.tenant_id, auth.userId, auth.correlationId);
        return { tenantId: inv.tenant_id, membershipId };
      },
      { userId: auth.userId, correlationId: auth.correlationId },
    );
  }

  // ---------------------------------------------------------------- members
  setMemberRoles(auth: AuthContext, membershipId: string, input: SetMemberRolesInput) {
    return this.ownerSafe(
      this.mutate(auth, async (db) => {
        await this.membership(db, membershipId);
        const current = await this.assignmentsOf(db, membershipId);
        const key = (a: { roleId: string; scopeType: string; scopeId: string | null }) => `${a.roleId}:${a.scopeType}:${a.scopeId}`;
        const wanted = new Set(input.roles.map(key));
        const have = new Set(current.map(key));
        const removed = current.filter((a) => !wanted.has(key(a)));
        const added = input.roles.filter((a) => !have.has(key(a)));
        await this.assertCanGrantAll(db, auth, [...removed, ...added]);
        if (removed.length) await db.delete(membershipRoles).where(inArray(membershipRoles.id, removed.map((r) => r.id)));
        if (added.length) {
          await db.insert(membershipRoles).values(
            added.map((a) => ({ tenantId: tenantOf(auth).tenantId, membershipId, roleId: a.roleId, scopeType: a.scopeType, scopeId: a.scopeId })),
          );
        }
        await this.audit(db, auth, 'member.roles_changed', 'membership', membershipId, { added, removed: removed.map(({ id: _id, ...r }) => r) });
        return { membershipId, roles: await this.assignmentsOf(db, membershipId) };
      }),
    );
  }

  setMemberStatus(auth: AuthContext, membershipId: string, action: 'suspend' | 'reactivate' | 'remove') {
    return this.ownerSafe(
      this.mutate(auth, async (db) => {
        const m = await this.membership(db, membershipId);
        // You may only act on people whose access you could have granted yourself.
        await this.assertCanGrantAll(db, auth, await this.assignmentsOf(db, membershipId));
        const transitions: Record<string, { from: string[]; to: 'ACTIVE' | 'SUSPENDED' | 'REMOVED' }> = {
          suspend: { from: ['ACTIVE'], to: 'SUSPENDED' },
          reactivate: { from: ['SUSPENDED'], to: 'ACTIVE' },
          remove: { from: ['ACTIVE', 'SUSPENDED'], to: 'REMOVED' },
        };
        const t = transitions[action]!;
        if (!t.from.includes(m.status)) {
          throw new AppError('INVALID_STATE_TRANSITION', `Cannot ${action} a ${m.status.toLowerCase()} member`, HttpStatus.CONFLICT);
        }
        await db.update(tenantMemberships).set({ status: t.to }).where(eq(tenantMemberships.id, membershipId));
        if (t.to === 'REMOVED') await db.delete(membershipRoles).where(eq(membershipRoles.membershipId, membershipId));
        await this.audit(db, auth, `member.${action === 'remove' ? 'removed' : action === 'suspend' ? 'suspended' : 'reactivated'}`, 'membership', membershipId);
        return { membershipId, status: t.to };
      }),
    );
  }

  /**
   * A member lost their phone and recovery codes: an owner/admin clears their two-step sign-in. The
   * member's sessions end; a privileged member sets up a new factor at the next sign-in. Only for
   * people whose access the actor could have granted (like suspend/remove), never oneself.
   */
  resetMemberMfa(auth: AuthContext, membershipId: string, reason: string) {
    this.assertCan(auth, 'members.manage');
    return this.mutate(auth, async (db) => {
      const m = await this.membership(db, membershipId);
      if (m.userId === auth.userId) throw new AppError('MFA_RESET_SELF', 'Use one of your recovery codes to sign in, then set up two-step sign-in again', HttpStatus.CONFLICT);
      await this.assertCanGrantAll(db, auth, await this.assignmentsOf(db, membershipId));
      let reset: boolean;
      try {
        const { rows } = await db.execute<{ v: boolean }>(sql`SELECT auth_mfa_admin_reset(${m.userId}, ${auth.userId}, ${reason}, ${auth.correlationId ?? null}) AS v`);
        reset = rows[0]!.v;
      } catch (e) {
        const pg = pgError(e);
        if (pg.constraint === 'mfa_reset_forbidden') throw new AppError('FORBIDDEN', 'Only someone who manages the whole team can reset two-step sign-in', HttpStatus.FORBIDDEN, { missing: ['members.manage'] });
        throw e;
      }
      if (!reset) throw new AppError('MFA_NOT_ENABLED', 'This member does not use two-step sign-in', HttpStatus.CONFLICT);
      await this.audit(db, auth, 'member.mfa_reset', 'membership', membershipId, { reason });
      return { membershipId, mfaReset: true };
    });
  }

  /** Who in this business has two-step sign-in on (the member page offers a reset only for them). */
  membersMfa(auth: AuthContext) {
    this.assertCan(auth, 'members.read');
    return this.read(auth, async (db) => {
      const { rows } = await db.execute<{ user_id: string; enrolled: boolean }>(sql`SELECT user_id, enrolled FROM auth_members_mfa()`);
      return { data: rows.map((r) => ({ userId: r.user_id, enrolled: r.enrolled })) };
    });
  }

  // ---------------------------------------------------------------- custom roles
  createRole(auth: AuthContext, input: CreateRoleInput) {
    this.assertCan(auth, 'roles.manage');
    this.assertHoldsTenantWide(auth, input.permissions);
    return this.mutate(auth, async (db) => {
      const tenantId = tenantOf(auth).tenantId;
      const [role] = await db.insert(roles).values({ tenantId, key: input.key, name: input.name, isSystem: false }).returning();
      await db.insert(rolePermissions).values(input.permissions.map((p) => ({ tenantId, roleId: role!.id, permissionCode: p })));
      await this.audit(db, auth, 'role.created', 'role', role!.id, { key: role!.key, permissions: input.permissions });
      return { ...role!, permissions: input.permissions };
    });
  }

  updateRole(auth: AuthContext, id: string, input: UpdateRoleInput) {
    this.assertCan(auth, 'roles.manage');
    return this.mutate(auth, async (db) => {
      const role = (await this.rolesById(db, [id])).get(id);
      if (!role) throw notFound('Role');
      if (role.isSystem) throw new AppError('SYSTEM_ROLE_READONLY', 'System roles cannot be edited; create a custom role', HttpStatus.CONFLICT);
      if (role.archivedAt) throw archived('Role');
      if (input.permissions) {
        this.assertHoldsTenantWide(auth, [...role.permissions, ...input.permissions]);
        await db.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
        await db
          .insert(rolePermissions)
          .values(input.permissions.map((p) => ({ tenantId: tenantOf(auth).tenantId, roleId: id, permissionCode: p })));
      }
      if (input.name) await db.update(roles).set({ name: input.name }).where(eq(roles.id, id));
      await this.audit(db, auth, 'role.updated', 'role', id, { before: role.permissions, after: input.permissions ?? role.permissions });
      return { ...role, name: input.name ?? role.name, permissions: input.permissions ?? role.permissions };
    });
  }

  archiveRole(auth: AuthContext, id: string) {
    this.assertCan(auth, 'roles.manage');
    return this.mutate(auth, async (db) => {
      const role = (await this.rolesById(db, [id])).get(id);
      if (!role) throw notFound('Role');
      if (role.isSystem) throw new AppError('SYSTEM_ROLE_READONLY', 'System roles cannot be archived', HttpStatus.CONFLICT);
      this.assertHoldsTenantWide(auth, role.permissions);
      const [used] = await db.select({ id: membershipRoles.id }).from(membershipRoles).where(eq(membershipRoles.roleId, id)).limit(1);
      if (used) throw new AppError('ROLE_IN_USE', 'Unassign this role from all members first', HttpStatus.CONFLICT);
      await db.update(roles).set({ archivedAt: new Date() }).where(eq(roles.id, id));
      await this.audit(db, auth, 'role.archived', 'role', id);
      return { id, archived: true };
    });
  }

  // ---------------------------------------------------------------- helpers
  private readonly invitationColumns = {
    id: memberInvitations.id,
    email: memberInvitations.email,
    roles: memberInvitations.roles,
    status: memberInvitations.status,
    invitedBy: memberInvitations.invitedBy,
    expiresAt: memberInvitations.expiresAt,
    acceptedAt: memberInvitations.acceptedAt,
    revokedAt: memberInvitations.revokedAt,
    createdAt: memberInvitations.createdAt,
  };

  private present<T extends { status: string; expiresAt: Date }>(inv: T) {
    const expired = inv.status === 'PENDING' && inv.expiresAt.getTime() <= Date.now();
    return { ...inv, status: expired ? 'EXPIRED' : inv.status };
  }

  private async findPendingInvitation(token: string) {
    const { rows } = await this.tenantDb.tx((tx) =>
      tx.client.query<{ invitation_id: string; tenant_id: string; email: string; status: string; expires_at: Date }>(
        'SELECT * FROM auth_find_invitation($1)',
        [hashToken(token)],
      ),
    );
    const inv = rows[0];
    if (!inv || inv.status !== 'PENDING' || inv.expires_at.getTime() <= Date.now()) throw invalidInvitation();
    return inv;
  }

  /** Inside a tx with tenant context = invitation tenant. Locks the invitation so it can be used once. */
  private async join(tx: Tx, invitationId: string, tenantId: string, userId: string, correlationId: string | undefined): Promise<string> {
    const { db } = tx;
    await assertWritable(db);
    const [inv] = await db
      .select(this.invitationColumns)
      .from(memberInvitations)
      .where(eq(memberInvitations.id, invitationId))
      .for('update');
    if (!inv || inv.status !== 'PENDING' || inv.expiresAt.getTime() <= Date.now()) throw invalidInvitation();

    const roleInfo = await this.rolesById(db, inv.roles.map((r) => r.roleId));
    if (inv.roles.some((r) => !roleInfo.get(r.roleId) || roleInfo.get(r.roleId)!.archivedAt)) {
      throw new AppError('INVITATION_STALE', 'A role in this invitation no longer exists; ask for a new invitation', HttpStatus.CONFLICT);
    }

    const [existing] = await db.select().from(tenantMemberships).where(eq(tenantMemberships.userId, userId));
    let membershipId: string;
    if (existing) {
      if (existing.status === 'ACTIVE') throw new AppError('ALREADY_MEMBER', 'You are already a member of this business', HttpStatus.CONFLICT);
      await db.update(tenantMemberships).set({ status: 'ACTIVE' }).where(eq(tenantMemberships.id, existing.id));
      await db.delete(membershipRoles).where(eq(membershipRoles.membershipId, existing.id));
      membershipId = existing.id;
    } else {
      const [m] = await db.insert(tenantMemberships).values({ tenantId, userId, status: 'ACTIVE' }).returning({ id: tenantMemberships.id });
      membershipId = m!.id;
    }
    await db
      .insert(membershipRoles)
      .values(inv.roles.map((r) => ({ tenantId, membershipId, roleId: r.roleId, scopeType: r.scopeType, scopeId: r.scopeId })));
    await db
      .update(memberInvitations)
      .set({ status: 'ACCEPTED', acceptedAt: new Date(), acceptedUserId: userId })
      .where(eq(memberInvitations.id, invitationId));
    await recordAudit(db, {
      tenantId,
      actorUserId: userId,
      action: 'member.joined',
      resourceType: 'membership',
      resourceId: membershipId,
      correlationId: correlationId ?? null,
      metadata: { invitationId },
    });
    return membershipId;
  }

  /**
   * Anti-escalation: for each assignment the actor needs members.manage AND every permission
   * of the role, at a scope covering the assignment's scope. A branch admin can therefore only
   * hand out branch-level access they themselves hold, and nobody but an owner can mint owners.
   */
  private async assertCanGrantAll(db: Database, auth: AuthContext, assignments: readonly Pick<RoleAssignment, 'roleId' | 'scopeType' | 'scopeId'>[]) {
    if (assignments.length === 0) return;
    const roleInfo = await this.rolesById(db, assignments.map((a) => a.roleId));
    const grants = tenantOf(auth).grants;
    for (const a of assignments) {
      const role = roleInfo.get(a.roleId);
      if (!role) throw notFound('Role');
      if (role.archivedAt) throw archived('Role');
      const scope = await this.scopeChain(db, a.scopeType, a.scopeId);
      if (!hasPermission(grants, 'members.manage', scope)) {
        throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: ['members.manage'] });
      }
      if (!role.permissions.every((p) => hasPermission(grants, p, scope))) throw escalation();
    }
  }

  private assertHoldsTenantWide(auth: AuthContext, perms: readonly PermissionCode[]) {
    const grants = tenantOf(auth).grants;
    if (!perms.every((p) => hasPermission(grants, p))) throw escalation();
  }

  private async scopeChain(db: Database, scopeType: string, scopeId: string | null): Promise<ResourceScope> {
    switch (scopeType) {
      case 'TENANT':
        return {};
      case 'LEGAL_ENTITY': {
        const { rows } = await db.execute<{ id: string }>(sql`SELECT id FROM legal_entities WHERE id = ${scopeId}`);
        if (!rows[0]) throw notFound('Legal entity');
        return { legalEntityId: scopeId! };
      }
      case 'BRANCH': {
        const [b] = await db.select({ le: branches.legalEntityId }).from(branches).where(eq(branches.id, scopeId!));
        if (!b) throw notFound('Branch');
        return { legalEntityId: b.le, branchId: scopeId! };
      }
      case 'REGISTER': {
        const [r] = await db
          .select({ branchId: registers.branchId, le: branches.legalEntityId })
          .from(registers)
          .innerJoin(branches, eq(branches.id, registers.branchId))
          .where(eq(registers.id, scopeId!));
        if (!r) throw notFound('Register');
        return { legalEntityId: r.le, branchId: r.branchId, registerId: scopeId! };
      }
      default:
        throw new AppError('VALIDATION_FAILED', 'Unknown scope type', HttpStatus.BAD_REQUEST);
    }
  }

  private async rolesById(db: Database, ids: string[]): Promise<Map<string, RoleInfo>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await db
      .select({ id: roles.id, key: roles.key, name: roles.name, isSystem: roles.isSystem, archivedAt: roles.archivedAt, permission: rolePermissions.permissionCode })
      .from(roles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(inArray(roles.id, unique));
    const map = new Map<string, RoleInfo>();
    for (const r of rows) {
      const info = map.get(r.id) ?? { id: r.id, key: r.key, name: r.name, isSystem: r.isSystem, archivedAt: r.archivedAt, permissions: [] };
      if (r.permission) info.permissions.push(r.permission as PermissionCode);
      map.set(r.id, info);
    }
    return map;
  }

  private async membership(db: Database, id: string) {
    const [m] = await db.select().from(tenantMemberships).where(eq(tenantMemberships.id, id));
    if (!m) throw notFound('Member');
    return m;
  }

  private assignmentsOf(db: Database, membershipId: string) {
    return db
      .select({ id: membershipRoles.id, roleId: membershipRoles.roleId, scopeType: membershipRoles.scopeType, scopeId: membershipRoles.scopeId })
      .from(membershipRoles)
      .where(eq(membershipRoles.membershipId, membershipId));
  }

  /** Map the deferred "keep an owner" DB guard to a clear 409. */
  private async ownerSafe<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (e) {
      if (e instanceof AppError && e.code === 'INVALID_STATE' && /active owner/.test(e.message)) {
        throw new AppError('LAST_OWNER', 'A business must keep at least one active owner', HttpStatus.CONFLICT);
      }
      throw e;
    }
  }
}
