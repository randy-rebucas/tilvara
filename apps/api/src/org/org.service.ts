import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  branches,
  eq,
  isNull,
  legalEntities,
  registers,
  terminals,
  type Database,
} from '@1pos/database';
import type {
  CreateBranchInput,
  CreateLegalEntityInput,
  CreateRegisterInput,
  RegisterTerminalInput,
  UpdateBranchInput,
  UpdateLegalEntityInput,
  UpdateRegisterInput,
} from '@1pos/validation';
import { createHash, randomBytes } from 'node:crypto';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertWithinLimit } from '../billing/entitlements.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

@Injectable()
export class OrgService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    legal_entities_tenant_tin_unique: ['TIN_TAKEN', 'Another legal entity already uses this TIN'],
    branches_tenant_code_unique: ['CODE_TAKEN', 'Another branch already uses this code'],
    branches_entity_bir_code_unique: ['BIR_BRANCH_CODE_TAKEN', 'This BIR branch code is already used by this legal entity'],
    registers_branch_code_unique: ['CODE_TAKEN', 'Another register in this branch already uses this code'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- legal entities
  listLegalEntities(auth: AuthContext) {
    return this.tenantDb.run(auth, async (db) => {
      const rows = await db.select().from(legalEntities).orderBy(asc(legalEntities.registeredName));
      return rows.filter((r) => this.can(auth, 'org.read', { legalEntityId: r.id }));
    });
  }

  createLegalEntity(auth: AuthContext, input: CreateLegalEntityInput) {
    this.assertCan(auth, 'org.manage');
    return this.mutate(auth, async (db) => {
      await assertWithinLimit(db, 'maxLegalEntities');
      const [row] = await db
        .insert(legalEntities)
        .values({ ...input, tenantId: tenantOf(auth).tenantId })
        .returning();
      await this.audit(db, auth, 'legal_entity.created', 'legal_entity', row!.id, { vatStatus: row!.vatStatus });
      return row!;
    });
  }

  updateLegalEntity(auth: AuthContext, id: string, input: UpdateLegalEntityInput) {
    return this.mutate(auth, async (db) => {
      const current = await this.legalEntity(db, id);
      this.assertCan(auth, 'org.manage', { legalEntityId: id });
      if (current.archivedAt) throw archived('Legal entity');
      const [row] = await db.update(legalEntities).set(input).where(eq(legalEntities.id, id)).returning();
      await this.audit(db, auth, 'legal_entity.updated', 'legal_entity', id, { fields: Object.keys(input) });
      return row!;
    });
  }

  archiveLegalEntity(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const current = await this.legalEntity(db, id);
      this.assertCan(auth, 'org.manage', { legalEntityId: id });
      if (current.archivedAt) return current;
      const active = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.legalEntityId, id), isNull(branches.archivedAt)))
        .limit(1);
      if (active.length > 0) {
        throw new AppError('HAS_ACTIVE_CHILDREN', 'Archive its branches first', HttpStatus.CONFLICT);
      }
      const [row] = await db.update(legalEntities).set({ archivedAt: new Date() }).where(eq(legalEntities.id, id)).returning();
      await this.audit(db, auth, 'legal_entity.archived', 'legal_entity', id);
      return row!;
    });
  }

  // ---------------------------------------------------------------- branches
  listBranches(auth: AuthContext) {
    return this.tenantDb.run(auth, async (db) => {
      const rows = await db.select().from(branches).orderBy(asc(branches.code));
      return rows.filter((r) => this.can(auth, 'org.read', { legalEntityId: r.legalEntityId, branchId: r.id }));
    });
  }

  createBranch(auth: AuthContext, input: CreateBranchInput) {
    return this.mutate(auth, async (db) => {
      const entity = await this.legalEntity(db, input.legalEntityId);
      this.assertCan(auth, 'org.manage', { legalEntityId: entity.id });
      if (entity.archivedAt) throw archived('Legal entity');
      await assertWithinLimit(db, 'maxBranches');
      const [row] = await db
        .insert(branches)
        .values({ ...input, tenantId: tenantOf(auth).tenantId })
        .returning();
      await this.audit(db, auth, 'branch.created', 'branch', row!.id, { code: row!.code, legalEntityId: entity.id });
      return row!;
    });
  }

  updateBranch(auth: AuthContext, id: string, input: UpdateBranchInput) {
    return this.mutate(auth, async (db) => {
      const current = await this.branch(db, id);
      this.assertCan(auth, 'org.manage', { legalEntityId: current.legalEntityId, branchId: id });
      if (current.archivedAt) throw archived('Branch');
      const [row] = await db.update(branches).set(input).where(eq(branches.id, id)).returning();
      await this.audit(db, auth, 'branch.updated', 'branch', id, { fields: Object.keys(input) });
      return row!;
    });
  }

  archiveBranch(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const current = await this.branch(db, id);
      this.assertCan(auth, 'org.manage', { legalEntityId: current.legalEntityId, branchId: id });
      if (current.archivedAt) return current;
      const active = await db
        .select({ id: registers.id })
        .from(registers)
        .where(and(eq(registers.branchId, id), isNull(registers.archivedAt)))
        .limit(1);
      if (active.length > 0) throw new AppError('HAS_ACTIVE_CHILDREN', 'Archive its registers first', HttpStatus.CONFLICT);
      const [row] = await db.update(branches).set({ archivedAt: new Date() }).where(eq(branches.id, id)).returning();
      await this.audit(db, auth, 'branch.archived', 'branch', id);
      return row!;
    });
  }

  // ---------------------------------------------------------------- registers
  listRegisters(auth: AuthContext) {
    return this.tenantDb.run(auth, async (db) => {
      const rows = await db
        .select({ register: registers, legalEntityId: branches.legalEntityId })
        .from(registers)
        .innerJoin(branches, eq(branches.id, registers.branchId))
        .orderBy(asc(registers.code));
      return rows
        .filter((r) =>
          this.can(auth, 'org.read', { legalEntityId: r.legalEntityId, branchId: r.register.branchId, registerId: r.register.id }),
        )
        .map((r) => r.register);
    });
  }

  createRegister(auth: AuthContext, input: CreateRegisterInput) {
    return this.mutate(auth, async (db) => {
      const branch = await this.branch(db, input.branchId);
      this.assertCan(auth, 'org.manage', { legalEntityId: branch.legalEntityId, branchId: branch.id });
      if (branch.archivedAt) throw archived('Branch');
      await assertWithinLimit(db, 'maxRegisters');
      const [row] = await db
        .insert(registers)
        .values({ ...input, tenantId: tenantOf(auth).tenantId })
        .returning();
      await this.audit(db, auth, 'register.created', 'register', row!.id, { code: row!.code, branchId: branch.id });
      return row!;
    });
  }

  updateRegister(auth: AuthContext, id: string, input: UpdateRegisterInput) {
    return this.mutate(auth, async (db) => {
      const { register, scope } = await this.registerWithScope(db, id);
      this.assertCan(auth, 'org.manage', scope);
      if (register.archivedAt) throw archived('Register');
      const [row] = await db.update(registers).set(input).where(eq(registers.id, id)).returning();
      await this.audit(db, auth, 'register.updated', 'register', id, { fields: Object.keys(input) });
      return row!;
    });
  }

  archiveRegister(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const { register, scope } = await this.registerWithScope(db, id);
      this.assertCan(auth, 'org.manage', scope);
      if (register.archivedAt) return register;
      const active = await db
        .select({ id: terminals.id })
        .from(terminals)
        .where(and(eq(terminals.registerId, id), eq(terminals.status, 'ACTIVE')))
        .limit(1);
      if (active.length > 0) throw new AppError('HAS_ACTIVE_CHILDREN', 'Revoke its terminals first', HttpStatus.CONFLICT);
      const [row] = await db.update(registers).set({ archivedAt: new Date() }).where(eq(registers.id, id)).returning();
      await this.audit(db, auth, 'register.archived', 'register', id);
      return row!;
    });
  }

  // ---------------------------------------------------------------- terminals
  private readonly terminalColumns = {
    id: terminals.id,
    registerId: terminals.registerId,
    name: terminals.name,
    status: terminals.status,
    credentialHint: terminals.credentialHint,
    lastSeenAt: terminals.lastSeenAt,
    revokedAt: terminals.revokedAt,
    revokeReason: terminals.revokeReason,
    createdAt: terminals.createdAt,
  };

  listTerminals(auth: AuthContext) {
    return this.tenantDb.run(auth, async (db) => {
      const rows = await db
        .select({ terminal: this.terminalColumns, branchId: registers.branchId, legalEntityId: branches.legalEntityId })
        .from(terminals)
        .innerJoin(registers, eq(registers.id, terminals.registerId))
        .innerJoin(branches, eq(branches.id, registers.branchId))
        .orderBy(asc(terminals.name));
      return rows
        .filter((r) =>
          this.can(auth, 'terminals.manage', {
            legalEntityId: r.legalEntityId,
            branchId: r.branchId,
            registerId: r.terminal.registerId,
          }),
        )
        .map((r) => r.terminal);
    });
  }

  /** Returns the credential secret exactly once; only its hash is stored. */
  registerTerminal(auth: AuthContext, input: RegisterTerminalInput) {
    return this.mutate(auth, async (db) => {
      const { register, scope } = await this.registerWithScope(db, input.registerId);
      this.assertCan(auth, 'terminals.manage', scope);
      if (register.archivedAt) throw archived('Register');
      const secret = `tpk_${randomBytes(32).toString('base64url')}`;
      const [row] = await db
        .insert(terminals)
        .values({
          tenantId: tenantOf(auth).tenantId,
          registerId: register.id,
          name: input.name,
          credentialHash: createHash('sha256').update(secret).digest('hex'),
          credentialHint: secret.slice(-4),
        })
        .returning(this.terminalColumns);
      await this.audit(db, auth, 'terminal.registered', 'terminal', row!.id, { registerId: register.id });
      return { terminal: row!, credential: secret };
    });
  }

  revokeTerminal(auth: AuthContext, id: string, reason: string) {
    return this.mutate(auth, async (db) => {
      const [t] = await db.select(this.terminalColumns).from(terminals).where(eq(terminals.id, id));
      if (!t) throw notFound('Terminal');
      const { scope } = await this.registerWithScope(db, t.registerId);
      this.assertCan(auth, 'terminals.manage', scope);
      if (t.status === 'REVOKED') return t;
      const [row] = await db
        .update(terminals)
        .set({ status: 'REVOKED', revokedAt: new Date(), revokeReason: reason })
        .where(eq(terminals.id, id))
        .returning(this.terminalColumns);
      await this.audit(db, auth, 'terminal.revoked', 'terminal', id, { reason });
      return row!;
    });
  }

  // ---------------------------------------------------------------- helpers
  private async legalEntity(db: Database, id: string) {
    const [row] = await db.select().from(legalEntities).where(eq(legalEntities.id, id));
    if (!row) throw notFound('Legal entity');
    return row;
  }

  private async branch(db: Database, id: string) {
    const [row] = await db.select().from(branches).where(eq(branches.id, id));
    if (!row) throw notFound('Branch');
    return row;
  }

  private async registerWithScope(db: Database, id: string) {
    const [row] = await db
      .select({ register: registers, legalEntityId: branches.legalEntityId })
      .from(registers)
      .innerJoin(branches, eq(branches.id, registers.branchId))
      .where(eq(registers.id, id));
    if (!row) throw notFound('Register');
    return {
      register: row.register,
      scope: { legalEntityId: row.legalEntityId, branchId: row.register.branchId, registerId: row.register.id },
    };
  }
}
