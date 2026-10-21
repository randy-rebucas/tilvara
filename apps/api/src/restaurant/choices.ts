import {
  and,
  eq,
  inArray,
  menuItemModifierGroups,
  menuItems,
  menuVersions,
  modifierGroups,
  modifierOptions,
  products,
  productVariants,
  type Database,
  inSequence,
} from '@1pos/database';
import { AppError } from '../infrastructure/http-error.filter.js';
import { HttpStatus } from '@nestjs/common';
import { unprocessable } from '../tax/tax.service.js';

/** A menu item as ordering sees it: from what a branch serves now, or from a menu version as it was. */
export interface MenuItemChoices {
  variantId: string;
  name: string;
  stationCode: string | null;
  /** False when it cannot be sold here now (no price, archived, sold out); offline versions say true. */
  available: boolean;
  soldOut?: boolean;
  modifierGroups: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    options: { id: string; name: string; variantId: string | null; available: boolean }[];
  }[];
}

export type Chosen = { group: MenuItemChoices['modifierGroups'][number]; option: MenuItemChoices['modifierGroups'][number]['options'][number] };

/**
 * The choices for one item, checked against its groups (ADR-0014 §3): each option belongs to one of
 * the item's groups, once, within each group's min/max, and available. `lenient` (an offline sale,
 * already paid and handed over): only membership is checked, since availability and group limits may
 * have changed since the till's snapshot.
 */
export function chooseModifiers(item: MenuItemChoices, optionIds: string[], path: (string | number)[], lenient = false): Chosen[] {
  if (new Set(optionIds).size !== optionIds.length) throw unprocessable('DUPLICATE_MODIFIER', 'Each choice once per item', { path });
  const chosen = optionIds.map((oid) => {
    for (const g of item.modifierGroups) {
      const o = g.options.find((x) => x.id === oid);
      if (o) return { group: g, option: o };
    }
    throw unprocessable('MODIFIER_NOT_ALLOWED', 'This choice does not belong to this item', { path, modifierOptionId: oid });
  });
  if (lenient) return chosen;
  for (const g of item.modifierGroups) {
    const n = chosen.filter((c) => c.group.id === g.id).length;
    if (n < g.minSelect || n > g.maxSelect) {
      throw unprocessable('MODIFIER_COUNT', g.minSelect === g.maxSelect ? `Choose ${g.minSelect} for ${g.name}` : `Choose ${g.minSelect} to ${g.maxSelect} for ${g.name}`, {
        path, modifierGroupId: g.id, minSelect: g.minSelect, maxSelect: g.maxSelect,
      });
    }
  }
  const gone = chosen.find((c) => !c.option.available);
  if (gone) throw unprocessable('NOT_AVAILABLE', `${gone.option.name} is not available`, { path, modifierOptionId: gone.option.id });
  return chosen;
}

/** The item itself may be sold now (on the menu, priced here, not sold out). */
export function assertItemAvailable(item: MenuItemChoices, path: (string | number)[]) {
  if (!item.available) {
    throw unprocessable(item.soldOut ? 'SOLD_OUT' : 'NOT_AVAILABLE', item.soldOut ? `${item.name} is sold out` : `${item.name} cannot be sold here (no price)`, { path });
  }
}

/**
 * A menu version's items with the groups and options attached to them, as the version was published
 * (an offline counter sale names the version of its till's snapshot). Archived options still count:
 * the till may have sold them before they were archived.
 */
export async function versionMenuItems(db: Database, menuVersionId: string): Promise<MenuItemChoices[]> {
  const [version] = await db.select({ id: menuVersions.id, status: menuVersions.status }).from(menuVersions).where(eq(menuVersions.id, menuVersionId));
  if (!version || version.status === 'DRAFT') throw new AppError('NOT_FOUND', 'Menu version not found', HttpStatus.NOT_FOUND, { menuVersionId });
  const [items, links] = await inSequence(
    () => db.select().from(menuItems).where(eq(menuItems.menuVersionId, menuVersionId)),
    () => db.select().from(menuItemModifierGroups).where(eq(menuItemModifierGroups.menuVersionId, menuVersionId)),
  );
  const groupIds = [...new Set(links.map((l) => l.modifierGroupId))];
  const [groups, options, variants] = await inSequence(
    () => (groupIds.length ? db.select().from(modifierGroups).where(inArray(modifierGroups.id, groupIds)) : Promise.resolve([])),
    () => (groupIds.length ? db.select().from(modifierOptions).where(inArray(modifierOptions.modifierGroupId, groupIds)) : Promise.resolve([])),
    () => (items.length
      ? db.select({ id: productVariants.id, name: productVariants.name, productName: products.name })
          .from(productVariants).innerJoin(products, and(eq(products.tenantId, productVariants.tenantId), eq(products.id, productVariants.productId)))
          .where(inArray(productVariants.id, items.map((i) => i.variantId)))
      : Promise.resolve([])),
  );
  return items.map((it) => {
    const v = variants.find((x) => x.id === it.variantId);
    return {
      variantId: it.variantId,
      name: it.displayName ?? v?.name ?? v?.productName ?? 'Item',
      stationCode: it.stationCode,
      available: true,
      modifierGroups: links
        .filter((l) => l.menuItemId === it.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .flatMap((l) => {
          const g = groups.find((x) => x.id === l.modifierGroupId);
          if (!g) return [];
          return [{
            id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect,
            options: options.filter((o) => o.modifierGroupId === g.id).map((o) => ({ id: o.id, name: o.name, variantId: o.variantId, available: true })),
          }];
        }),
    };
  });
}
