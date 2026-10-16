import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  menuItemModifierGroups,
  menuItems,
  menus,
  menuSections,
  menuVersions,
  modifierGroups,
  modifierOptions,
  or,
  products,
  productVariants,
  restaurantSettings,
  soldOutItems,
  sql,
  type Database,
} from '@1pos/database';
import type {
  BranchMenuQuery,
  CreateMenuInput,
  CreateModifierGroupInput,
  CreateModifierOptionInput,
  MenuContentInput,
  PermissionCode,
  UpdateMenuInput,
  UpdateModifierGroupInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertFeature } from '../billing/entitlements.js';
import { PricingService } from '../catalog/pricing.service.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { unprocessable } from '../tax/tax.service.js';
import { loadSettings } from './floor.service.js';

type Version = typeof menuVersions.$inferSelect;
const MENU_READ: PermissionCode[] = ['restaurant.manage', 'catalog.read'];

const conflict = (code: string, message: string, details?: Record<string, unknown>) => new AppError(code, message, HttpStatus.CONFLICT, details);

/**
 * Menus with versions and modifiers (ADR-0014 §2, §3). Menus are tenant-wide and say what is
 * offered and where it is prepared; prices come from the branch's price list, never the menu.
 */
@Injectable()
export class MenusService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    menus_name_active_unique: ['MENU_NAME_TAKEN', 'A menu with this name already exists'],
    menu_versions_one_draft: ['DRAFT_EXISTS', 'This menu already has a draft; edit or publish it first'],
    menu_versions_one_published: ['PUBLISH_CONFLICT', 'Another version was published at the same time; reload and try again'],
    menu_versions_version_unique: ['DRAFT_EXISTS', 'Another draft was started at the same time; reload and try again'],
    modifier_options_name_active_unique: ['OPTION_NAME_TAKEN', 'This group already has an option with this name'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(PricingService) private readonly pricing: PricingService,
  ) {
    super(tenantDb);
  }

  private assertRead(auth: AuthContext) {
    if (!MENU_READ.some((p) => this.can(auth, p))) this.assertCan(auth, MENU_READ[0]!);
  }

  private async manage(db: Database, auth: AuthContext) {
    this.assertCan(auth, 'restaurant.manage');
    await assertFeature(db, 'restaurant');
  }

  // ---------------------------------------------------------------- modifier groups
  listModifierGroups(auth: AuthContext) {
    this.assertRead(auth);
    return this.read(auth, async (db) => {
      const groups = await db.select().from(modifierGroups).where(isNull(modifierGroups.archivedAt)).orderBy(asc(modifierGroups.name));
      return { data: await this.withOptions(db, groups) };
    });
  }

  createModifierGroup(auth: AuthContext, input: CreateModifierGroupInput) {
    return this.mutate(auth, async (db) => {
      await this.manage(db, auth);
      await this.assertOptionVariants(db, input.options.map((o) => o.variantId));
      const tenantId = tenantOf(auth).tenantId;
      const [group] = await db.insert(modifierGroups)
        .values({ tenantId, name: input.name, minSelect: input.minSelect, maxSelect: input.maxSelect })
        .returning();
      await db.insert(modifierOptions).values(
        input.options.map((o, i) => ({ tenantId, modifierGroupId: group!.id, name: o.name, variantId: o.variantId ?? null, sortOrder: o.sortOrder ?? i })),
      );
      await this.audit(db, auth, 'modifier_group.created', 'modifier_group', group!.id, { name: group!.name, options: input.options.length });
      return (await this.withOptions(db, [group!]))[0]!;
    });
  }

  updateModifierGroup(auth: AuthContext, id: string, input: UpdateModifierGroupInput) {
    return this.mutate(auth, async (db) => {
      const group = await this.group(db, id);
      await this.manage(db, auth);
      if (group.archivedAt) throw archived('Modifier group');
      const min = input.minSelect ?? group.minSelect;
      const max = input.maxSelect ?? group.maxSelect;
      if (max < min) throw unprocessable('INVALID_SELECTION_BOUNDS', 'Maximum must be at least the minimum');
      if (min > (await this.activeOptionCount(db, id))) throw unprocessable('TOO_FEW_OPTIONS', 'More required choices than options in this group');
      const [row] = await db.update(modifierGroups).set(input).where(eq(modifierGroups.id, id)).returning();
      await this.audit(db, auth, 'modifier_group.updated', 'modifier_group', id, input);
      return (await this.withOptions(db, [row!]))[0]!;
    });
  }

  addModifierOption(auth: AuthContext, groupId: string, input: CreateModifierOptionInput) {
    return this.mutate(auth, async (db) => {
      const group = await this.group(db, groupId);
      await this.manage(db, auth);
      if (group.archivedAt) throw archived('Modifier group');
      await this.assertOptionVariants(db, [input.variantId]);
      const [{ next }] = (await db.execute<{ next: number }>(
        sql`SELECT coalesce(max(sort_order), -1) + 1 AS next FROM modifier_options WHERE modifier_group_id = ${groupId}`,
      )).rows as [{ next: number }];
      const [row] = await db.insert(modifierOptions)
        .values({ tenantId: tenantOf(auth).tenantId, modifierGroupId: groupId, name: input.name, variantId: input.variantId ?? null, sortOrder: input.sortOrder ?? Number(next) })
        .returning();
      await this.audit(db, auth, 'modifier_option.created', 'modifier_group', groupId, { optionId: row!.id, name: row!.name });
      return row!;
    });
  }

  archiveModifierGroup(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const group = await this.group(db, id);
      await this.manage(db, auth);
      if (group.archivedAt) return group;
      // Published menus keep showing what they offered; drafts must drop the group before publishing.
      const [row] = await db.update(modifierGroups).set({ archivedAt: sql`now()` }).where(eq(modifierGroups.id, id)).returning();
      await this.audit(db, auth, 'modifier_group.archived', 'modifier_group', id);
      return row!;
    });
  }

  archiveModifierOption(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const [option] = await db.select().from(modifierOptions).where(eq(modifierOptions.id, id));
      if (!option) throw notFound('Modifier option');
      await this.manage(db, auth);
      if (option.archivedAt) return option;
      const group = await this.group(db, option.modifierGroupId);
      const left = (await this.activeOptionCount(db, group.id)) - 1;
      if (left < Math.max(group.minSelect, 1)) {
        throw conflict('TOO_FEW_OPTIONS', 'A group needs at least one option and its required number of choices; lower the minimum or add an option first');
      }
      const [row] = await db.update(modifierOptions).set({ archivedAt: sql`now()` }).where(eq(modifierOptions.id, id)).returning();
      await this.audit(db, auth, 'modifier_option.archived', 'modifier_group', group.id, { optionId: id });
      return row!;
    });
  }

  private async group(db: Database, id: string) {
    const [row] = await db.select().from(modifierGroups).where(eq(modifierGroups.id, id));
    if (!row) throw notFound('Modifier group');
    return row;
  }

  private async activeOptionCount(db: Database, groupId: string) {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(modifierOptions)
      .where(and(eq(modifierOptions.modifierGroupId, groupId), isNull(modifierOptions.archivedAt)));
    return Number(r!.n);
  }

  private async assertOptionVariants(db: Database, ids: (string | null | undefined)[]) {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (!wanted.length) return;
    const found = await db.select({ id: productVariants.id, archivedAt: productVariants.archivedAt }).from(productVariants).where(inArray(productVariants.id, wanted));
    const missing = wanted.filter((w) => !found.some((f) => f.id === w));
    if (missing.length) throw new AppError('NOT_FOUND', 'Item not found', HttpStatus.NOT_FOUND, { variantIds: missing });
    if (found.some((f) => f.archivedAt)) throw unprocessable('ARCHIVED', 'An archived item cannot be offered', { variantIds: found.filter((f) => f.archivedAt).map((f) => f.id) });
  }

  private async withOptions(db: Database, groups: (typeof modifierGroups.$inferSelect)[]) {
    if (!groups.length) return [];
    const options = await db.select().from(modifierOptions)
      .where(and(inArray(modifierOptions.modifierGroupId, groups.map((g) => g.id)), isNull(modifierOptions.archivedAt)))
      .orderBy(asc(modifierOptions.sortOrder), asc(modifierOptions.name));
    return groups.map((g) => ({ ...g, required: g.minSelect > 0, options: options.filter((o) => o.modifierGroupId === g.id) }));
  }

  // ---------------------------------------------------------------- menus
  listMenus(auth: AuthContext) {
    this.assertRead(auth);
    return this.read(auth, async (db) => {
      const rows = await db.select().from(menus).where(isNull(menus.archivedAt)).orderBy(asc(menus.name));
      return { data: await Promise.all(rows.map((m) => this.menuView(db, m))) };
    });
  }

  getMenu(auth: AuthContext, id: string) {
    this.assertRead(auth);
    return this.read(auth, async (db) => this.menuView(db, await this.menu(db, id)));
  }

  /** A new menu starts with an empty draft (version 1). */
  createMenu(auth: AuthContext, input: CreateMenuInput) {
    return this.mutate(auth, async (db) => {
      await this.manage(db, auth);
      const tenantId = tenantOf(auth).tenantId;
      const [menu] = await db.insert(menus).values({ tenantId, name: input.name, createdBy: auth.userId }).returning();
      await db.insert(menuVersions).values({ tenantId, menuId: menu!.id, version: 1, createdBy: auth.userId });
      await this.audit(db, auth, 'menu.created', 'menu', menu!.id, { name: menu!.name });
      return this.menuView(db, menu!);
    });
  }

  renameMenu(auth: AuthContext, id: string, input: UpdateMenuInput) {
    return this.mutate(auth, async (db) => {
      const menu = await this.menu(db, id);
      await this.manage(db, auth);
      if (menu.archivedAt) throw archived('Menu');
      const [row] = await db.update(menus).set({ name: input.name }).where(eq(menus.id, id)).returning();
      await this.audit(db, auth, 'menu.renamed', 'menu', id, { name: input.name });
      return this.menuView(db, row!);
    });
  }

  archiveMenu(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const menu = await this.menu(db, id);
      await this.manage(db, auth);
      if (menu.archivedAt) return this.menuView(db, menu);
      const [used] = await db.select({ branchId: restaurantSettings.branchId }).from(restaurantSettings)
        .where(or(eq(restaurantSettings.dineInMenuId, id), eq(restaurantSettings.takeawayMenuId, id))).limit(1);
      if (used) throw conflict('MENU_IN_USE', 'A branch still serves this menu; assign another menu first', { branchId: used.branchId });
      const [row] = await db.update(menus).set({ archivedAt: sql`now()` }).where(eq(menus.id, id)).returning();
      await this.audit(db, auth, 'menu.archived', 'menu', id);
      return this.menuView(db, row!);
    });
  }

  /** Start editing: a new draft copied from the published version (else the latest one). */
  createDraft(auth: AuthContext, menuId: string) {
    return this.mutate(auth, async (db) => {
      const menu = await this.menu(db, menuId, true);
      await this.manage(db, auth);
      if (menu.archivedAt) throw archived('Menu');
      const versions = await db.select().from(menuVersions).where(eq(menuVersions.menuId, menuId)).orderBy(desc(menuVersions.version));
      if (versions.some((v) => v.status === 'DRAFT')) throw conflict('DRAFT_EXISTS', 'This menu already has a draft; edit or publish it first');
      const source = versions.find((v) => v.status === 'PUBLISHED') ?? versions[0];
      const tenantId = tenantOf(auth).tenantId;
      const [draft] = await db.insert(menuVersions)
        .values({ tenantId, menuId, version: (versions[0]?.version ?? 0) + 1, createdBy: auth.userId })
        .returning();
      if (source) await this.writeContent(db, tenantId, draft!.id, await this.content(db, source.id));
      await this.audit(db, auth, 'menu_version.drafted', 'menu', menuId, { menuVersionId: draft!.id, version: draft!.version, copiedFrom: source?.version ?? null });
      return this.versionView(db, draft!);
    });
  }

  // ---------------------------------------------------------------- versions
  getVersion(auth: AuthContext, id: string) {
    this.assertRead(auth);
    return this.read(auth, async (db) => this.versionView(db, await this.version(db, id)));
  }

  /** Replace a draft's whole content (sections → items → modifier groups, in display order). */
  putContent(auth: AuthContext, id: string, input: MenuContentInput) {
    return this.mutate(auth, async (db) => {
      const version = await this.version(db, id, true);
      await this.manage(db, auth);
      if (version.status !== 'DRAFT') throw conflict('VERSION_NOT_DRAFT', 'Only a draft can be edited; start a new draft from the menu');
      const items = input.sections.flatMap((s) => s.items);
      const variantIds = items.map((i) => i.variantId);
      if (variantIds.length) {
        const found = await db.select({ id: productVariants.id, archivedAt: productVariants.archivedAt }).from(productVariants).where(inArray(productVariants.id, variantIds));
        const missing = variantIds.filter((v) => !found.some((f) => f.id === v));
        if (missing.length) throw new AppError('NOT_FOUND', 'Item not found', HttpStatus.NOT_FOUND, { variantIds: missing });
        const gone = found.filter((f) => f.archivedAt).map((f) => f.id);
        if (gone.length) throw unprocessable('ARCHIVED', 'An archived item cannot be offered', { variantIds: gone });
      }
      const groupIds = [...new Set(items.flatMap((i) => i.modifierGroupIds))];
      if (groupIds.length) {
        const found = await db.select({ id: modifierGroups.id, archivedAt: modifierGroups.archivedAt }).from(modifierGroups).where(inArray(modifierGroups.id, groupIds));
        const missing = groupIds.filter((g) => !found.some((f) => f.id === g));
        if (missing.length) throw new AppError('NOT_FOUND', 'Modifier group not found', HttpStatus.NOT_FOUND, { modifierGroupIds: missing });
        const gone = found.filter((f) => f.archivedAt).map((f) => f.id);
        if (gone.length) throw unprocessable('ARCHIVED', 'An archived modifier group cannot be attached', { modifierGroupIds: gone });
      }
      await db.delete(menuItemModifierGroups).where(eq(menuItemModifierGroups.menuVersionId, id));
      await db.delete(menuItems).where(eq(menuItems.menuVersionId, id));
      await db.delete(menuSections).where(eq(menuSections.menuVersionId, id));
      await this.writeContent(db, tenantOf(auth).tenantId, id, input.sections);
      await this.audit(db, auth, 'menu_version.edited', 'menu', version.menuId, { menuVersionId: id, sections: input.sections.length, items: items.length });
      return this.versionView(db, version);
    });
  }

  /** Publish a draft: it becomes what branches serve; the previously published version retires. */
  publish(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const version = await this.version(db, id);
      await this.manage(db, auth);
      // One publisher per menu at a time (lock order: menu, then its versions).
      const menu = await this.menu(db, version.menuId, true);
      if (menu.archivedAt) throw archived('Menu');
      const [current] = await db.select().from(menuVersions).where(eq(menuVersions.id, id)).for('update');
      if (current!.status !== 'DRAFT') throw conflict('VERSION_NOT_DRAFT', 'Only a draft can be published');
      const content = await this.content(db, id);
      const items = content.flatMap((s) => s.items);
      if (!items.length) throw unprocessable('MENU_EMPTY', 'Add at least one item before publishing');
      const attached = [...new Set(items.flatMap((i) => i.modifierGroupIds))];
      const archivedGroups = attached.length
        ? await db.select({ id: modifierGroups.id }).from(modifierGroups).where(and(inArray(modifierGroups.id, attached), sql`${modifierGroups.archivedAt} IS NOT NULL`))
        : [];
      if (archivedGroups.length) throw unprocessable('ARCHIVED', 'Remove archived modifier groups before publishing', { modifierGroupIds: archivedGroups.map((g) => g.id) });
      const retired = await db.update(menuVersions).set({ status: 'RETIRED', retiredAt: sql`now()` })
        .where(and(eq(menuVersions.menuId, version.menuId), eq(menuVersions.status, 'PUBLISHED')))
        .returning({ version: menuVersions.version });
      const [row] = await db.update(menuVersions)
        .set({ status: 'PUBLISHED', publishedAt: sql`now()`, publishedBy: auth.userId })
        .where(eq(menuVersions.id, id))
        .returning();
      await this.audit(db, auth, 'menu_version.published', 'menu', version.menuId, { menuVersionId: id, version: row!.version, retired: retired[0]?.version ?? null });
      return this.versionView(db, row!);
    });
  }

  // ---------------------------------------------------------------- what a branch serves
  /**
   * The published menu a branch serves for an order type, with each item's branch price (null =
   * not priced here, cannot be sold), sold-out flags and modifier groups with their option prices.
   */
  branchMenu(auth: AuthContext, branchId: string, q: BranchMenuQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, branchId);
      if (!['restaurant.orders', 'restaurant.manage'].some((p) => this.can(auth, p as PermissionCode, scope))) this.assertCan(auth, 'restaurant.orders', scope);
      await assertFeature(db, 'restaurant');
      return this.served(db, branchId, q.orderType);
    });
  }

  /** What a branch serves right now (no permission check: callers authorize). Used by ordering too. */
  async served(db: Database, branchId: string, orderType: 'DINE_IN' | 'TAKEAWAY') {
    const settings = await loadSettings(db, branchId);
    const menuId = orderType === 'TAKEAWAY' ? settings?.takeawayMenuId : settings?.dineInMenuId;
    const empty = { branchId, orderType, menu: null };
    if (!menuId) return empty;
    const [menu] = await db.select().from(menus).where(eq(menus.id, menuId));
    const [version] = await db.select().from(menuVersions).where(and(eq(menuVersions.menuId, menuId), eq(menuVersions.status, 'PUBLISHED')));
    if (!menu || menu.archivedAt || !version) return empty;

    const content = await this.content(db, version.id);
    const items = content.flatMap((s) => s.items);
    const groupIds = [...new Set(items.flatMap((i) => i.modifierGroupIds))];
    const groups = groupIds.length ? await this.withOptions(db, await db.select().from(modifierGroups).where(inArray(modifierGroups.id, groupIds))) : [];
    const variantIds = [...new Set([...items.map((i) => i.variantId), ...groups.flatMap((g) => g.options.flatMap((o) => (o.variantId ? [o.variantId] : [])))])];
    const variants = variantIds.length
      ? await db.select({ id: productVariants.id, sku: productVariants.sku, name: productVariants.name, productName: products.name, archivedAt: productVariants.archivedAt, trackInventory: products.trackInventory })
          .from(productVariants).innerJoin(products, eq(products.id, productVariants.productId)).where(inArray(productVariants.id, variantIds))
      : [];
    const soldOut = new Set((await db.select({ v: soldOutItems.variantId }).from(soldOutItems).where(eq(soldOutItems.branchId, branchId))).map((r) => r.v));
    const prices = new Map<string, string | null>();
    for (const v of variantIds) prices.set(v, (await this.pricing.effectivePrice(db, branchId, v))?.amount ?? null);
    const variant = (id: string) => variants.find((v) => v.id === id)!;
    const sellable = (id: string) => !variant(id).archivedAt && prices.get(id) !== null && !soldOut.has(id);

    return {
      branchId,
      orderType,
      menu: {
        id: menu.id,
        name: menu.name,
        menuVersionId: version.id,
        version: version.version,
        sections: content.map((s) => ({
          id: s.id,
          name: s.name,
          items: s.items.map((it) => {
            const v = variant(it.variantId);
            return {
              id: it.id,
              variantId: it.variantId,
              sku: v.sku,
              name: it.displayName ?? v.name ?? v.productName,
              stationCode: it.stationCode,
              price: prices.get(it.variantId) ?? null,
              soldOut: soldOut.has(it.variantId),
              available: sellable(it.variantId),
              modifierGroups: it.modifierGroupIds.map((gid) => {
                const g = groups.find((x) => x.id === gid)!;
                return {
                  id: g.id,
                  name: g.name,
                  minSelect: g.minSelect,
                  maxSelect: g.maxSelect,
                  required: g.required,
                  options: g.options.map((o) => ({
                    id: o.id,
                    name: o.name,
                    variantId: o.variantId,
                    price: o.variantId ? (prices.get(o.variantId) ?? null) : '0',
                    available: o.variantId ? sellable(o.variantId) : true,
                  })),
                };
              }),
            };
          }),
        })),
      },
    };
  }

  // ---------------------------------------------------------------- helpers
  private async menu(db: Database, id: string, lock = false) {
    const q = db.select().from(menus).where(eq(menus.id, id));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw notFound('Menu');
    return row;
  }

  private async version(db: Database, id: string, lock = false) {
    const q = db.select().from(menuVersions).where(eq(menuVersions.id, id));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw notFound('Menu version');
    return row;
  }

  private async menuView(db: Database, m: typeof menus.$inferSelect) {
    const versions = await db.select().from(menuVersions).where(eq(menuVersions.menuId, m.id)).orderBy(desc(menuVersions.version));
    const servedBy = await db.select({ branchId: restaurantSettings.branchId, dineIn: restaurantSettings.dineInMenuId, takeaway: restaurantSettings.takeawayMenuId })
      .from(restaurantSettings).where(or(eq(restaurantSettings.dineInMenuId, m.id), eq(restaurantSettings.takeawayMenuId, m.id)));
    return {
      ...m,
      draft: versions.find((v) => v.status === 'DRAFT') ?? null,
      published: versions.find((v) => v.status === 'PUBLISHED') ?? null,
      versions,
      servedBy: servedBy.map((s) => ({ branchId: s.branchId, orderTypes: [...(s.dineIn === m.id ? ['DINE_IN'] : []), ...(s.takeaway === m.id ? ['TAKEAWAY'] : [])] })),
    };
  }

  private async versionView(db: Database, v: Version) {
    const content = await this.content(db, v.id);
    const variantIds = content.flatMap((s) => s.items.map((i) => i.variantId));
    const variants = variantIds.length
      ? await db.select({ id: productVariants.id, sku: productVariants.sku, name: productVariants.name, productName: products.name })
          .from(productVariants).innerJoin(products, eq(products.id, productVariants.productId)).where(inArray(productVariants.id, variantIds))
      : [];
    return {
      ...v,
      sections: content.map((s) => ({
        ...s,
        items: s.items.map((i) => {
          const found = variants.find((x) => x.id === i.variantId);
          return { ...i, sku: found?.sku ?? null, name: i.displayName ?? found?.name ?? found?.productName ?? null };
        }),
      })),
    };
  }

  private async content(db: Database, versionId: string) {
    const [sections, items, groups] = await Promise.all([
      db.select().from(menuSections).where(eq(menuSections.menuVersionId, versionId)).orderBy(asc(menuSections.sortOrder)),
      db.select().from(menuItems).where(eq(menuItems.menuVersionId, versionId)).orderBy(asc(menuItems.sortOrder)),
      db.select().from(menuItemModifierGroups).where(eq(menuItemModifierGroups.menuVersionId, versionId)).orderBy(asc(menuItemModifierGroups.sortOrder)),
    ]);
    return sections.map((s) => ({
      id: s.id,
      name: s.name,
      items: items
        .filter((i) => i.sectionId === s.id)
        .map((i) => ({
          id: i.id,
          variantId: i.variantId,
          displayName: i.displayName,
          stationCode: i.stationCode,
          modifierGroupIds: groups.filter((g) => g.menuItemId === i.id).map((g) => g.modifierGroupId),
        })),
    }));
  }

  private async writeContent(
    db: Database,
    tenantId: string,
    versionId: string,
    sections: { name: string; items: { variantId: string; displayName?: string | null; stationCode?: string | null; modifierGroupIds: string[] }[] }[],
  ) {
    for (const [si, s] of sections.entries()) {
      const [section] = await db.insert(menuSections).values({ tenantId, menuVersionId: versionId, name: s.name, sortOrder: si }).returning({ id: menuSections.id });
      if (!s.items.length) continue;
      const rows = await db.insert(menuItems)
        .values(s.items.map((it, ii) => ({
          tenantId, menuVersionId: versionId, sectionId: section!.id, variantId: it.variantId,
          displayName: it.displayName ?? null, stationCode: it.stationCode ?? null, sortOrder: ii,
        })))
        .returning({ id: menuItems.id, variantId: menuItems.variantId });
      const links = s.items.flatMap((it) => {
        const itemId = rows.find((r) => r.variantId === it.variantId)!.id;
        return it.modifierGroupIds.map((gid, gi) => ({ tenantId, menuVersionId: versionId, menuItemId: itemId, modifierGroupId: gid, sortOrder: gi }));
      });
      if (links.length) await db.insert(menuItemModifierGroups).values(links);
    }
  }
}
