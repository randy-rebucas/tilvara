import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, jobOrders, laundryGarmentTypes, laundryMachines, laundrySettings, machineRuns, productVariants, sql, type Database } from '@1pos/database';
import { toDec } from '@1pos/money';
import type {
  CreateGarmentTypeInput,
  CreateMachineInput,
  JobMachineRunInput,
  LaundrySettingsInput,
  MachineBoardQuery,
  MachineListQuery,
  UpdateGarmentTypeInput,
  UpdateMachineInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertLaundry } from '../billing/entitlements.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { unprocessable } from '../tax/tax.service.js';
import { branchLaundrySettings, jobNumber, jobScope, loadJob, lockMachine, recordStatus } from './job.js';

type MachineRow = typeof laundryMachines.$inferSelect;
const machineView = (m: MachineRow) => ({ ...m, capacityKg: m.capacityKg === null ? null : toDec(m.capacityKg).toString() });

/**
 * A laundry's set-up and machines (ADR-0024 §3, §7, §9): branch settings, the garment types counted
 * at drop-off, washers and dryers, the machine board, and drop-off loads put on a machine.
 */
@Injectable()
export class LaundrySetupService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    laundry_machines_label_active_unique: ['MACHINE_LABEL_TAKEN', 'A machine at this branch already has this label'],
    laundry_garment_types_name_active_unique: ['GARMENT_TYPE_EXISTS', 'This garment type is already on the list'],
    machine_runs_no_overlap: ['MACHINE_BUSY', 'This machine is in use then'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- settings

  getSettings(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, branchId);
      this.assertCan(auth, 'laundry.read', scope);
      return branchLaundrySettings(db, branchId);
    });
  }

  updateSettings(auth: AuthContext, branchId: string, input: LaundrySettingsInput) {
    return this.mutate(auth, async (db) => {
      const { scope } = await branchScope(db, branchId);
      this.assertCan(auth, 'laundry.setup', scope);
      await assertLaundry(db);
      const current = await branchLaundrySettings(db, branchId);
      const unclaimed = input.unclaimedDays ?? current.unclaimedDays;
      const finalNotice = input.finalNoticeDays ?? current.finalNoticeDays;
      if (finalNotice >= unclaimed) throw unprocessable('VALIDATION_FAILED', 'The final notice goes out before the unclaimed day', { path: ['finalNoticeDays'] });
      for (const key of ['expressVariantId', 'deliveryVariantId', 'storageFeeVariantId'] as const) {
        const id = input[key];
        if (!id) continue;
        const [v] = await db.select({ id: productVariants.id, archivedAt: productVariants.archivedAt }).from(productVariants).where(eq(productVariants.id, id));
        if (!v) throw new AppError('NOT_FOUND', 'Item not found', HttpStatus.NOT_FOUND, { path: [key] });
        if (v.archivedAt) throw archived('Item');
      }
      const set = {
        ...(input.regularHours !== undefined && { regularHours: input.regularHours }),
        ...(input.expressHours !== undefined && { expressHours: input.expressHours }),
        ...(input.expressVariantId !== undefined && { expressVariantId: input.expressVariantId }),
        ...(input.deliveryVariantId !== undefined && { deliveryVariantId: input.deliveryVariantId }),
        ...(input.storageFeeVariantId !== undefined && { storageFeeVariantId: input.storageFeeVariantId }),
        ...(input.storageFreeDays !== undefined && { storageFreeDays: input.storageFreeDays }),
        ...(input.unclaimedDays !== undefined && { unclaimedDays: input.unclaimedDays }),
        ...(input.finalNoticeDays !== undefined && { finalNoticeDays: input.finalNoticeDays }),
        ...(input.reminderDays !== undefined && { reminderDays: [...input.reminderDays].sort((a, b) => a - b) }),
        ...(input.claimPolicyText !== undefined && { claimPolicyText: input.claimPolicyText }),
        ...(input.smsEnabled !== undefined && { smsEnabled: input.smsEnabled }),
        updatedBy: auth.userId,
        updatedAt: sql`now()`,
      };
      await db
        .insert(laundrySettings)
        .values({ tenantId: tenantOf(auth).tenantId, branchId, ...set })
        .onConflictDoUpdate({ target: [laundrySettings.tenantId, laundrySettings.branchId], set });
      await this.audit(db, auth, 'laundry_settings.updated', 'branch', branchId, { fields: Object.keys(input) });
      return branchLaundrySettings(db, branchId);
    });
  }

  // ---------------------------------------------------------------- garment types

  listGarmentTypes(auth: AuthContext, includeArchived: boolean) {
    return this.read(auth, async (db) => {
      this.assertHolds(auth, 'laundry.read');
      const rows = await db.select().from(laundryGarmentTypes).where(includeArchived ? undefined : isNull(laundryGarmentTypes.archivedAt)).orderBy(asc(laundryGarmentTypes.name));
      return { data: rows };
    });
  }

  createGarmentType(auth: AuthContext, input: CreateGarmentTypeInput) {
    return this.mutate(auth, async (db) => {
      this.assertCan(auth, 'laundry.setup'); // garment types are business-wide: a business-wide grant
      await assertLaundry(db);
      const [row] = await db.insert(laundryGarmentTypes).values({ tenantId: tenantOf(auth).tenantId, name: input.name }).returning();
      await this.audit(db, auth, 'laundry_garment_type.created', 'laundry_garment_type', row!.id, { name: input.name });
      return row!;
    });
  }

  updateGarmentType(auth: AuthContext, id: string, input: UpdateGarmentTypeInput) {
    return this.mutate(auth, async (db) => {
      this.assertCan(auth, 'laundry.setup'); // garment types are business-wide: a business-wide grant
      await assertLaundry(db);
      const [current] = await db.select().from(laundryGarmentTypes).where(eq(laundryGarmentTypes.id, id));
      if (!current) throw notFound('Garment type');
      const [row] = await db
        .update(laundryGarmentTypes)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.archived !== undefined && { archivedAt: input.archived ? (current.archivedAt ?? sql`now()`) : null }),
        })
        .where(eq(laundryGarmentTypes.id, id))
        .returning();
      await this.audit(db, auth, 'laundry_garment_type.updated', 'laundry_garment_type', id, { ...input });
      return row!;
    });
  }

  // ---------------------------------------------------------------- machines

  listMachines(auth: AuthContext, q: MachineListQuery) {
    return this.read(auth, async (db) => {
      if (q.branchId) this.assertCan(auth, 'laundry.read', (await branchScope(db, q.branchId)).scope);
      else this.assertHolds(auth, 'laundry.read');
      const rows = await db
        .select()
        .from(laundryMachines)
        .where(and(q.branchId ? eq(laundryMachines.branchId, q.branchId) : undefined, q.includeArchived ? undefined : isNull(laundryMachines.archivedAt)))
        .orderBy(asc(laundryMachines.kind), asc(laundryMachines.label));
      // Without a branch: only the machines of branches the person may see.
      const visible = [];
      for (const r of rows) if (q.branchId || this.can(auth, 'laundry.read', (await branchScope(db, r.branchId)).scope)) visible.push(machineView(r));
      return { data: visible };
    });
  }

  createMachine(auth: AuthContext, input: CreateMachineInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'laundry.setup', scope);
      await assertLaundry(db);
      if (branch.archivedAt) throw archived('Branch');
      const [row] = await db
        .insert(laundryMachines)
        .values({ tenantId: tenantOf(auth).tenantId, branchId: input.branchId, kind: input.kind, label: input.label, capacityKg: input.capacityKg ?? null, cycleMinutes: input.cycleMinutes })
        .returning();
      await this.audit(db, auth, 'laundry_machine.created', 'laundry_machine', row!.id, { kind: input.kind, label: input.label, branchId: input.branchId });
      return machineView(row!);
    });
  }

  updateMachine(auth: AuthContext, id: string, input: UpdateMachineInput) {
    return this.mutate(auth, async (db) => {
      const current = await this.machine(db, id);
      this.assertCan(auth, 'laundry.setup', (await branchScope(db, current.branchId)).scope);
      await assertLaundry(db);
      const [row] = await db
        .update(laundryMachines)
        .set({
          ...(input.label !== undefined && { label: input.label }),
          ...(input.capacityKg !== undefined && { capacityKg: input.capacityKg }),
          ...(input.cycleMinutes !== undefined && { cycleMinutes: input.cycleMinutes }),
          ...(input.outOfOrderReason !== undefined && { outOfOrderReason: input.outOfOrderReason }),
          ...(input.archived !== undefined && { archivedAt: input.archived ? (current.archivedAt ?? sql`now()`) : null }),
          updatedAt: sql`now()`,
        })
        .where(eq(laundryMachines.id, id))
        .returning();
      await this.audit(db, auth, 'laundry_machine.updated', 'laundry_machine', id, { ...input });
      return machineView(row!);
    });
  }

  /**
   * The machine board (§7): each machine of the branch with what runs on it now (a self-service cycle or
   * a job's load, and the time left), when it is next free, and whether it is out of order.
   */
  board(auth: AuthContext, q: MachineBoardQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      if (!this.can(auth, 'laundry.read', scope)) this.assertCan(auth, 'sales.create', scope);
      const { rows } = await db.execute<{
        id: string; kind: string; label: string; capacity_kg: string | null; cycle_minutes: number; out_of_order_reason: string | null;
        run_id: string | null; source: string | null; job_order_id: string | null; job_number: number | null; sale_id: string | null; sale_number: number | null;
        started_at: string | null; ends_at: string | null; seconds_left: number | null; next_free_at: string; now: string;
      }>(sql`
        SELECT m.id, m.kind, m.label, m.capacity_kg::text, m.cycle_minutes, m.out_of_order_reason,
               r.id AS run_id, r.source, r.job_order_id, j.number AS job_number, r.sale_id, s.sale_number,
               r.started_at, r.ends_at, greatest(0, extract(epoch FROM r.ends_at - now()))::int AS seconds_left,
               greatest(now(), coalesce((SELECT max(coalesce(x.stopped_at, x.ends_at)) FROM machine_runs x WHERE x.machine_id = m.id), now())) AS next_free_at,
               now() AS now
          FROM laundry_machines m
          LEFT JOIN LATERAL (SELECT * FROM machine_runs x WHERE x.machine_id = m.id AND x.started_at <= now() AND coalesce(x.stopped_at, x.ends_at) > now() LIMIT 1) r ON true
          LEFT JOIN job_orders j ON j.id = r.job_order_id
          LEFT JOIN sales s ON s.id = r.sale_id
         WHERE m.branch_id = ${q.branchId} AND m.archived_at IS NULL
         ORDER BY m.kind DESC, lower(m.label)`);
      // Runs waiting behind the current one (a self-service cycle paid for ahead): they can be called off.
      const { rows: waiting } = await db.execute<{ id: string; machine_id: string; source: string; sale_id: string | null; sale_number: number | null; started_at: string; ends_at: string }>(sql`
        SELECT x.id, x.machine_id, x.source, x.sale_id, s.sale_number, x.started_at, x.ends_at
          FROM machine_runs x JOIN laundry_machines m ON m.id = x.machine_id LEFT JOIN sales s ON s.id = x.sale_id
         WHERE m.branch_id = ${q.branchId} AND x.stopped_at IS NULL AND x.started_at > now()
         ORDER BY x.started_at`);
      return {
        branchId: q.branchId,
        asOf: rows[0]?.now ?? null,
        data: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          label: r.label,
          capacityKg: r.capacity_kg === null ? null : toDec(r.capacity_kg).toString(),
          cycleMinutes: r.cycle_minutes,
          outOfOrderReason: r.out_of_order_reason,
          status: r.out_of_order_reason ? 'OUT_OF_ORDER' : r.run_id ? 'RUNNING' : 'FREE',
          current: r.run_id
            ? {
                runId: r.run_id, source: r.source, jobOrderId: r.job_order_id, jobReference: r.job_number === null ? null : jobNumber(r.job_number),
                saleId: r.sale_id, saleNumber: r.sale_number, startedAt: r.started_at, endsAt: r.ends_at, secondsLeft: r.seconds_left,
              }
            : null,
          nextFreeAt: r.next_free_at,
          queued: waiting.filter((w) => w.machine_id === r.id).map((w) => ({ runId: w.id, source: w.source, saleId: w.sale_id, saleNumber: w.sale_number, startsAt: w.started_at, endsAt: w.ends_at })),
        })),
      };
    });
  }

  /** A drop-off load on a machine (§7): starts when the machine is free; moves the job along to WASHING or DRYING. */
  runJobLoad(auth: AuthContext, jobId: string, input: JobMachineRunInput) {
    return this.mutate(auth, async (db) => {
      const job = await loadJob(db, jobId, true);
      this.assertCan(auth, 'laundry.manage', jobScope(job));
      await assertLaundry(db);
      const m = await this.machine(db, input.machineId);
      if (!['RECEIVED', 'WASHING', 'DRYING'].includes(job.status)) {
        throw new AppError('JOB_NOT_IN_PROCESS', 'Only a job being washed or dried goes on a machine', HttpStatus.CONFLICT, { status: job.status });
      }
      if (m.branchId !== job.branchId) throw unprocessable('WRONG_BRANCH', 'This machine is at another branch');
      if (m.archivedAt) throw archived('Machine');
      if (m.outOfOrderReason) throw new AppError('MACHINE_OUT_OF_ORDER', `${m.label} is out of order`, HttpStatus.CONFLICT);
      await lockMachine(db, m.id);
      const minutes = input.minutes ?? m.cycleMinutes;
      const { rows } = await db.execute<{ busy: boolean }>(sql`
        SELECT EXISTS (SELECT 1 FROM machine_runs WHERE machine_id = ${m.id} AND started_at <= now() AND coalesce(stopped_at, ends_at) > now()) AS busy`);
      if (rows[0]!.busy) throw new AppError('MACHINE_BUSY', `${m.label} is in use`, HttpStatus.CONFLICT);
      const [run] = await db
        .insert(machineRuns)
        .values({
          tenantId: job.tenantId, branchId: job.branchId, machineId: m.id, source: 'JOB', jobOrderId: job.id,
          startedAt: sql`now()`, plannedMinutes: minutes, endsAt: sql`now() + make_interval(mins => ${minutes})`, createdBy: auth.userId,
        })
        .returning();
      const step = m.kind === 'WASHER' ? 'WASHING' : 'DRYING';
      const order = ['RECEIVED', 'WASHING', 'DRYING'];
      if (order.indexOf(step) > order.indexOf(job.status)) {
        await db.update(jobOrders).set({ status: step, updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(jobOrders.id, job.id));
        await recordStatus(db, job, job.status, step, auth.userId, m.label);
      }
      await this.audit(db, auth, 'machine_run.started', 'job_order', job.id, { machineRunId: run!.id, machineId: m.id, minutes });
      return { ...run!, machineLabel: m.label };
    });
  }

  /**
   * End a run early (a cycle cut short, a load taken out), or call off one still queued behind another:
   * a queued run is stopped at its own start (an empty run, so it never shows as running and frees its
   * slot; no DDL: `stopped_at` stays within [started_at, ends_at)). A finished run is refused.
   */
  stopRun(auth: AuthContext, runId: string) {
    return this.mutate(auth, async (db) => {
      const [run] = await db.select().from(machineRuns).where(eq(machineRuns.id, runId)).for('update');
      if (!run) throw notFound('Machine run');
      const { scope } = await branchScope(db, run.branchId);
      if (!this.can(auth, 'laundry.manage', scope)) this.assertCan(auth, 'sales.create', scope);
      const { rows } = await db.execute<{ queued: boolean; finished: boolean }>(sql`
        SELECT ${run.startedAt.toISOString()}::timestamptz > now() AS queued, ${run.endsAt.toISOString()}::timestamptz <= now() AS finished`);
      if (run.stoppedAt || rows[0]!.finished) throw new AppError('RUN_NOT_RUNNING', 'This run is not running', HttpStatus.CONFLICT);
      const queued = rows[0]!.queued;
      const [row] = await db
        .update(machineRuns)
        .set({ stoppedAt: queued ? run.startedAt : sql`now()`, stoppedBy: auth.userId })
        .where(eq(machineRuns.id, runId))
        .returning();
      await this.audit(db, auth, queued ? 'machine_run.cancelled' : 'machine_run.stopped', 'laundry_machine', run.machineId, { machineRunId: run.id });
      return row!;
    });
  }

  private async machine(db: Database, id: string): Promise<MachineRow> {
    const [m] = await db.select().from(laundryMachines).where(eq(laundryMachines.id, id));
    if (!m) throw notFound('Machine');
    return m;
  }
}
