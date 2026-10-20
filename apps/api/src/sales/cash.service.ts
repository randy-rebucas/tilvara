import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  branches,
  cashierSessions,
  cashMovements,
  cashReconciliations,
  desc,
  eq,
  inArray,
  isNull,
  or,
  paymentIntents,
  registers,
  sql,
  terminalTransactions,
  users,
  type Database,
  mapInSequence,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import { cashMovementPosting, cashVariancePosting } from '@1pos/accounting';
import { post } from '../accounting/ledger.js';
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

  /**
   * Registers this user may run a cash session on (POS register picker), with their branch and
   * the user's own open session there, if any. Cashiers lack org.read, so /v1/registers is not usable.
   */
  workstations(auth: AuthContext) {
    return this.read(auth, async (db) => {
      const rows = await db
        .select({ register: registers, branch: branches })
        .from(registers)
        .innerJoin(branches, eq(branches.id, registers.branchId))
        .where(and(isNull(registers.archivedAt), isNull(branches.archivedAt)))
        .orderBy(branches.name, registers.code);
      const usable = rows.filter(({ register, branch }) =>
        this.can(auth, 'cash.session', { legalEntityId: branch.legalEntityId, branchId: branch.id, registerId: register.id }),
      );
      const open = await db.select().from(cashierSessions).where(eq(cashierSessions.status, 'OPEN'));
      return {
        data: usable.map(({ register, branch }) => {
          const session = open.find((s) => s.registerId === register.id);
          return {
            register: { id: register.id, code: register.code, name: register.name },
            branch: { id: branch.id, code: branch.code, name: branch.name, timezone: branch.timezone, legalEntityId: branch.legalEntityId },
            openSession: session ? { id: session.id, openedBy: session.openedBy, mine: session.openedBy === auth.userId, openedAt: session.openedAt } : null,
          };
        }),
      };
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
      // Each counted drawer carries its count, so a manager can see which wait for approval and by how much.
      const recs = visible.length
        ? await db.select().from(cashReconciliations).where(inArray(cashReconciliations.cashierSessionId, visible.map((r) => r.session.id)))
        : [];
      const recOf = new Map(recs.map((rec) => [rec.cashierSessionId, rec]));
      const names = await namesOf(db, [...visible.map((r) => r.session.openedBy), ...recs.flatMap((rec) => [rec.countedBy, rec.approvedBy])]);
      return {
        data: await mapInSequence(visible, async (r) => ({
          ...(await this.view(db, r.session)),
          openedByName: names.get(r.session.openedBy) ?? null,
          reconciliation: reconciliationView(recOf.get(r.session.id), names),
        })),
      };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const { session, scope } = await loadSession(db, id);
      this.assertCanSee(auth, session, scope);
      return this.view(db, session, true);
    });
  }

  /** One drawer movement by id (a pay-in/out's journal entry points here), with its session id. */
  getMovement(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [row] = await db.select().from(cashMovements).where(eq(cashMovements.id, id));
      if (!row) throw notFound('Cash movement');
      const { session, scope } = await loadSession(db, row.cashierSessionId);
      this.assertCanSee(auth, session, scope);
      return { ...row, amount: money(row.amount) };
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
      await post(db, {
        tenantId: tenantOf(auth).tenantId,
        legalEntityId: scope.legalEntityId,
        branchId: session.branchId,
        sourceType: 'CASH_MOVEMENT',
        sourceId: row!.id,
        memo: `${input.type === 'PAY_OUT' ? 'Pay-out' : 'Pay-in'}: ${input.reason}`,
        lines: cashMovementPosting(amount, session.branchId),
        createdBy: auth.userId,
      });
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
      // A charge that belongs to no sale must be settled first (ADR-0010 §6): finish the sale,
      // reconcile, or cancel. New intents need this OPEN session (locked above), so none can appear later.
      const outstanding = await db
        .select({ id: paymentIntents.id, status: paymentIntents.status, method: paymentIntents.method, amount: paymentIntents.amount })
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.cashierSessionId, id),
            or(inArray(paymentIntents.status, ['PROCESSING', 'UNKNOWN']), and(eq(paymentIntents.status, 'SUCCEEDED'), isNull(paymentIntents.saleId))),
          ),
        );
      if (outstanding.length) {
        throw new AppError('PAYMENTS_OUTSTANDING', 'Card/QR payments on this shift are not settled; complete the sale, check or cancel them first', HttpStatus.CONFLICT, {
          payments: outstanding.map((p) => ({ ...p, amount: money(p.amount) })),
        });
      }
      // Offline sales of this shift that could not be recorded wait for a manager (ADR-0015 §5).
      const unresolved = await db
        .select({ id: terminalTransactions.id, errorCode: terminalTransactions.errorCode })
        .from(terminalTransactions)
        .where(and(eq(terminalTransactions.cashierSessionId, id), eq(terminalTransactions.status, 'QUARANTINED')));
      if (unresolved.length) {
        throw new AppError('OFFLINE_SALES_UNRESOLVED', 'Offline sales of this shift could not be recorded; a manager must retry or dismiss them first', HttpStatus.CONFLICT, { offlineSales: unresolved });
      }
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
      // A drawer that is short or over moves the books when counted (approval is about who answers for it).
      await post(db, {
        tenantId: tenantOf(auth).tenantId,
        legalEntityId: scope.legalEntityId,
        branchId: session.branchId,
        sourceType: 'CASH_VARIANCE',
        sourceId: id,
        memo: `Drawer count variance${input.note ? `: ${input.note}` : ''}`,
        lines: cashVariancePosting(variance, session.branchId),
        createdBy: auth.userId,
      });
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
    const names = await namesOf(db, [s.openedBy, rec?.countedBy, rec?.approvedBy]);
    // Pay-ins and pay-outs one by one (each is its own document with a reason and a journal entry).
    const payInOut = await db
      .select({ id: cashMovements.id, type: cashMovements.type, amount: cashMovements.amount, reason: cashMovements.reason, createdBy: cashMovements.createdBy, createdAt: cashMovements.createdAt })
      .from(cashMovements)
      .where(and(eq(cashMovements.cashierSessionId, s.id), inArray(cashMovements.type, ['PAY_IN', 'PAY_OUT'])))
      .orderBy(cashMovements.createdAt, cashMovements.id);
    return {
      ...base,
      openedByName: names.get(s.openedBy) ?? null,
      movements: byType.map((m) => ({ type: m.type, total: money(m.total), count: m.count })),
      payInOut: payInOut.map((m) => ({ ...m, amount: money(m.amount) })),
      sales: { count: salesAgg[0]!.count, total: money(salesAgg[0]!.total ?? '0') },
      reconciliation: reconciliationView(rec, names),
    };
  }
}

/**
 * Display names of the people on a shift. Carried in the response because the person approving a
 * count may hold `cash.reconcile` at one branch only, without the business-wide `members.read`.
 */
async function namesOf(db: Database, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, u.displayName]));
}

const reconciliationView = (rec: typeof cashReconciliations.$inferSelect | undefined, names: Map<string, string>) =>
  rec
    ? {
        ...rec,
        expectedCash: money(rec.expectedCash),
        countedCash: money(rec.countedCash),
        variance: money(rec.variance),
        countedByName: names.get(rec.countedBy) ?? null,
        approvedByName: rec.approvedBy ? (names.get(rec.approvedBy) ?? null) : null,
      }
    : null;

const notOpen = () => new AppError('SESSION_NOT_OPEN', 'This cashier session is not open', HttpStatus.CONFLICT);
