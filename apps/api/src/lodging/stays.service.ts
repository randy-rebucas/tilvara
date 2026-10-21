import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import {
  and,
  branches,
  customers,
  desc,
  discountSchemes,
  eq,
  folioEntries,
  folios,
  inArray,
  legalEntities,
  rooms,
  roomTypes,
  sql,
  stayBeneficiaries,
  stayGuests,
  stays,
  type Database,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type {
  CancelStayInput,
  CheckInInput,
  CheckOutInput,
  CreateStayInput,
  InHouseQuery,
  LodgingAvailabilityQuery,
  StayBeneficiaryInput,
  StayGuestInput,
  StayListQuery,
  UpdateStayGuestInput,
  UpdateStayInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import type { ResourceScope } from '../auth/authorization.js';
import { assertLodging } from '../billing/entitlements.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { activeCustomer } from '../customers/customers.service.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { TaxService, unprocessable } from '../tax/tax.service.js';
import { DepositsService } from './deposits.service.js';
import { chargedSoFar, depositsHeld, ensureFolio, folioBalance, folioOfStay, loadStay, lockFolio, type StayRow } from './folio.js';
import { postDueNights } from './night-audit.js';
import { branchLodgingSettings, changeRoomStatus } from './setup.service.js';

const ACTIVE = ['BOOKED', 'IN_HOUSE'] as const;
/** How far back a stay may be entered (a walk-in recorded late, a booking keyed in after arrival). */
const MAX_DAYS_BACK = 31;

const stayEnded = (status: string) => new AppError('STAY_ENDED', `This stay is ${status.toLowerCase().replace('_', ' ')}`, HttpStatus.CONFLICT, { status });

/** The branch's calendar date today (DB clock). */
export async function branchToday(db: Database, branchId: string): Promise<string> {
  const { rows } = await db.execute<{ d: string }>(sql`SELECT (now() AT TIME ZONE b.timezone)::date::text AS d FROM branches b WHERE b.id = ${branchId}`);
  return rows[0]!.d;
}

const addDays = async (db: Database, date: string, days: number) =>
  (await db.execute<{ d: string }>(sql`SELECT (${date}::date + ${days}::int)::text AS d`)).rows[0]!.d;

/**
 * Stays (ADR-0023 §3, §4, §8): bookings of a room over dates, check-in and check-out, the guest
 * registry and SC/PWD guests. `lodging.read` sees; `lodging.manage` books and changes; an agreed rate
 * needs `lodging.rates` or `prices.manage`. A room is never double-booked (exclusion + trigger; 409).
 */
@Injectable()
export class StaysService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    stays_no_double_booking: ['ROOM_DOUBLE_BOOKED', 'This room is already booked for some of these nights'],
    stays_room_blocked: ['ROOM_OUT_OF_ORDER', 'This room is out of order on some of these nights'],
    stays_arrival_fixed: ['ARRIVAL_FIXED', 'A guest in house keeps the arrival date'],
    stays_status_move: ['INVALID_STAY_STATUS', 'The stay cannot move to that status'],
    stays_status_final: ['STAY_ENDED', 'This stay has ended'],
    stay_guests_one_primary: ['PRIMARY_GUEST_EXISTS', 'The stay already has a primary guest'],
    folio_entries_overpaid: ['FOLIO_OVERPAID', 'The folio would owe the guest money'],
    stay_deposits_balance: ['DEPOSIT_EXCEEDED', 'More than the deposit held'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(DepositsService) private readonly deposits: DepositsService,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- reads

  list(auth: AuthContext, q: StayListQuery) {
    return this.read(auth, async (db) => {
      if (q.branchId) this.assertCan(auth, 'lodging.read', (await branchScope(db, q.branchId)).scope);
      else this.assertHolds(auth, 'lodging.read');
      const rows = await db
        .select()
        .from(stays)
        .where(and(
          q.branchId ? eq(stays.branchId, q.branchId) : undefined,
          q.status ? eq(stays.status, q.status) : undefined,
          q.customerId ? eq(stays.customerId, q.customerId) : undefined,
          q.to ? sql`${stays.arrivalDate} < ${q.to}::date` : undefined,
          q.from ? sql`${stays.departureDate} > ${q.from}::date` : undefined,
          q.cursor ? sql`${stays.id} < ${q.cursor}` : undefined,
        ))
        .orderBy(desc(stays.id))
        .limit(q.limit + 1);
      const visible = rows.filter((s) => this.can(auth, 'lodging.read', this.scopeOf(s)));
      const page = visible.slice(0, q.limit);
      return { data: await this.views(db, page), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const stay = await loadStay(db, id);
      this.assertCan(auth, 'lodging.read', this.scopeOf(stay));
      return (await this.views(db, [stay], true))[0]!;
    });
  }

  /**
   * Free rooms per night and room type (§3): active rooms of the branch with no active stay and no
   * block on the night.
   */
  availability(auth: AuthContext, q: LodgingAvailabilityQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertCan(auth, 'lodging.read', scope);
      const { rows } = await db.execute<{ night: string; room_id: string; number: string; room_type_id: string; free: boolean; status: string; occupied: boolean }>(sql`
        SELECT d.night::date::text AS night, r.id AS room_id, r.number, r.room_type_id, r.housekeeping_status AS status,
               EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'IN_HOUSE') AS occupied,
               NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status IN ('BOOKED', 'IN_HOUSE')
                              AND s.arrival_date <= d.night::date AND s.departure_date > d.night::date)
           AND NOT EXISTS (SELECT 1 FROM room_blocks b WHERE b.room_id = r.id AND b.starts_on <= d.night::date AND b.ends_on > d.night::date) AS free
          FROM rooms r CROSS JOIN generate_series(${q.from}::date::timestamp, (${q.to}::date - 1)::timestamp, interval '1 day') AS d(night)
         WHERE r.branch_id = ${q.branchId} AND r.archived_at IS NULL ${q.roomTypeId ? sql`AND r.room_type_id = ${q.roomTypeId}` : sql``}
         ORDER BY 1, r.number`);
      const types = await db.select({ id: roomTypes.id, code: roomTypes.code, name: roomTypes.name }).from(roomTypes);
      const nights = [...new Set(rows.map((r) => r.night))];
      const roomIds = [...new Set(rows.map((r) => r.room_id))];
      return {
        branchId: q.branchId,
        from: q.from,
        to: q.to,
        nights: nights.map((night) => {
          const of = rows.filter((r) => r.night === night);
          const typeIds = [...new Set(of.map((r) => r.room_type_id))];
          return {
            date: night,
            roomTypes: typeIds.map((t) => ({
              roomTypeId: t, code: types.find((x) => x.id === t)?.code ?? null, name: types.find((x) => x.id === t)?.name ?? null,
              total: of.filter((r) => r.room_type_id === t).length, available: of.filter((r) => r.room_type_id === t && r.free).length,
              freeRoomIds: of.filter((r) => r.room_type_id === t && r.free).map((r) => r.room_id),
            })),
          };
        }),
        rooms: roomIds.map((id) => {
          const of = rows.filter((r) => r.room_id === id);
          return { roomId: id, number: of[0]!.number, roomTypeId: of[0]!.room_type_id, housekeepingStatus: of[0]!.status, occupied: of[0]!.occupied, availableAllNights: of.every((r) => r.free), freeNights: of.filter((r) => r.free).map((r) => r.night) };
        }),
      };
    });
  }

  /**
   * In-house guests a till may charge to (§5.1): stays of the branch's legal entity, by room number or
   * name. `sales.create` at the branch is enough (the cashier checks the name with the guest).
   */
  inHouse(auth: AuthContext, q: InHouseQuery) {
    return this.read(auth, async (db) => {
      const { branch, scope } = await branchScope(db, q.branchId);
      if (!this.can(auth, 'sales.create', scope)) this.assertCan(auth, 'lodging.read', scope);
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const { rows } = await db.execute<{
        id: string; branch_id: string; branch_name: string; number: string; departure_date: string; allow_charges: boolean; charge_limit: string | null;
        name: string | null; folio_id: string | null; charged: string;
      }>(sql`
        SELECT s.id, s.branch_id, b.name AS branch_name, r.number, s.departure_date::text, s.allow_charges, s.charge_limit::text,
               coalesce((SELECT g.full_name FROM stay_guests g WHERE g.stay_id = s.id AND g.is_primary), s.guest_name, c.display_name) AS name,
               f.id AS folio_id,
               coalesce((SELECT sum(e.amount) FROM folio_entries e WHERE e.folio_id = f.id AND e.kind IN ('CHARGE', 'CHARGE_RETURN')), 0)::text AS charged
          FROM stays s JOIN rooms r ON r.id = s.room_id JOIN branches b ON b.id = s.branch_id
          LEFT JOIN customers c ON c.id = s.customer_id
          LEFT JOIN folios f ON f.stay_id = s.id AND f.status = 'OPEN'
         WHERE s.status = 'IN_HOUSE' AND s.legal_entity_id = ${branch.legalEntityId}
           ${like ? sql`AND (r.number ILIKE ${like} OR coalesce((SELECT g.full_name FROM stay_guests g WHERE g.stay_id = s.id AND g.is_primary), s.guest_name, c.display_name) ILIKE ${like})` : sql``}
         ORDER BY (s.branch_id = ${branch.id}) DESC, r.number
         LIMIT 50`);
      return {
        data: rows.map((r) => ({
          stayId: r.id, branchId: r.branch_id, branchName: r.branch_name, roomNumber: r.number, guestName: r.name, departureDate: r.departure_date,
          allowCharges: r.allow_charges && r.folio_id !== null, chargeLimit: r.charge_limit === null ? null : toDec(r.charge_limit).toFixed(2), charged: toDec(r.charged).toFixed(2),
          available: r.charge_limit === null ? null : toDec(r.charge_limit).minus(r.charged).toFixed(2),
        })),
      };
    });
  }

  // ---------------------------------------------------------------- booking

  create(auth: AuthContext, input: CreateStayInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'lodging.manage', scope);
      await assertLodging(db);
      if (branch.archivedAt) throw archived('Branch');
      const room = await this.roomAt(db, input.roomId, branch.id);
      const type = await this.typeOf(db, room.roomTypeId);
      if (input.adults + input.children > type.maxOccupancy) {
        throw unprocessable('OVER_OCCUPANCY', `A ${type.name} room takes at most ${type.maxOccupancy} guests`, { maxOccupancy: type.maxOccupancy });
      }
      if (input.nightlyRate !== undefined) this.assertRates(auth, scope);
      const today = await branchToday(db, branch.id);
      if (input.arrivalDate < (await addDays(db, today, -MAX_DAYS_BACK))) throw unprocessable('ARRIVAL_IN_PAST', `A stay may start at most ${MAX_DAYS_BACK} days ago`);
      const customer = input.customerId ? await activeCustomer(db, input.customerId) : null;
      const [row] = await db
        .insert(stays)
        .values({
          tenantId: tenantOf(auth).tenantId,
          legalEntityId: branch.legalEntityId,
          branchId: branch.id,
          roomId: room.id,
          roomTypeId: room.roomTypeId,
          customerId: customer?.id ?? null,
          guestName: customer ? null : (input.guestName ?? input.guests.find((g) => g.isPrimary)?.fullName ?? input.guests[0]?.fullName ?? null),
          arrivalDate: input.arrivalDate,
          departureDate: input.departureDate,
          adults: input.adults,
          children: input.children,
          nightlyRate: input.nightlyRate ?? null,
          allowCharges: input.allowCharges,
          chargeLimit: input.chargeLimit ?? null,
          source: input.source,
          externalReference: input.externalReference ?? null,
          notes: input.notes ?? null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await this.addGuests(db, auth, row!, input.guests);
      await this.audit(db, auth, 'stay.booked', 'stay', row!.id, {
        branchId: branch.id, roomId: room.id, arrivalDate: input.arrivalDate, departureDate: input.departureDate, source: input.source,
        ...(input.nightlyRate !== undefined && { nightlyRate: input.nightlyRate }),
      });
      if (input.checkIn) await this.doCheckIn(db, auth, row!.id, { overrideHousekeeping: input.overrideHousekeeping, applyDeposits: false, guests: [] });
      return (await this.views(db, [await loadStay(db, row!.id)], true))[0]!;
    });
  }

  /** Move, extend, shorten, change the rate or the guest (§3); re-checked by the no-double-booking rule. */
  update(auth: AuthContext, id: string, input: UpdateStayInput) {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, id, true);
      const scope = this.scopeOf(stay);
      this.assertCan(auth, 'lodging.manage', scope);
      await assertLodging(db);
      if (!(ACTIVE as readonly string[]).includes(stay.status)) throw stayEnded(stay.status);
      if (input.nightlyRate !== undefined) this.assertRates(auth, scope);
      // A new rate for a guest in house applies from the next night due (ADR-0023 §7 amendment): the
      // nights already due are charged first, at the rate in force when they were due.
      const rateChanges = input.nightlyRate !== undefined && (input.nightlyRate === null ? stay.nightlyRate !== null : stay.nightlyRate === null || !toDec(stay.nightlyRate).equals(input.nightlyRate));
      const caughtUp = rateChanges && stay.status === 'IN_HOUSE'
        ? await postDueNights(db, this.tax, stay.id, { tenantId: stay.tenantId, userId: auth.userId, correlationId: auth.correlationId ?? null, through: 'DUE', production: this.env.NODE_ENV === 'production' })
        : [];
      const room = input.roomId && input.roomId !== stay.roomId ? await this.roomAt(db, input.roomId, stay.branchId) : null;
      // A guest in house moves now: the new room must be ready and empty, the old one is left to clean.
      let vacated: typeof rooms.$inferSelect | null = null;
      if (room && stay.status === 'IN_HOUSE') {
        const locked = await this.lockRooms(db, [stay.roomId, room.id]);
        const target = locked.get(room.id)!;
        if (target.housekeepingStatus !== 'CLEAN' && target.housekeepingStatus !== 'INSPECTED') {
          throw new AppError('ROOM_NOT_READY', `The room is ${target.housekeepingStatus.toLowerCase().replace(/_/g, ' ')}`, HttpStatus.CONFLICT, { housekeepingStatus: target.housekeepingStatus });
        }
        await this.assertRoomFree(db, room.id, stay.id);
        vacated = locked.get(stay.roomId) ?? null;
      }
      const type = await this.typeOf(db, room?.roomTypeId ?? stay.roomTypeId);
      const adults = input.adults ?? stay.adults;
      const children = input.children ?? stay.children;
      if (adults + children > type.maxOccupancy) throw unprocessable('OVER_OCCUPANCY', `A ${type.name} room takes at most ${type.maxOccupancy} guests`, { maxOccupancy: type.maxOccupancy });
      const arrival = input.arrivalDate ?? stay.arrivalDate;
      const departure = input.departureDate ?? stay.departureDate;
      if (departure <= arrival) throw unprocessable('VALIDATION_FAILED', 'Departure is after arrival', { path: ['departureDate'] });
      // Nights already charged stay inside the stay: reverse them first (§5).
      const { rows: [last] } = await db.execute<{ d: string | null }>(sql`
        SELECT max(e.night_date)::text AS d FROM folio_entries e WHERE e.stay_id = ${id} AND e.kind = 'ROOM_NIGHT'
           AND NOT EXISTS (SELECT 1 FROM folio_entries r WHERE r.related_entry_id = e.id AND r.kind = 'NIGHT_REVERSAL')`);
      if (last?.d && departure <= last.d) {
        throw new AppError('NIGHTS_POSTED', 'Nights up to the new departure were already charged; reverse them on the folio first', HttpStatus.CONFLICT, { lastNight: last.d });
      }
      const customer = input.customerId ? await activeCustomer(db, input.customerId) : null;
      const [updated] = await db
        .update(stays)
        .set({
          ...(room && { roomId: room.id, roomTypeId: room.roomTypeId }),
          ...(input.customerId !== undefined && { customerId: customer?.id ?? null, ...(customer && { guestName: null }) }),
          ...(input.guestName !== undefined && { guestName: input.guestName }),
          arrivalDate: arrival,
          departureDate: departure,
          adults,
          children,
          ...(input.nightlyRate !== undefined && { nightlyRate: input.nightlyRate }),
          ...(input.allowCharges !== undefined && { allowCharges: input.allowCharges }),
          ...(input.chargeLimit !== undefined && { chargeLimit: input.chargeLimit }),
          ...(input.source !== undefined && { source: input.source }),
          ...(input.externalReference !== undefined && { externalReference: input.externalReference }),
          ...(input.notes !== undefined && { notes: input.notes }),
          updatedBy: auth.userId,
          updatedAt: sql`now()`,
        })
        .where(eq(stays.id, id))
        .returning();
      if (!updated!.customerId && !updated!.guestName) throw unprocessable('VALIDATION_FAILED', 'Name the guest or the customer', { path: ['guestName'] });
      if (vacated) await changeRoomStatus(db, { tenantId: stay.tenantId, room: vacated, to: 'DIRTY', note: null, userId: auth.userId, stayId: stay.id });
      // Field names only (the guest's name is personal data); dates, room and rate are operational.
      await this.audit(db, auth, 'stay.changed', 'stay', id, {
        fields: Object.keys(input),
        ...(room && { fromRoomId: stay.roomId, toRoomId: room.id }),
        ...(input.arrivalDate !== undefined && { arrivalDate: arrival }),
        ...(input.departureDate !== undefined && { departureDate: departure, previousDepartureDate: stay.departureDate }),
        ...(input.nightlyRate !== undefined && { nightlyRate: input.nightlyRate, previousNightlyRate: stay.nightlyRate }),
        ...(caughtUp.length > 0 && { nightsPostedAtPreviousRate: caughtUp }),
      });
      return (await this.views(db, [updated!], true))[0]!;
    });
  }

  /** Cancel a booking (§3, §6): deposits held are forfeited or refunded. */
  cancel(auth: AuthContext, id: string, input: CancelStayInput) {
    return this.end(auth, id, input, 'CANCELLED');
  }

  /** A booking whose arrival day has passed with nobody arriving (§4). */
  noShow(auth: AuthContext, id: string, input: CancelStayInput) {
    return this.end(auth, id, input, 'NO_SHOW');
  }

  private end(auth: AuthContext, id: string, input: CancelStayInput, status: 'CANCELLED' | 'NO_SHOW') {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, id, true);
      const scope = this.scopeOf(stay);
      this.assertCan(auth, 'lodging.manage', scope);
      await assertLodging(db);
      if (stay.status !== 'BOOKED') {
        throw new AppError('STAY_NOT_BOOKED', stay.status === 'IN_HOUSE' ? 'The guest is in house; check them out instead' : `This stay is ${stay.status.toLowerCase().replace('_', ' ')}`, HttpStatus.CONFLICT, { status: stay.status });
      }
      if (status === 'NO_SHOW' && stay.arrivalDate >= (await branchToday(db, stay.branchId))) {
        throw new AppError('ARRIVAL_NOT_PASSED', 'A no-show is marked once the arrival day has passed', HttpStatus.CONFLICT, { arrivalDate: stay.arrivalDate });
      }
      const held = await depositsHeld(db, stay.id);
      let deposits: 'FORFEIT' | 'REFUND' | null = null;
      if (held.gt(0)) {
        const settings = await branchLodgingSettings(db, stay.branchId);
        const fallback = settings.forfeitOnCancel ? 'FORFEIT' : 'REFUND';
        deposits = input.deposits ?? fallback;
        if (deposits === 'REFUND' && fallback === 'FORFEIT') this.assertRates(auth, scope);
        if (deposits === 'REFUND') {
          if (!input.refund) throw unprocessable('REFUND_METHOD_REQUIRED', 'Say how the deposit is refunded (cash from a drawer or a bank transfer)', { path: ['refund'] });
          await this.deposits.refundHeld(db, auth, stay, { refund: input.refund, reason: input.reason, amount: held });
        } else {
          await this.deposits.forfeitHeld(db, auth, stay, { reason: input.reason, amount: held });
        }
      }
      await db.update(stays).set({ status, cancelReason: input.reason, cancelledAt: sql`now()`, cancelledBy: auth.userId, updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(stays.id, id));
      // A folio opened only for deposits closes with them.
      const folio = await folioOfStay(db, stay.id);
      if (folio?.status === 'OPEN') await lockFolio(db, folio.id);
      if (folio?.status === 'OPEN') await db.update(folios).set({ status: 'SETTLED', settledAt: sql`now()`, settledBy: auth.userId }).where(eq(folios.id, folio.id));
      await this.audit(db, auth, status === 'CANCELLED' ? 'stay.cancelled' : 'stay.no_show', 'stay', id, { reason: input.reason, ...(deposits && { deposits, amount: held.toFixed(2) }) });
      return (await this.views(db, [await loadStay(db, id)], true))[0]!;
    });
  }

  // ---------------------------------------------------------------- check-in, check-out (§4)

  checkIn(auth: AuthContext, id: string, input: CheckInInput) {
    return this.mutate(auth, async (db) => {
      await this.doCheckIn(db, auth, id, input);
      return (await this.views(db, [await loadStay(db, id)], true))[0]!;
    });
  }

  private async doCheckIn(db: Database, auth: AuthContext, id: string, input: CheckInInput) {
    const stay = await loadStay(db, id, true);
    const scope = this.scopeOf(stay);
    this.assertCan(auth, 'lodging.manage', scope);
    await assertLodging(db);
    if (stay.status !== 'BOOKED') throw new AppError('STAY_NOT_BOOKED', `This stay is ${stay.status.toLowerCase().replace('_', ' ')}`, HttpStatus.CONFLICT, { status: stay.status });
    // Arrival today or earlier; the day before is an early check-in.
    const today = await branchToday(db, stay.branchId);
    const tomorrow = await addDays(db, today, 1);
    if (stay.arrivalDate > tomorrow) throw new AppError('TOO_EARLY', 'Check in on the arrival day (or the day before)', HttpStatus.CONFLICT, { arrivalDate: stay.arrivalDate });
    const early = stay.arrivalDate > today;
    const [room] = await db.select().from(rooms).where(eq(rooms.id, stay.roomId)).for('update');
    if (!(room!.housekeepingStatus === 'CLEAN' || room!.housekeepingStatus === 'INSPECTED') && !input.overrideHousekeeping) {
      throw new AppError('ROOM_NOT_READY', `The room is ${room!.housekeepingStatus.toLowerCase().replace(/_/g, ' ')}`, HttpStatus.CONFLICT, { housekeepingStatus: room!.housekeepingStatus });
    }
    // A guest not yet checked out (past their departure, so no longer caught by the booking rule) still holds the room.
    await this.assertRoomFree(db, stay.roomId, stay.id);
    await this.addGuests(db, auth, stay, input.guests);
    const [primary] = await db.select({ id: stayGuests.id }).from(stayGuests).where(and(eq(stayGuests.stayId, stay.id), eq(stayGuests.isPrimary, true)));
    if (!primary) throw new AppError('GUEST_REGISTRY_REQUIRED', 'Record the primary guest in the registry first', HttpStatus.CONFLICT);
    const folio = await ensureFolio(db, stay, auth.userId);
    // An early check-in starts the stay tonight, in the same update (an in-house stay keeps its arrival):
    // the booking rule re-checks tonight, and the night audit charges it.
    await db
      .update(stays)
      .set({ status: 'IN_HOUSE', ...(early && { arrivalDate: today }), checkedInAt: sql`now()`, checkedInBy: auth.userId, updatedBy: auth.userId, updatedAt: sql`now()` })
      .where(eq(stays.id, stay.id));
    if (input.applyDeposits) await this.deposits.applyHeld(db, auth, { ...stay, status: 'IN_HOUSE', ...(early && { arrivalDate: today }) }, folio, null);
    await this.audit(db, auth, 'stay.checked_in', 'stay', stay.id, {
      roomId: stay.roomId, folioId: folio.id,
      ...(early && { earlyCheckIn: true, arrivalDate: today, previousArrivalDate: stay.arrivalDate }),
      ...(input.overrideHousekeeping && room!.housekeepingStatus !== 'CLEAN' && room!.housekeepingStatus !== 'INSPECTED' && { overrideHousekeeping: room!.housekeepingStatus }),
    });
    await emitEvent(db, { tenantId: stay.tenantId, topic: 'stay.checked_in', payload: { stayId: stay.id, folioId: folio.id, branchId: stay.branchId, roomId: stay.roomId }, correlationId: auth.correlationId });
  }

  /**
   * Get the folio ready to settle: every night up to the departure date (shortened to today first when
   * the guest leaves early), then the deposits held as far as they pay the balance. The front desk takes
   * payment for what is left, then checks out. Check-out does the same, so calling this is optional.
   */
  prepareCheckOut(auth: AuthContext, id: string, input: CheckOutInput) {
    return this.mutate(auth, async (db) => {
      const { folio } = await this.prepare(db, auth, id, input);
      return { stayId: id, folioId: folio.id, balance: (await folioBalance(db, folio.id)).toFixed(2), depositsHeld: (await depositsHeld(db, id)).toFixed(2) };
    });
  }

  checkOut(auth: AuthContext, id: string, input: CheckOutInput) {
    return this.mutate(auth, async (db) => {
      const { stay, folio } = await this.prepare(db, auth, id, input);
      const balance = await folioBalance(db, folio.id);
      if (!balance.isZero()) {
        throw new AppError('FOLIO_BALANCE_DUE', 'Settle the folio before checking out', HttpStatus.CONFLICT, { folioId: folio.id, balance: balance.toFixed(2) });
      }
      const held = await depositsHeld(db, id);
      if (held.gt(0)) {
        throw new AppError('DEPOSIT_HELD', 'A deposit is left over after paying the folio; refund it first', HttpStatus.CONFLICT, { depositsHeld: held.toFixed(2) });
      }
      await db.update(folios).set({ status: 'SETTLED', settledAt: sql`now()`, settledBy: auth.userId }).where(eq(folios.id, folio.id));
      await db.update(stays).set({ status: 'CHECKED_OUT', checkedOutAt: sql`now()`, checkedOutBy: auth.userId, updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(stays.id, id));
      const [room] = await db.select().from(rooms).where(eq(rooms.id, stay.roomId)).for('update');
      await changeRoomStatus(db, { tenantId: stay.tenantId, room: room!, to: 'DIRTY', note: null, userId: auth.userId, stayId: stay.id });
      await this.audit(db, auth, 'stay.checked_out', 'stay', id, { folioId: folio.id, departureDate: stay.departureDate });
      await emitEvent(db, { tenantId: stay.tenantId, topic: 'stay.checked_out', payload: { stayId: id, folioId: folio.id, branchId: stay.branchId, roomId: stay.roomId }, correlationId: auth.correlationId });
      return (await this.views(db, [await loadStay(db, id)], true))[0]!;
    });
  }

  private async prepare(db: Database, auth: AuthContext, id: string, input: CheckOutInput) {
    let stay = await loadStay(db, id, true);
    this.assertCan(auth, 'lodging.manage', this.scopeOf(stay));
    await assertLodging(db);
    if (stay.status !== 'IN_HOUSE') throw new AppError('STAY_NOT_IN_HOUSE', `This stay is ${stay.status.toLowerCase().replace('_', ' ')}`, HttpStatus.CONFLICT, { status: stay.status });
    const folio = await folioOfStay(db, stay.id);
    if (!folio) throw notFound('Folio');
    const today = await branchToday(db, stay.branchId);
    if (stay.departureDate < today) stay = await this.extendOverstay(db, auth, stay, today);
    if (input.departEarly) {
      const nextDay = await addDays(db, stay.arrivalDate, 1);
      const departure = today > nextDay ? today : nextDay;
      if (departure < stay.departureDate) {
        await db.update(stays).set({ departureDate: departure, updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(stays.id, id));
        await this.audit(db, auth, 'stay.changed', 'stay', id, { fields: ['departureDate'], departureDate: departure, previousDepartureDate: stay.departureDate, departEarly: true });
        stay = await loadStay(db, id, true);
      }
    }
    await postDueNights(db, this.tax, stay.id, { tenantId: stay.tenantId, userId: auth.userId, correlationId: auth.correlationId ?? null, through: 'DEPARTURE', production: this.env.NODE_ENV === 'production' });
    await this.deposits.applyHeld(db, auth, stay, folio, null);
    return { stay, folio };
  }

  /**
   * An overstay (§4): a guest still in house after their departure date leaves today. The departure
   * moves to today in the same update a change of dates makes, so the no-double-booking exclusion and
   * the room-block trigger check the extra nights; check-out then charges them. A booking of the room
   * that starts in those nights is named, so the front desk moves one of the two first.
   */
  private async extendOverstay(db: Database, auth: AuthContext, stay: StayRow, today: string): Promise<StayRow> {
    const [next] = await db
      .select({ id: stays.id, arrivalDate: stays.arrivalDate })
      .from(stays)
      .where(and(
        eq(stays.roomId, stay.roomId), sql`${stays.id} <> ${stay.id}`, inArray(stays.status, [...ACTIVE]),
        sql`${stays.arrivalDate} < ${today}::date`, sql`${stays.departureDate} > ${stay.departureDate}::date`,
      ))
      .orderBy(stays.arrivalDate)
      .limit(1);
    if (next) {
      throw new AppError('ROOM_DOUBLE_BOOKED', `The guest stayed past their departure into another booking of this room (from ${next.arrivalDate}); move that booking or this guest to another room, then check out`, HttpStatus.CONFLICT, {
        overstay: true, departureDate: stay.departureDate, extendTo: today, conflictingStayId: next.id, conflictingArrivalDate: next.arrivalDate,
      });
    }
    await db.update(stays).set({ departureDate: today, updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(stays.id, stay.id));
    await this.audit(db, auth, 'stay.changed', 'stay', stay.id, { fields: ['departureDate'], departureDate: today, previousDepartureDate: stay.departureDate, overstay: true });
    return loadStay(db, stay.id, true);
  }

  // ---------------------------------------------------------------- guest registry (§8)

  guests(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const stay = await loadStay(db, id);
      this.assertCan(auth, 'lodging.manage', this.scopeOf(stay));
      return { data: await db.select().from(stayGuests).where(eq(stayGuests.stayId, id)).orderBy(desc(stayGuests.isPrimary), stayGuests.createdAt) };
    });
  }

  addGuest(auth: AuthContext, id: string, input: StayGuestInput) {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, id, true);
      this.assertCan(auth, 'lodging.manage', this.scopeOf(stay));
      await assertLodging(db);
      if (!(ACTIVE as readonly string[]).includes(stay.status)) throw stayEnded(stay.status);
      const [row] = await this.addGuests(db, auth, stay, [input]);
      return row!;
    });
  }

  updateGuest(auth: AuthContext, id: string, guestId: string, input: UpdateStayGuestInput) {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, id, true);
      this.assertCan(auth, 'lodging.manage', this.scopeOf(stay));
      await assertLodging(db);
      if (!(ACTIVE as readonly string[]).includes(stay.status)) throw stayEnded(stay.status);
      const [guest] = await db.select().from(stayGuests).where(and(eq(stayGuests.id, guestId), eq(stayGuests.stayId, id)));
      if (!guest) throw notFound('Guest');
      if (input.isPrimary === false && guest.isPrimary && stay.status === 'IN_HOUSE') {
        throw new AppError('PRIMARY_GUEST_REQUIRED', 'A guest in house keeps a primary guest; make another one primary instead', HttpStatus.CONFLICT);
      }
      if (input.isPrimary === true && !guest.isPrimary) {
        await db.update(stayGuests).set({ isPrimary: false, updatedAt: sql`now()` }).where(and(eq(stayGuests.stayId, id), eq(stayGuests.isPrimary, true)));
      }
      const [row] = await db.update(stayGuests).set({ ...input, updatedAt: sql`now()` }).where(eq(stayGuests.id, guestId)).returning();
      await this.audit(db, auth, 'stay.guest_changed', 'stay', id, { guestId, fields: Object.keys(input) });
      return row!;
    });
  }

  removeGuest(auth: AuthContext, id: string, guestId: string) {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, id, true);
      this.assertCan(auth, 'lodging.manage', this.scopeOf(stay));
      await assertLodging(db);
      if (!(ACTIVE as readonly string[]).includes(stay.status)) throw stayEnded(stay.status);
      const [guest] = await db.select().from(stayGuests).where(and(eq(stayGuests.id, guestId), eq(stayGuests.stayId, id)));
      if (!guest) throw notFound('Guest');
      if (guest.isPrimary && stay.status === 'IN_HOUSE') throw new AppError('PRIMARY_GUEST_REQUIRED', 'A guest in house keeps a primary guest; make another one primary first', HttpStatus.CONFLICT);
      await db.delete(stayGuests).where(eq(stayGuests.id, guestId));
      await this.audit(db, auth, 'stay.guest_removed', 'stay', id, { guestId });
      return { removed: true, id: guestId };
    });
  }

  /** The registration card (§8), printable: the stay, its room and rate, and its registry. */
  registrationCard(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const stay = await loadStay(db, id);
      this.assertCan(auth, 'lodging.manage', this.scopeOf(stay));
      const [[entity], [branch], [room], [type], guests] = [
        await db.select().from(legalEntities).where(eq(legalEntities.id, stay.legalEntityId)),
        await db.select().from(branches).where(eq(branches.id, stay.branchId)),
        await db.select().from(rooms).where(eq(rooms.id, stay.roomId)),
        await db.select().from(roomTypes).where(eq(roomTypes.id, stay.roomTypeId)),
        await db.select().from(stayGuests).where(eq(stayGuests.stayId, id)).orderBy(desc(stayGuests.isPrimary), stayGuests.createdAt),
      ];
      return {
        title: 'Guest registration card',
        business: { registeredName: entity!.registeredName, tradeName: entity!.tradeName, tin: entity!.tin, registeredAddress: entity!.registeredAddress },
        branch: { name: branch!.name, address: branch!.address },
        stay: {
          id: stay.id, roomNumber: room!.number, roomType: type!.name, arrivalDate: stay.arrivalDate, departureDate: stay.departureDate,
          adults: stay.adults, children: stay.children, nightlyRate: stay.nightlyRate === null ? null : toDec(stay.nightlyRate).toFixed(2), source: stay.source,
          externalReference: stay.externalReference, checkedInAt: stay.checkedInAt,
        },
        guests,
        declaration: 'I confirm that the details above are correct.',
        signatureLine: 'Guest signature',
      };
    });
  }

  // ---------------------------------------------------------------- SC/PWD guests (§7)

  addBeneficiary(auth: AuthContext, id: string, input: StayBeneficiaryInput) {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, id, true);
      this.assertCan(auth, 'lodging.manage', this.scopeOf(stay));
      await assertLodging(db);
      if (!(ACTIVE as readonly string[]).includes(stay.status)) throw stayEnded(stay.status);
      const [scheme] = await db.select({ code: discountSchemes.code }).from(discountSchemes).where(eq(discountSchemes.code, input.scheme)).limit(1);
      if (!scheme) throw unprocessable('UNKNOWN_SCHEME', `No discount scheme ${input.scheme}`);
      const [row] = await db
        .insert(stayBeneficiaries)
        .values({ tenantId: stay.tenantId, stayId: id, schemeCode: input.scheme, name: input.name, idNumber: input.idNumber, share: input.share ?? null, createdBy: auth.userId })
        .returning();
      await this.audit(db, auth, 'stay.beneficiary_added', 'stay', id, { beneficiaryId: row!.id, scheme: input.scheme });
      return row!;
    });
  }

  /** Removed from later nights; deleted outright when no night used it yet. */
  removeBeneficiary(auth: AuthContext, id: string, beneficiaryId: string) {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, id, true);
      this.assertCan(auth, 'lodging.manage', this.scopeOf(stay));
      await assertLodging(db);
      const [row] = await db.select().from(stayBeneficiaries).where(and(eq(stayBeneficiaries.id, beneficiaryId), eq(stayBeneficiaries.stayId, id)));
      if (!row) throw notFound('Beneficiary');
      const { rows: [used] } = await db.execute<{ used: boolean }>(sql`
        SELECT EXISTS (SELECT 1 FROM folio_entries e WHERE e.stay_id = ${id} AND e.kind = 'ROOM_NIGHT'
                        AND e.tax_snapshot->'beneficiaries' @> ${JSON.stringify([{ id: beneficiaryId }])}::jsonb) AS used`);
      if (used!.used) await db.update(stayBeneficiaries).set({ removedAt: sql`now()` }).where(eq(stayBeneficiaries.id, beneficiaryId));
      else await db.delete(stayBeneficiaries).where(eq(stayBeneficiaries.id, beneficiaryId));
      await this.audit(db, auth, 'stay.beneficiary_removed', 'stay', id, { beneficiaryId });
      return { removed: true, id: beneficiaryId };
    });
  }

  // ---------------------------------------------------------------- helpers

  private scopeOf(s: Pick<StayRow, 'branchId' | 'legalEntityId'>): ResourceScope {
    return { branchId: s.branchId, legalEntityId: s.legalEntityId };
  }

  /** An agreed rate other than the rack rate (§3). */
  private assertRates(auth: AuthContext, scope: ResourceScope) {
    if (!this.can(auth, 'prices.manage', scope)) this.assertCan(auth, 'lodging.rates', scope);
  }

  private async roomAt(db: Database, roomId: string, branchId: string) {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    if (!room) throw notFound('Room');
    if (room.branchId !== branchId) throw unprocessable('WRONG_BRANCH', 'The room is at another branch');
    if (room.archivedAt) throw archived('Room');
    return room;
  }

  /** Lock rooms in id order (two moves the other way round never wait on each other). */
  private async lockRooms(db: Database, ids: string[]) {
    const out = new Map<string, typeof rooms.$inferSelect>();
    for (const id of [...new Set(ids)].sort()) {
      const [row] = await db.select().from(rooms).where(eq(rooms.id, id)).for('update');
      if (row) out.set(id, row);
    }
    return out;
  }

  /** No other guest in house in the room (the caller holds the room's row lock). */
  private async assertRoomFree(db: Database, roomId: string, stayId: string) {
    const [occupied] = await db
      .select({ id: stays.id })
      .from(stays)
      .where(and(eq(stays.roomId, roomId), eq(stays.status, 'IN_HOUSE'), sql`${stays.id} <> ${stayId}`))
      .limit(1);
    if (occupied) throw new AppError('ROOM_OCCUPIED', 'Another guest is still in this room; check them out or move them first', HttpStatus.CONFLICT, { stayId: occupied.id });
  }

  private async typeOf(db: Database, id: string) {
    const [row] = await db.select().from(roomTypes).where(eq(roomTypes.id, id));
    return row!;
  }

  private async addGuests(db: Database, auth: AuthContext, stay: StayRow, guests: StayGuestInput[]) {
    if (!guests.length) return [];
    const { rows: [has] } = await db.execute<{ primary: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM stay_guests WHERE stay_id = ${stay.id} AND is_primary) AS primary`);
    // The first guest recorded is the primary one unless someone else is named.
    const named = guests.some((g) => g.isPrimary);
    if (named && has!.primary) await db.update(stayGuests).set({ isPrimary: false, updatedAt: sql`now()` }).where(and(eq(stayGuests.stayId, stay.id), eq(stayGuests.isPrimary, true)));
    const rows = await db
      .insert(stayGuests)
      .values(guests.map((g, i) => ({
        tenantId: stay.tenantId, stayId: stay.id, isPrimary: named ? g.isPrimary : !has!.primary && i === 0, fullName: g.fullName,
        nationality: g.nationality ?? null, idType: g.idType ?? null, idNumber: g.idNumber ?? null, address: g.address ?? null,
        birthDate: g.birthDate ?? null, contact: g.contact ?? null, createdBy: auth.userId,
      })))
      .returning();
    await this.audit(db, auth, 'stay.guests_added', 'stay', stay.id, { guestIds: rows.map((r) => r.id) });
    return rows;
  }

  private async views(db: Database, rows: StayRow[], detailed = false) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [roomRows, typeRows, folioRows, guestRows, customerRows] = [
      await db.select({ id: rooms.id, number: rooms.number, floor: rooms.floor }).from(rooms).where(inArray(rooms.id, [...new Set(rows.map((r) => r.roomId))])),
      await db.select({ id: roomTypes.id, code: roomTypes.code, name: roomTypes.name }).from(roomTypes).where(inArray(roomTypes.id, [...new Set(rows.map((r) => r.roomTypeId))])),
      await db.select().from(folios).where(inArray(folios.stayId, ids)),
      await db.select({ id: stayGuests.id, stayId: stayGuests.stayId, fullName: stayGuests.fullName, isPrimary: stayGuests.isPrimary }).from(stayGuests).where(inArray(stayGuests.stayId, ids)),
      await db.select({ id: customers.id, displayName: customers.displayName }).from(customers).where(inArray(customers.id, rows.flatMap((r) => (r.customerId ? [r.customerId] : [])).concat(['00000000-0000-0000-0000-000000000000']))),
    ];
    // An overstay: in house after the departure date, in the branch's calendar.
    const { rows: todays } = await db.execute<{ id: string; d: string }>(sql`
      SELECT b.id, (now() AT TIME ZONE b.timezone)::date::text AS d FROM branches b WHERE b.id IN (${sql.join([...new Set(rows.map((r) => r.branchId))].map((b) => sql`${b}::uuid`), sql`, `)})`);
    const out = [];
    for (const s of rows) {
      const folio = folioRows.find((f) => f.stayId === s.id) ?? null;
      const branchDay = todays.find((t) => t.id === s.branchId)?.d ?? null;
      const guests = guestRows.filter((g) => g.stayId === s.id).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      const base = {
        ...s,
        nightlyRate: s.nightlyRate === null ? null : toDec(s.nightlyRate).toFixed(2),
        chargeLimit: s.chargeLimit === null ? null : toDec(s.chargeLimit).toFixed(2),
        room: roomRows.find((r) => r.id === s.roomId) ?? null,
        roomType: typeRows.find((t) => t.id === s.roomTypeId) ?? null,
        customer: s.customerId ? (customerRows.find((c) => c.id === s.customerId) ?? null) : null,
        guestDisplayName: guests[0]?.fullName ?? s.guestName ?? customerRows.find((c) => c.id === s.customerId)?.displayName ?? null,
        guests: guests.map((g) => ({ id: g.id, fullName: g.fullName, isPrimary: g.isPrimary })),
        folio: folio ? { id: folio.id, status: folio.status } : null,
        overstay: s.status === 'IN_HOUSE' && branchDay !== null && s.departureDate < branchDay,
      };
      if (!detailed) {
        out.push(base);
        continue;
      }
      const beneficiaries = await db.select().from(stayBeneficiaries).where(eq(stayBeneficiaries.stayId, s.id));
      out.push({
        ...base,
        folio: folio ? { id: folio.id, status: folio.status, balance: (await folioBalance(db, folio.id)).toFixed(2), charged: (await chargedSoFar(db, folio.id)).toFixed(2) } : null,
        depositsHeld: (await depositsHeld(db, s.id)).toFixed(2),
        beneficiaries: beneficiaries.map((b) => ({ ...b, share: b.share === null ? null : toDec(b.share).toString() })),
        nightsPosted: (await db.select({ n: sql<number>`count(*)::int` }).from(folioEntries).where(and(eq(folioEntries.stayId, s.id), eq(folioEntries.kind, 'ROOM_NIGHT'))))[0]!.n,
      });
    }
    return out;
  }
}

