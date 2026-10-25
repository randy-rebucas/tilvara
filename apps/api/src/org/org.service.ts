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
  inSequence,
} from '@1pos/database';
import type {
  PermissionCode,
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
import { assertFeature, assertWithinLimit, usageOf } from '../billing/entitlements.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { insertProfile, profilesInForce, scheduledProfiles, type TaxProfileView } from '../tax/tax-profiles.js';
import { seedChart } from '../accounting/ledger.js';

type LegalEntityRow = typeof legalEntities.$inferSelect;

/** Any of these at a branch lets the user see that branch in GET /v1/branches (a cashier picks their own at the till). */
const BRANCH_READERS: PermissionCode[] = ['org.read', 'inventory.read', 'inventory.adjust', 'inventory.count', 'inventory.transfer', 'purchasing.manage', 'cash.session'];

/** Legal entity plus the tax profile in force (and the next scheduled one), ADR-0008. */
async function withTaxProfiles(db: Database, rows: LegalEntityRow[]) {
  const ids = rows.map((r) => r.id);
  const [current, next] = await inSequence(() => profilesInForce(db, ids), () => scheduledProfiles(db, ids));
  return rows.map((r) => {
    const taxProfile: TaxProfileView | null = current.get(r.id) ?? null;
    return {
      ...r,
      vatStatus: taxProfile?.vatStatus ?? null,
      roundingMode: taxProfile?.roundingMode ?? null,
      taxProfile,
      scheduledTaxProfile: next.get(r.id) ?? null,
    };
  });
}

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
      return withTaxProfiles(db, rows.filter((r) => this.can(auth, 'org.read', { legalEntityId: r.id })));
    });
  }

  createLegalEntity(auth: AuthContext, input: CreateLegalEntityInput) {
    this.assertCan(auth, 'org.manage');
    return this.mutate(auth, async (db) => {
      await assertWithinLimit(db, 'maxLegalEntities');
      // A second (live) entity is the plan's `multi_entity` feature, on top of its entity limit.
      if ((await usageOf(db, 'maxLegalEntities')) > 0) await assertFeature(db, 'multi_entity');
      const { vatStatus, roundingMode, ...entity } = input;
      const tenantId = tenantOf(auth).tenantId;
      const [row] = await db.insert(legalEntities).values({ ...entity, tenantId }).returning();
      // The initial tax profile is created atomically with the entity.
      await insertProfile(db, { tenantId, legalEntityId: row!.id, vatStatus, roundingMode, createdBy: auth.userId, note: 'Initial profile' });
      // Its books exist from the start: every sale and stock movement posts to them (ADR-0013).
      await seedChart(db, tenantId, row!.id);
      await this.audit(db, auth, 'legal_entity.created', 'legal_entity', row!.id, { vatStatus });
      return (await withTaxProfiles(db, [row!]))[0]!;
    });
  }

  updateLegalEntity(auth: AuthContext, id: string, input: UpdateLegalEntityInput) {
    return this.mutate(auth, async (db) => {
      const current = await this.legalEntity(db, id);
      this.assertCan(auth, 'org.manage', { legalEntityId: id });
      if (current.archivedAt) throw archived('Legal entity');
      const [row] = await db.update(legalEntities).set(input).where(eq(legalEntities.id, id)).returning();
      await this.audit(db, auth, 'legal_entity.updated', 'legal_entity', id, { fields: Object.keys(input) });
      return (await withTaxProfiles(db, [row!]))[0]!;
    });
  }

  archiveLegalEntity(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const current = await this.legalEntity(db, id);
      this.assertCan(auth, 'org.manage', { legalEntityId: id });
      if (current.archivedAt) return (await withTaxProfiles(db, [current]))[0]!;
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
      return (await withTaxProfiles(db, [row!]))[0]!;
    });
  }

  // ---------------------------------------------------------------- branches
  listBranches(auth: AuthContext) {
    return this.tenantDb.run(auth, async (db) => {
      const rows = await db.select().from(branches).orderBy(asc(branches.code));
      // Org readers see branches; so do people who work stock at a branch (they pick it in the
      // admin's inventory and purchasing screens) — that branch only, never the others.
      return rows.filter((r) => BRANCH_READERS.some((p) => this.can(auth, p, { legalEntityId: r.legalEntityId, branchId: r.id })));
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
