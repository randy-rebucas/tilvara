import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  branches,
  cashierSessions,
  cashMovements,
  cashReconciliations,
  desc,
  eq,
  registers,
  sql,
  type Database,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type { ApproveVarianceInput, CashierSessionListQuery, CashMovementInput, CloseCashierSessionInput, OpenCashierSessionInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import type { ResourceScope } from '../auth/authorization.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

export type SessionRow = typeof cashierSessions.$inferSelect;

const money = (v: string | null | undefined) => (v == null ? null : toDec(v).toFixed(2));

/** Register + its branch/entity chain, for scope-aware permission checks. */
export async function registerScope(db: Database, registerId: string) {
  const [row] = await db
    .select({ register: registers, legalEntityId: branches.legalEntityId })
    .from(registers)
    .innerJoin(branches, eq(branches.id, registers.branchId))
    .where(eq(registers.id, registerId));
  if (!row) throw notFound('Register');
  const scope: Required<ResourceScope> = { legalEntityId: row.legalEntityId, branchId: row.register.branchId, registerId: row.register.id };
  return { register: row.register, scope };
}

/** Load a session, optionally row-locked for a state change. */
export async function loadSession(db: Database, id: string, lock = false) {
  const query = db.select().from(cashierSessions).where(eq(cashierSessions.id, id));
  const [session] = lock ? await query.for('update') : await query;
  if (!session) throw notFound('Cashier session');
  const { scope } = await registerScope(db, session.registerId);
  return { session, scope };
}

export async function expectedCash(db: Database, sessionId: string): Promise<string> {
  const { rows } = await db.execute<{ total: string | null }>(
    sql`SELECT coalesce(sum(amount), 0)::text AS total FROM cash_movements WHERE cashier_session_id = ${sessionId}`,
  );
  return rows[0]!.total ?? '0';
}

@Injectable()
export class CashService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    cashier_sessions_one_open_per_register: ['SESSION_ALREADY_OPEN', 'This register already has an open cashier session'],
    cash_reconciliations_session_unique: ['SESSION_ALREADY_CLOSED', 'This session has already been counted'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  open(auth: AuthContext, input: OpenCashierSessionInput) {
    return this.mutate(auth, async (db) => {
      const { register, scope } = await registerScope(db, input.registerId);
      this.assertCan(auth, 'cash.session', scope);
      if (register.archivedAt) throw archived('Register');
      const tenantId = tenantOf(auth).tenantId;
      const [session] = await db
        .insert(cashierSessions)
        .values({ tenantId, branchId: register.branchId, registerId: register.id, openedBy: auth.userId, openingFloat: input.openingFloat })
        .returning();
      await db.insert(cashMovements).values({
        tenantId,
        cashierSessionId: session!.id,
        type: 'OPENING_FLOAT',
        amount: input.openingFloat,
        createdBy: auth.userId,
      });
      await this.audit(db, auth, 'cashier_session.opened', 'cashier_session', session!.id, { registerId: register.id, openingFloat: input.openingFloat });
      return this.view(db, session!);
    });
  }

  list(auth: AuthContext, q: CashierSessionListQuery) {
    return this.read(auth, async (db) => {
      const where = and(
        q.registerId ? eq(cashierSessions.registerId, q.registerId) : undefined,
        q.status ? eq(cashierSessions.status, q.status) : undefined,
      );
      const rows = await db
        .select({ session: cashierSessions, legalEntityId: branches.legalEntityId })
        .from(cashierSessions)
        .innerJoin(branches, eq(branches.id, cashierSessions.branchId))
        .where(where)
        .orderBy(desc(cashierSessions.openedAt))
        .limit(200);
      const visible = rows.filter(({ session, legalEntityId }) => {
        const scope = { legalEntityId, branchId: session.branchId, registerId: session.registerId };
        return this.can(auth, 'cash.reconcile', scope) || (this.can(auth, 'cash.session', scope) && session.openedBy === auth.userId);
      });
      return { data: await Promise.all(visible.map((r) => this.view(db, r.session))) };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const { session, scope } = await loadSession(db, id);
      this.assertCanSee(auth, session, scope);
      return this.view(db, session, true);
    });
  }

  addMovement(auth: AuthContext, id: string, input: CashMovementInput) {
    return this.mutate(auth, async (db) => {
      const { session, scope } = await loadSession(db, id, true);
      this.assertCanOperate(auth, session, scope);
      if (session.status !== 'OPEN') throw notOpen();
      const amount = input.type === 'PAY_OUT' ? toDec(input.amount).negated().toString() : input.amount;
      const [row] = await db
        .insert(cashMovements)
        .values({ tenantId: tenantOf(auth).tenantId, cashierSessionId: id, type: input.type, amount, reason: input.reason, createdBy: auth.userId })
        .returning();
      await this.audit(db, auth, `cash.${input.type.toLowerCase()}`, 'cashier_session', id, { amount: input.amount, reason: input.reason });
      return { ...row!, amount: money(row!.amount) };
    });
  }

  /** Count the drawer. Zero variance reconciles immediately; otherwise a second person approves. */
  close(auth: AuthContext, id: string, input: CloseCashierSessionInput) {
    return this.mutate(auth, async (db) => {
      const { session, scope } = await loadSession(db, id, true);
      this.assertCanOperate(auth, session, scope);
      if (session.status !== 'OPEN') throw notOpen();
      const expected = await expectedCash(db, id);
      const variance = toDec(input.countedCash).minus(expected).toString();
      await db.insert(cashReconciliations).values({
        tenantId: tenantOf(auth).tenantId,
        cashierSessionId: id,
        expectedCash: expected,
        countedCash: input.countedCash,
        variance,
        countedBy: auth.userId,
        note: input.note ?? null,
      });
      await db.update(cashierSessions).set({ status: 'CLOSED', closedBy: auth.userId, closedAt: sql`now()` }).where(eq(cashierSessions.id, id));
      if (toDec(variance).isZero()) await db.update(cashierSessions).set({ status: 'RECONCILED' }).where(eq(cashierSessions.id, id));
      await this.audit(db, auth, 'cashier_session.closed', 'cashier_session', id, { expected, counted: input.countedCash, variance });
      const [updated] = await db.select().from(cashierSessions).where(eq(cashierSessions.id, id));
      return this.view(db, updated!, true);
    });
  }

  approveVariance(auth: AuthContext, id: string, input: ApproveVarianceInput) {
    return this.mutate(auth, async (db) => {
      const { session, scope } = await loadSession(db, id, true);
      this.assertCan(auth, 'cash.reconcile', scope);
      if (session.status !== 'CLOSED') {
        throw new AppError('INVALID_STATE', 'Only a closed session with a variance awaits approval', HttpStatus.CONFLICT);
      }
      const [rec] = await db.select().from(cashReconciliations).where(eq(cashReconciliations.cashierSessionId, id));
      if (rec!.countedBy === auth.userId) {
        throw new AppError('SELF_APPROVAL', 'A different person must approve a cash variance', HttpStatus.FORBIDDEN);
      }
      await db
        .update(cashReconciliations)
        .set({ approvedBy: auth.userId, approvedAt: sql`now()`, approvalNote: input.note })
        .where(eq(cashReconciliations.id, rec!.id));
      await db.update(cashierSessions).set({ status: 'RECONCILED' }).where(eq(cashierSessions.id, id));
      await this.audit(db, auth, 'cashier_session.variance_approved', 'cashier_session', id, { variance: rec!.variance, note: input.note });
      const [updated] = await db.select().from(cashierSessions).where(eq(cashierSessions.id, id));
      return this.view(db, updated!, true);
    });
  }

  /** The session's own cashier (with cash.session) or anyone with cash.reconcile at that register. */
  assertCanOperate(auth: AuthContext, session: SessionRow, scope: ResourceScope) {
    if (this.can(auth, 'cash.reconcile', scope)) return;
    this.assertCan(auth, 'cash.session', scope);
    if (session.openedBy !== auth.userId) {
      throw new AppError('NOT_SESSION_OWNER', 'This cashier session belongs to someone else', HttpStatus.FORBIDDEN);
    }
  }

  private assertCanSee(auth: AuthContext, session: SessionRow, scope: ResourceScope) {
    if (this.can(auth, 'cash.reconcile', scope) || this.can(auth, 'sales.read', scope)) return;
    this.assertCanOperate(auth, session, scope);
  }

  private async view(db: Database, s: SessionRow, detailed = false) {
    const expected = await expectedCash(db, s.id);
    const base = {
      ...s,
      openingFloat: money(s.openingFloat),
      expectedCash: money(expected),
    };
    if (!detailed) return base;
    const { rows: byType } = await db.execute<{ type: string; total: string; count: number }>(
      sql`SELECT type, sum(amount)::text AS total, count(*)::int AS count FROM cash_movements WHERE cashier_session_id = ${s.id} GROUP BY type ORDER BY type`,
    );
    const { rows: salesAgg } = await db.execute<{ count: number; total: string | null }>(
      sql`SELECT count(*)::int AS count, sum(amount_due)::text AS total FROM sales WHERE cashier_session_id = ${s.id}`,
    );
    const [rec] = await db.select().from(cashReconciliations).where(eq(cashReconciliations.cashierSessionId, s.id));
    return {
      ...base,
      movements: byType.map((m) => ({ type: m.type, total: money(m.total), count: m.count })),
      sales: { count: salesAgg[0]!.count, total: money(salesAgg[0]!.total ?? '0') },
      reconciliation: rec
        ? { ...rec, expectedCash: money(rec.expectedCash), countedCash: money(rec.countedCash), variance: money(rec.variance) }
        : null,
    };
  }
}

const notOpen = () => new AppError('SESSION_NOT_OPEN', 'This cashier session is not open', HttpStatus.CONFLICT);
