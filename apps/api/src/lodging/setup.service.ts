import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  branches,
  eq,
  inArray,
  isNull,
  lodgingSettings,
  priceLists,
  productPrices,
  products,
  productVariants,
  rooms,
  roomBlocks,
  roomStatusChanges,
  roomTypes,
  sql,
  stays,
  taxCategories,
  unitsOfMeasure,
  users,
  type Database,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type {
  CreateRoomBlockInput,
  CreateRoomInput,
  CreateRoomTypeInput,
  HousekeepingQuery,
  LodgingSettingsInput,
  RoomBlockListQuery,
  RoomListQuery,
  RoomStatusInput,
  RoomTypeListQuery,
  UpdateRoomInput,
  UpdateRoomTypeInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertLodging } from '../billing/entitlements.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { unprocessable } from '../tax/tax.service.js';

type RoomRow = typeof rooms.$inferSelect;
type RoomTypeRow = typeof roomTypes.$inferSelect;

/** Lodging settings of a branch, with the defaults when none were saved (§7, §10, §6). */
export async function branchLodgingSettings(db: Database, branchId: string) {
  const [row] = await db.select().from(lodgingSettings).where(eq(lodgingSettings.branchId, branchId));
  return {
    branchId,
    nightAuditTime: (row?.nightAuditTime ?? '03:00:00').slice(0, 5),
    accommodationTaxRate: row?.accommodationTaxRate ? toDec(row.accommodationTaxRate).toString() : null,
    forfeitOnCancel: row?.forfeitOnCancel ?? true,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Record a housekeeping status change (append-only history) and set it on the room. */
export async function changeRoomStatus(db: Database, a: { tenantId: string; room: RoomRow; to: RoomRow['housekeepingStatus']; note: string | null; userId: string; stayId?: string | null }) {
  if (a.room.housekeepingStatus === a.to && !a.note) return;
  await db.insert(roomStatusChanges).values({
    tenantId: a.tenantId, roomId: a.room.id, fromStatus: a.room.housekeepingStatus, toStatus: a.to, note: a.note, stayId: a.stayId ?? null, changedBy: a.userId,
  });
  await db.update(rooms).set({ housekeepingStatus: a.to, updatedAt: sql`now()` }).where(eq(rooms.id, a.room.id));
}

/**
 * Rooms and their set-up (ADR-0023 §2, §9, §10): room types (business-wide, each with its room-night
 * item), rooms per branch, blocks (out of order), housekeeping and the branch's lodging settings.
 * `lodging.setup` sets up; `lodging.read` sees; `lodging.housekeeping` changes a room's status.
 */
@Injectable()
export class LodgingSetupService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    room_types_code_active_unique: ['CODE_TAKEN', 'Another room type already uses this code'],
    rooms_number_active_unique: ['ROOM_NUMBER_TAKEN', 'Another room of this branch already has this number'],
    product_variants_tenant_sku_unique: ['SKU_TAKEN', 'Another item already uses this room type\'s SKU'],
    room_blocks_no_overlap: ['ROOM_ALREADY_BLOCKED', 'The room is already out of order on some of these dates'],
    room_blocks_stay_overlap: ['ROOM_BOOKED', 'The room is booked on some of these dates; move the guests first'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- room types

  listRoomTypes(auth: AuthContext, q: RoomTypeListQuery) {
    this.assertHolds(auth, 'lodging.read');
    return this.read(auth, async (db) => {
      const rows = await db.select().from(roomTypes).where(q.includeArchived ? undefined : isNull(roomTypes.archivedAt)).orderBy(asc(roomTypes.code));
      return { data: await this.typeViews(db, rows) };
    });
  }

  getRoomType(auth: AuthContext, id: string) {
    this.assertHolds(auth, 'lodging.read');
    return this.read(auth, async (db) => (await this.typeViews(db, [await this.loadType(db, id)]))[0]!);
  }

  /** Room types are business-wide (no branch): set up with a business-wide grant, never a branch one. */
  createRoomType(auth: AuthContext, input: CreateRoomTypeInput) {
    this.assertCan(auth, 'lodging.setup');
    // Without a night item given, one is made and priced on the default list: the catalog's own rules.
    if (!input.nightVariantId) {
      this.assertCan(auth, 'catalog.manage');
      this.assertCan(auth, 'prices.manage');
    }
    return this.mutate(auth, async (db) => {
      await assertLodging(db);
      const tenantId = tenantOf(auth).tenantId;
      const variantId = input.nightVariantId ? (await this.nightItem(db, input.nightVariantId)).id : await this.createNightItem(db, auth, input);
      const [row] = await db
        .insert(roomTypes)
        .values({ tenantId, code: input.code, name: input.name, baseOccupancy: input.baseOccupancy, maxOccupancy: input.maxOccupancy ?? input.baseOccupancy, nightVariantId: variantId })
        .returning();
      await this.audit(db, auth, 'room_type.created', 'room_type', row!.id, { code: row!.code, nightVariantId: variantId });
      return (await this.typeViews(db, [row!]))[0]!;
    });
  }

  updateRoomType(auth: AuthContext, id: string, input: UpdateRoomTypeInput) {
    this.assertCan(auth, 'lodging.setup');
    return this.mutate(auth, async (db) => {
      await assertLodging(db);
      const row = await this.loadType(db, id);
      if (row.archivedAt && input.archived !== false) throw archived('Room type');
      if (input.nightVariantId) await this.nightItem(db, input.nightVariantId);
      const base = input.baseOccupancy ?? row.baseOccupancy;
      const max = input.maxOccupancy ?? Math.max(row.maxOccupancy, base);
      if (max < base) throw unprocessable('VALIDATION_FAILED', 'The maximum occupancy is at least the base occupancy', { path: ['maxOccupancy'] });
      if (input.archived === true) {
        const { rows: [used] } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM rooms WHERE room_type_id = ${id} AND archived_at IS NULL`);
        if (Number(used!.n) > 0) throw new AppError('ROOM_TYPE_IN_USE', 'Rooms still have this type; change or archive them first', HttpStatus.CONFLICT, { rooms: Number(used!.n) });
      }
      const [updated] = await db
        .update(roomTypes)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          baseOccupancy: base,
          maxOccupancy: max,
          ...(input.nightVariantId !== undefined && { nightVariantId: input.nightVariantId }),
          ...(input.archived !== undefined && { archivedAt: input.archived ? sql`now()` : null }),
          updatedAt: sql`now()`,
        })
        .where(eq(roomTypes.id, id))
        .returning();
      await this.audit(db, auth, 'room_type.updated', 'room_type', id, { fields: Object.keys(input) });
      return (await this.typeViews(db, [updated!]))[0]!;
    });
  }

  // ---------------------------------------------------------------- rooms

  listRooms(auth: AuthContext, q: RoomListQuery) {
    return this.read(auth, async (db) => {
      if (q.branchId) {
        const { scope } = await branchScope(db, q.branchId);
        this.assertCan(auth, 'lodging.read', scope);
      } else this.assertHolds(auth, 'lodging.read');
      const rows = await db
        .select({ room: rooms, legalEntityId: branches.legalEntityId })
        .from(rooms)
        .innerJoin(branches, eq(branches.id, rooms.branchId))
        .where(and(q.branchId ? eq(rooms.branchId, q.branchId) : undefined, q.includeArchived ? undefined : isNull(rooms.archivedAt)))
        .orderBy(asc(rooms.branchId), asc(rooms.number));
      const visible = rows.filter((r) => this.can(auth, 'lodging.read', { branchId: r.room.branchId, legalEntityId: r.legalEntityId })).map((r) => r.room);
      return { data: await this.roomViews(db, visible) };
    });
  }

  getRoom(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const room = await this.loadRoom(db, id);
      const { scope } = await branchScope(db, room.branchId);
      this.assertCan(auth, 'lodging.read', scope);
      return (await this.roomViews(db, [room]))[0]!;
    });
  }

  createRoom(auth: AuthContext, input: CreateRoomInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'lodging.setup', scope);
      await assertLodging(db);
      if (branch.archivedAt) throw archived('Branch');
      const type = await this.loadType(db, input.roomTypeId);
      if (type.archivedAt) throw archived('Room type');
      const [row] = await db
        .insert(rooms)
        .values({ tenantId: tenantOf(auth).tenantId, branchId: branch.id, roomTypeId: type.id, number: input.number, floor: input.floor ?? null, notes: input.notes ?? null })
        .returning();
      await this.audit(db, auth, 'room.created', 'room', row!.id, { branchId: branch.id, number: row!.number, roomTypeId: type.id });
      return (await this.roomViews(db, [row!]))[0]!;
    });
  }

  updateRoom(auth: AuthContext, id: string, input: UpdateRoomInput) {
    return this.mutate(auth, async (db) => {
      const room = await this.loadRoom(db, id);
      const { scope } = await branchScope(db, room.branchId);
      this.assertCan(auth, 'lodging.setup', scope);
      await assertLodging(db);
      if (room.archivedAt && input.archived !== false) throw archived('Room');
      if (input.roomTypeId) {
        const type = await this.loadType(db, input.roomTypeId);
        if (type.archivedAt) throw archived('Room type');
      }
      if (input.archived === true) {
        const { rows: [open] } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM stays WHERE room_id = ${id} AND status IN ('BOOKED', 'IN_HOUSE')`);
        if (Number(open!.n) > 0) throw new AppError('ROOM_HAS_STAYS', 'The room has bookings or guests in house; move them first', HttpStatus.CONFLICT, { stays: Number(open!.n) });
      }
      const [updated] = await db
        .update(rooms)
        .set({
          ...(input.roomTypeId !== undefined && { roomTypeId: input.roomTypeId }),
          ...(input.number !== undefined && { number: input.number }),
          ...(input.floor !== undefined && { floor: input.floor }),
          ...(input.notes !== undefined && { notes: input.notes }),
          ...(input.archived !== undefined && { archivedAt: input.archived ? sql`now()` : null }),
          updatedAt: sql`now()`,
        })
        .where(eq(rooms.id, id))
        .returning();
      await this.audit(db, auth, 'room.updated', 'room', id, { fields: Object.keys(input) });
      return (await this.roomViews(db, [updated!]))[0]!;
    });
  }

  /** Housekeeping (§9): CLEAN, DIRTY, INSPECTED or OUT_OF_ORDER (with a note), kept as history. */
  setRoomStatus(auth: AuthContext, id: string, input: RoomStatusInput) {
    return this.mutate(auth, async (db) => {
      const [room] = await db.select().from(rooms).where(eq(rooms.id, id)).for('update');
      if (!room) throw notFound('Room');
      const { scope } = await branchScope(db, room.branchId);
      this.assertCan(auth, 'lodging.housekeeping', scope);
      await assertLodging(db);
      if (room.archivedAt) throw archived('Room');
      await changeRoomStatus(db, { tenantId: tenantOf(auth).tenantId, room, to: input.status, note: input.note ?? null, userId: auth.userId });
      await this.audit(db, auth, 'room.status_changed', 'room', id, { from: room.housekeepingStatus, to: input.status });
      return (await this.roomViews(db, [(await this.loadRoom(db, id))]))[0]!;
    });
  }

  statusChanges(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const room = await this.loadRoom(db, id);
      const { scope } = await branchScope(db, room.branchId);
      this.assertCan(auth, 'lodging.read', scope);
      const rows = await db
        .select({ c: roomStatusChanges, by: users.displayName })
        .from(roomStatusChanges)
        .leftJoin(users, eq(users.id, roomStatusChanges.changedBy))
        .where(eq(roomStatusChanges.roomId, id))
        .orderBy(sql`${roomStatusChanges.changedAt} DESC`, sql`${roomStatusChanges.id} DESC`)
        .limit(100);
      return { data: rows.map((r) => ({ ...r.c, changedByName: r.by ?? null })) };
    });
  }

  /**
   * The housekeeping board of a branch: every active room with its status and who set it last, and
   * whether it is occupied tonight, has a departure or an arrival today (in the branch's calendar).
   */
  housekeeping(auth: AuthContext, q: HousekeepingQuery) {
    return this.read(auth, async (db) => {
      const { branch, scope } = await branchScope(db, q.branchId);
      this.assertCan(auth, 'lodging.read', scope);
      const { rows } = await db.execute<{
        id: string; number: string; floor: string | null; room_type_id: string; type_code: string; type_name: string; status: string;
        changed_at: string | null; changed_by: string | null; note: string | null; occupied: boolean; departing: boolean; overstay: boolean; arriving: boolean; today: string;
      }>(sql`
        WITH today AS (SELECT (now() AT TIME ZONE ${branch.timezone})::date AS d)
        SELECT r.id, r.number, r.floor, r.room_type_id, t.code AS type_code, t.name AS type_name, r.housekeeping_status AS status,
               c.changed_at::text, u.display_name AS changed_by, c.note,
               EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'IN_HOUSE') AS occupied,
               EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'IN_HOUSE' AND s.departure_date <= today.d) AS departing,
               EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'IN_HOUSE' AND s.departure_date < today.d) AS overstay,
               EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'BOOKED' AND s.arrival_date <= today.d) AS arriving,
               today.d::text AS today
          FROM rooms r JOIN room_types t ON t.id = r.room_type_id CROSS JOIN today
          LEFT JOIN LATERAL (SELECT x.changed_at, x.changed_by, x.note FROM room_status_changes x WHERE x.room_id = r.id ORDER BY x.changed_at DESC, x.id DESC LIMIT 1) c ON true
          LEFT JOIN users u ON u.id = c.changed_by
         WHERE r.branch_id = ${branch.id} AND r.archived_at IS NULL
         ORDER BY r.number`);
      return {
        branchId: branch.id,
        day: rows[0]?.today ?? null,
        data: rows.map((r) => ({
          roomId: r.id, number: r.number, floor: r.floor, roomType: { id: r.room_type_id, code: r.type_code, name: r.type_name }, status: r.status,
          lastChange: r.changed_at ? { at: r.changed_at, byName: r.changed_by, note: r.note } : null,
          occupied: r.occupied, overstay: r.overstay, departingToday: r.departing, arrivingToday: r.arriving,
        })),
      };
    });
  }

  // ---------------------------------------------------------------- blocks (out of order)

  listBlocks(auth: AuthContext, q: RoomBlockListQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertCan(auth, 'lodging.read', scope);
      const rows = await db
        .select({ b: roomBlocks, number: rooms.number })
        .from(roomBlocks)
        .innerJoin(rooms, eq(rooms.id, roomBlocks.roomId))
        .where(and(
          eq(roomBlocks.branchId, q.branchId),
          q.to ? sql`${roomBlocks.startsOn} < ${q.to}::date` : undefined,
          q.from ? sql`${roomBlocks.endsOn} > ${q.from}::date` : undefined,
        ))
        .orderBy(asc(roomBlocks.startsOn), asc(rooms.number));
      return { data: rows.map((r) => ({ ...r.b, roomNumber: r.number })) };
    });
  }

  createBlock(auth: AuthContext, input: CreateRoomBlockInput) {
    return this.mutate(auth, async (db) => {
      const room = await this.loadRoom(db, input.roomId);
      const { scope } = await branchScope(db, room.branchId);
      if (!this.can(auth, 'lodging.setup', scope)) this.assertCan(auth, 'lodging.manage', scope);
      await assertLodging(db);
      if (room.archivedAt) throw archived('Room');
      const [row] = await db
        .insert(roomBlocks)
        .values({ tenantId: tenantOf(auth).tenantId, branchId: room.branchId, roomId: room.id, startsOn: input.startsOn, endsOn: input.endsOn, reason: input.reason, createdBy: auth.userId })
        .returning();
      await this.audit(db, auth, 'room.blocked', 'room', room.id, { roomBlockId: row!.id, startsOn: input.startsOn, endsOn: input.endsOn });
      return { ...row!, roomNumber: room.number };
    });
  }

  removeBlock(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const [row] = await db.select().from(roomBlocks).where(eq(roomBlocks.id, id));
      if (!row) throw notFound('Room block');
      const { scope } = await branchScope(db, row.branchId);
      if (!this.can(auth, 'lodging.setup', scope)) this.assertCan(auth, 'lodging.manage', scope);
      await assertLodging(db);
      await db.delete(roomBlocks).where(eq(roomBlocks.id, id));
      await this.audit(db, auth, 'room.unblocked', 'room', row.roomId, { roomBlockId: id, startsOn: row.startsOn, endsOn: row.endsOn });
      return { removed: true, id };
    });
  }

  // ---------------------------------------------------------------- settings

  getSettings(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, branchId);
      this.assertCan(auth, 'lodging.read', scope);
      return branchLodgingSettings(db, branchId);
    });
  }

  updateSettings(auth: AuthContext, branchId: string, input: LodgingSettingsInput) {
    return this.mutate(auth, async (db) => {
      const { scope } = await branchScope(db, branchId);
      this.assertCan(auth, 'lodging.setup', scope);
      await assertLodging(db);
      const set = {
        ...(input.nightAuditTime !== undefined && { nightAuditTime: input.nightAuditTime }),
        ...(input.accommodationTaxRate !== undefined && { accommodationTaxRate: input.accommodationTaxRate }),
        ...(input.forfeitOnCancel !== undefined && { forfeitOnCancel: input.forfeitOnCancel }),
        updatedBy: auth.userId,
        updatedAt: sql`now()`,
      };
      await db
        .insert(lodgingSettings)
        .values({ tenantId: tenantOf(auth).tenantId, branchId, ...set })
        .onConflictDoUpdate({ target: [lodgingSettings.tenantId, lodgingSettings.branchId], set });
      await this.audit(db, auth, 'lodging_settings.updated', 'branch', branchId, { ...input });
      return branchLodgingSettings(db, branchId);
    });
  }

  // ---------------------------------------------------------------- helpers

  private async loadType(db: Database, id: string): Promise<RoomTypeRow> {
    const [row] = await db.select().from(roomTypes).where(eq(roomTypes.id, id));
    if (!row) throw notFound('Room type');
    return row;
  }

  private async loadRoom(db: Database, id: string): Promise<RoomRow> {
    const [row] = await db.select().from(rooms).where(eq(rooms.id, id));
    if (!row) throw notFound('Room');
    return row;
  }

  /** A room night is a SERVICE item, never stock-tracked (§2). */
  private async nightItem(db: Database, variantId: string) {
    const [row] = await db
      .select({ id: productVariants.id, productType: products.productType, trackInventory: products.trackInventory, archivedAt: productVariants.archivedAt })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(productVariants.id, variantId));
    if (!row) throw new AppError('NOT_FOUND', 'Item not found', HttpStatus.NOT_FOUND, { nightVariantId: variantId });
    if (row.archivedAt) throw archived('Item');
    if (row.productType !== 'SERVICE' || row.trackInventory) throw unprocessable('NOT_A_SERVICE', 'A room night is a service item that is not stock-tracked');
    return row;
  }

  /** The room-night item made with the room type: "<name> — room night", priced at the rack rate on the default list. */
  private async createNightItem(db: Database, auth: AuthContext, input: CreateRoomTypeInput): Promise<string> {
    const tenantId = tenantOf(auth).tenantId;
    const [tax] = input.taxCategoryId
      ? await db.select({ id: taxCategories.id }).from(taxCategories).where(and(eq(taxCategories.id, input.taxCategoryId), isNull(taxCategories.archivedAt)))
      : await db.select({ id: taxCategories.id }).from(taxCategories).where(and(eq(taxCategories.code, 'VAT'), isNull(taxCategories.archivedAt)));
    if (!tax) throw new AppError('NOT_FOUND', 'Tax category not found', HttpStatus.NOT_FOUND, { taxCategoryId: input.taxCategoryId ?? null });
    const [unit] = await db.select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(and(eq(unitsOfMeasure.code, 'PC'), isNull(unitsOfMeasure.archivedAt)));
    const [list] = await db.select({ id: priceLists.id }).from(priceLists).where(and(eq(priceLists.isDefault, true), isNull(priceLists.archivedAt)));
    if (!unit || !list) throw new AppError('NO_DEFAULT_PRICE_LIST', 'Create a default price list and the piece unit first', HttpStatus.UNPROCESSABLE_ENTITY);
    const [product] = await db
      .insert(products)
      .values({ tenantId, name: `${input.name} — room night`, taxCategoryId: tax.id, uomId: unit.id, productType: 'SERVICE', trackInventory: false })
      .returning({ id: products.id });
    const [variant] = await db.insert(productVariants).values({ tenantId, productId: product!.id, sku: `ROOM-${input.code}`, attributes: {} }).returning({ id: productVariants.id });
    await db.insert(productPrices).values({ tenantId, priceListId: list.id, variantId: variant!.id, amount: input.rackRate!, effectiveFrom: sql`now()`, createdBy: auth.userId });
    return variant!.id;
  }

  private async typeViews(db: Database, rows: RoomTypeRow[]) {
    if (!rows.length) return [];
    const items = await db
      .select({ id: productVariants.id, sku: productVariants.sku, name: products.name })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(inArray(productVariants.id, [...new Set(rows.map((r) => r.nightVariantId))]));
    const { rows: counts } = await db.execute<{ room_type_id: string; n: number }>(sql`
      SELECT room_type_id, count(*)::int AS n FROM rooms WHERE archived_at IS NULL AND room_type_id IN (${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)}) GROUP BY 1`);
    return rows.map((r) => ({
      ...r,
      nightItem: items.find((i) => i.id === r.nightVariantId) ?? null,
      rooms: Number(counts.find((c) => c.room_type_id === r.id)?.n ?? 0),
    }));
  }

  private async roomViews(db: Database, rows: RoomRow[]) {
    if (!rows.length) return [];
    const types = await db.select({ id: roomTypes.id, code: roomTypes.code, name: roomTypes.name }).from(roomTypes).where(inArray(roomTypes.id, [...new Set(rows.map((r) => r.roomTypeId))]));
    // Occupied: a guest in house holds the room, whatever its housekeeping status (no status value of its own).
    const held = await db.select({ roomId: stays.roomId, stayId: stays.id }).from(stays).where(and(inArray(stays.roomId, rows.map((r) => r.id)), eq(stays.status, 'IN_HOUSE')));
    return rows.map((r) => ({ ...r, roomType: types.find((t) => t.id === r.roomTypeId) ?? null, occupied: held.some((h) => h.roomId === r.id), occupiedByStayId: held.find((h) => h.roomId === r.id)?.stayId ?? null }));
  }
}
