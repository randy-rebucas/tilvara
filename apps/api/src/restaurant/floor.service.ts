import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  diningAreas,
  eq,
  inArray,
  isNull,
  kitchenStations,
  menus,
  products,
  productVariants,
  restaurantOrders,
  restaurantSettings,
  restaurantTables,
  soldOutItems,
  sql,
  type Database,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type {
  CreateDiningAreaInput,
  CreateKitchenStationInput,
  CreateRestaurantTableInput,
  PermissionCode,
  RestaurantSettingsInput,
  SoldOutInput,
  UpdateDiningAreaInput,
  UpdateKitchenStationInput,
  UpdateRestaurantTableInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import type { ResourceScope } from '../auth/authorization.js';
import { assertFeature } from '../billing/entitlements.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { unprocessable } from '../tax/tax.service.js';

/** Who may read a branch's restaurant set-up: managers, floor staff and the kitchen. */
const FLOOR_READ: PermissionCode[] = ['restaurant.manage', 'restaurant.orders', 'kitchen.operate'];

export const DEFAULT_SETTINGS = {
  dineInMenuId: null,
  takeawayMenuId: null,
  serviceChargeRate: '0',
  serviceChargeDineIn: true,
  serviceChargeTakeaway: false,
  serviceChargeVatTreatment: 'VATABLE' as const,
  counterService: false,
};

/**
 * Branch restaurant set-up (ADR-0014 §5, §9): kitchen stations, dining areas and tables, menus and
 * service charge per branch, and items sold out right now ("86").
 */
@Injectable()
export class FloorService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    kitchen_stations_code_active_unique: ['STATION_CODE_TAKEN', 'This branch already has a station with this code'],
    kitchen_stations_default_unique: ['DEFAULT_STATION_EXISTS', 'This branch already has a default station'],
    dining_areas_name_active_unique: ['AREA_NAME_TAKEN', 'This branch already has an area with this name'],
    restaurant_tables_code_active_unique: ['TABLE_CODE_TAKEN', 'This branch already has a table with this code'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  private assertAny(auth: AuthContext, perms: PermissionCode[], scope: ResourceScope) {
    if (!perms.some((p) => this.can(auth, p, scope))) this.assertCan(auth, perms[0]!, scope);
  }

  /** Branch-scoped write: restaurant.manage at the branch, the restaurant plan, an active branch. */
  private async managed(db: Database, auth: AuthContext, branchId: string) {
    const b = await branchScope(db, branchId);
    this.assertCan(auth, 'restaurant.manage', b.scope);
    await assertFeature(db, 'restaurant');
    if (b.branch.archivedAt) throw archived('Branch');
    return b;
  }

  // ---------------------------------------------------------------- stations
  listStations(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, branchId);
      this.assertAny(auth, FLOOR_READ, scope);
      const rows = await db.select().from(kitchenStations)
        .where(and(eq(kitchenStations.branchId, branchId), isNull(kitchenStations.archivedAt)))
        .orderBy(asc(kitchenStations.code));
      return { data: rows };
    });
  }

  createStation(auth: AuthContext, input: CreateKitchenStationInput) {
    return this.mutate(auth, async (db) => {
      await this.managed(db, auth, input.branchId);
      if (input.isDefault) await this.clearDefaultStation(db, input.branchId);
      const [row] = await db.insert(kitchenStations)
        .values({ tenantId: tenantOf(auth).tenantId, branchId: input.branchId, code: input.code, name: input.name, isDefault: input.isDefault })
        .returning();
      await this.audit(db, auth, 'kitchen_station.created', 'kitchen_station', row!.id, { code: row!.code, branchId: input.branchId });
      return row!;
    });
  }

  updateStation(auth: AuthContext, id: string, input: UpdateKitchenStationInput) {
    return this.mutate(auth, async (db) => {
      const station = await this.station(db, id);
      await this.managed(db, auth, station.branchId);
      if (station.archivedAt) throw archived('Station');
      if (input.isDefault) await this.clearDefaultStation(db, station.branchId);
      const [row] = await db.update(kitchenStations).set(input).where(eq(kitchenStations.id, id)).returning();
      await this.audit(db, auth, 'kitchen_station.updated', 'kitchen_station', id, input);
      return row!;
    });
  }

  archiveStation(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const station = await this.station(db, id);
      await this.managed(db, auth, station.branchId);
      if (station.archivedAt) return station;
      const [row] = await db.update(kitchenStations).set({ archivedAt: sql`now()`, isDefault: false }).where(eq(kitchenStations.id, id)).returning();
      await this.audit(db, auth, 'kitchen_station.archived', 'kitchen_station', id);
      return row!;
    });
  }

  private async clearDefaultStation(db: Database, branchId: string) {
    await db.update(kitchenStations).set({ isDefault: false })
      .where(and(eq(kitchenStations.branchId, branchId), eq(kitchenStations.isDefault, true)));
  }

  private async station(db: Database, id: string) {
    const [row] = await db.select().from(kitchenStations).where(eq(kitchenStations.id, id));
    if (!row) throw notFound('Station');
    return row;
  }

  // ---------------------------------------------------------------- areas and tables
  /** Areas with their active tables (the floor plan). */
  listAreas(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, branchId);
      this.assertAny(auth, FLOOR_READ, scope);
      const areas = await db.select().from(diningAreas)
        .where(and(eq(diningAreas.branchId, branchId), isNull(diningAreas.archivedAt)))
        .orderBy(asc(diningAreas.sortOrder), asc(diningAreas.name));
      const tables = await db.select().from(restaurantTables)
        .where(and(eq(restaurantTables.branchId, branchId), isNull(restaurantTables.archivedAt)))
        .orderBy(asc(restaurantTables.code));
      return { data: areas.map((a) => ({ ...a, tables: tables.filter((t) => t.areaId === a.id).map(tableView) })) };
    });
  }

  createArea(auth: AuthContext, input: CreateDiningAreaInput) {
    return this.mutate(auth, async (db) => {
      await this.managed(db, auth, input.branchId);
      const [row] = await db.insert(diningAreas)
        .values({ tenantId: tenantOf(auth).tenantId, branchId: input.branchId, name: input.name, sortOrder: input.sortOrder })
        .returning();
      await this.audit(db, auth, 'dining_area.created', 'dining_area', row!.id, { name: row!.name, branchId: input.branchId });
      return row!;
    });
  }

  updateArea(auth: AuthContext, id: string, input: UpdateDiningAreaInput) {
    return this.mutate(auth, async (db) => {
      const area = await this.area(db, id);
      await this.managed(db, auth, area.branchId);
      if (area.archivedAt) throw archived('Area');
      const [row] = await db.update(diningAreas).set(input).where(eq(diningAreas.id, id)).returning();
      await this.audit(db, auth, 'dining_area.updated', 'dining_area', id, input);
      return row!;
    });
  }

  archiveArea(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const area = await this.area(db, id);
      await this.managed(db, auth, area.branchId);
      if (area.archivedAt) return area;
      const [busy] = await db.select({ id: restaurantTables.id }).from(restaurantTables)
        .where(and(eq(restaurantTables.areaId, id), isNull(restaurantTables.archivedAt))).limit(1);
      if (busy) throw new AppError('AREA_HAS_TABLES', 'Move or archive the tables in this area first', HttpStatus.CONFLICT);
      const [row] = await db.update(diningAreas).set({ archivedAt: sql`now()` }).where(eq(diningAreas.id, id)).returning();
      await this.audit(db, auth, 'dining_area.archived', 'dining_area', id);
      return row!;
    });
  }

  createTable(auth: AuthContext, input: CreateRestaurantTableInput) {
    return this.mutate(auth, async (db) => {
      const area = await this.area(db, input.areaId);
      await this.managed(db, auth, area.branchId);
      if (area.archivedAt) throw archived('Area');
      const [row] = await db.insert(restaurantTables)
        .values({
          tenantId: tenantOf(auth).tenantId,
          branchId: area.branchId,
          areaId: area.id,
          code: input.code,
          seats: input.seats,
          posX: input.position?.x ?? null,
          posY: input.position?.y ?? null,
          shape: input.shape ?? null,
        })
        .returning();
      await this.audit(db, auth, 'restaurant_table.created', 'restaurant_table', row!.id, { code: row!.code, areaId: area.id });
      return tableView(row!);
    });
  }

  updateTable(auth: AuthContext, id: string, input: UpdateRestaurantTableInput) {
    return this.mutate(auth, async (db) => {
      const table = await this.table(db, id);
      await this.managed(db, auth, table.branchId);
      if (table.archivedAt) throw archived('Table');
      if (input.areaId) {
        const area = await this.area(db, input.areaId);
        // Tables move between areas of their own branch only (the FK pins it too).
        if (area.branchId !== table.branchId) throw notFound('Area');
        if (area.archivedAt) throw archived('Area');
      }
      const { position, ...rest } = input;
      const [row] = await db.update(restaurantTables)
        .set({ ...rest, ...(position !== undefined && { posX: position?.x ?? null, posY: position?.y ?? null }) })
        .where(eq(restaurantTables.id, id))
        .returning();
      await this.audit(db, auth, 'restaurant_table.updated', 'restaurant_table', id, input);
      return tableView(row!);
    });
  }

  archiveTable(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const table = await this.table(db, id);
      await this.managed(db, auth, table.branchId);
      if (table.archivedAt) return tableView(table);
      const [live] = await db.select({ id: restaurantOrders.id }).from(restaurantOrders)
        .where(and(eq(restaurantOrders.tableId, id), inArray(restaurantOrders.status, ['OPEN', 'BILLED']))).limit(1);
      if (live) throw new AppError('TABLE_HAS_ORDER', 'This table has an open order; settle or move it first', HttpStatus.CONFLICT, { orderId: live.id });
      const [row] = await db.update(restaurantTables).set({ archivedAt: sql`now()` }).where(eq(restaurantTables.id, id)).returning();
      await this.audit(db, auth, 'restaurant_table.archived', 'restaurant_table', id);
      return tableView(row!);
    });
  }

  private async area(db: Database, id: string) {
    const [row] = await db.select().from(diningAreas).where(eq(diningAreas.id, id));
    if (!row) throw notFound('Area');
    return row;
  }

  private async table(db: Database, id: string) {
    const [row] = await db.select().from(restaurantTables).where(eq(restaurantTables.id, id));
    if (!row) throw notFound('Table');
    return row;
  }

  // ---------------------------------------------------------------- branch settings
  getSettings(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, branchId);
      this.assertAny(auth, FLOOR_READ, scope);
      return settingsView(branchId, await loadSettings(db, branchId));
    });
  }

  putSettings(auth: AuthContext, branchId: string, input: RestaurantSettingsInput) {
    return this.mutate(auth, async (db) => {
      await this.managed(db, auth, branchId);
      for (const menuId of [input.dineInMenuId, input.takeawayMenuId]) {
        if (!menuId) continue;
        const [m] = await db.select({ archivedAt: menus.archivedAt }).from(menus).where(eq(menus.id, menuId));
        if (!m) throw new AppError('NOT_FOUND', 'Menu not found', HttpStatus.NOT_FOUND, { menuId });
        if (m.archivedAt) throw archived('Menu');
      }
      const { counterService, ...rest } = input;
      const counter = counterService ?? (await loadSettings(db, branchId))?.counterService ?? false;
      // Counter service sells from the takeaway menu: without one, the counter would have nothing to offer.
      if (counter && !input.takeawayMenuId) throw unprocessable('COUNTER_NEEDS_MENU', 'Counter service sells from the takeaway menu: choose one first', { path: ['takeawayMenuId'] });
      const values = { ...rest, counterService: counter, updatedBy: auth.userId, updatedAt: sql`now()` };
      await db.insert(restaurantSettings)
        .values({ tenantId: tenantOf(auth).tenantId, branchId, ...values })
        .onConflictDoUpdate({ target: [restaurantSettings.tenantId, restaurantSettings.branchId], set: values });
      await this.audit(db, auth, 'restaurant_settings.updated', 'branch', branchId, input);
      return settingsView(branchId, await loadSettings(db, branchId));
    });
  }

  // ---------------------------------------------------------------- 86
  listSoldOut(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, branchId);
      this.assertAny(auth, FLOOR_READ, scope);
      const rows = await db
        .select({ row: soldOutItems, sku: productVariants.sku, name: sql<string>`coalesce(${productVariants.name}, ${products.name})` })
        .from(soldOutItems)
        .innerJoin(productVariants, eq(productVariants.id, soldOutItems.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(soldOutItems.branchId, branchId))
        .orderBy(asc(productVariants.sku));
      return { data: rows.map((r) => ({ ...r.row, sku: r.sku, name: r.name })) };
    });
  }

  /** Mark an item sold out (or back) at a branch: the kitchen or a manager, during service. */
  setSoldOut(auth: AuthContext, branchId: string, input: SoldOutInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, branchId);
      this.assertAny(auth, ['restaurant.manage', 'kitchen.operate'], scope);
      await assertFeature(db, 'restaurant');
      if (branch.archivedAt) throw archived('Branch');
      const [variant] = await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, input.variantId));
      if (!variant) throw new AppError('NOT_FOUND', 'Item not found', HttpStatus.NOT_FOUND, { variantId: input.variantId });
      if (input.soldOut) {
        const values = { note: input.note ?? null, markedBy: auth.userId, markedAt: sql`now()` };
        await db.insert(soldOutItems)
          .values({ tenantId: tenantOf(auth).tenantId, branchId, variantId: input.variantId, ...values })
          .onConflictDoUpdate({ target: [soldOutItems.tenantId, soldOutItems.branchId, soldOutItems.variantId], set: values });
      } else {
        await db.delete(soldOutItems).where(and(eq(soldOutItems.branchId, branchId), eq(soldOutItems.variantId, input.variantId)));
      }
      await this.audit(db, auth, input.soldOut ? 'item.sold_out' : 'item.back_in_service', 'branch', branchId, { variantId: input.variantId, note: input.note ?? null });
      return { branchId, variantId: input.variantId, soldOut: input.soldOut };
    });
  }
}

export async function loadSettings(db: Database, branchId: string) {
  const [row] = await db.select().from(restaurantSettings).where(eq(restaurantSettings.branchId, branchId));
  return row ?? null;
}

function settingsView(branchId: string, row: typeof restaurantSettings.$inferSelect | null) {
  if (!row) return { branchId, ...DEFAULT_SETTINGS, updatedAt: null };
  return {
    branchId,
    dineInMenuId: row.dineInMenuId,
    takeawayMenuId: row.takeawayMenuId,
    serviceChargeRate: toDec(row.serviceChargeRate).toString(),
    serviceChargeDineIn: row.serviceChargeDineIn,
    serviceChargeTakeaway: row.serviceChargeTakeaway,
    serviceChargeVatTreatment: row.serviceChargeVatTreatment,
    counterService: row.counterService,
    updatedAt: row.updatedAt,
  };
}

function tableView(t: typeof restaurantTables.$inferSelect) {
  const { posX, posY, ...rest } = t;
  return { ...rest, position: posX === null || posY === null ? null : { x: posX, y: posY } };
}
