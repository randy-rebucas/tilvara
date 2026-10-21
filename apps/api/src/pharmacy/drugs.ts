import { HttpStatus } from '@nestjs/common';
import { sql, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import { AppError } from '../infrastructure/http-error.filter.js';
import type { SnapshotDrug } from '@1pos/sync-protocol';
import { reservedAt } from '../inventory/reservations.service.js';

/** A medicine's details on a sale line (ADR-0025 §2). */
export interface DrugInfo {
  variantId: string;
  drugClass: 'OTC' | 'RX' | 'ANTIBIOTIC' | 'DANGEROUS';
  genericName: string;
  strength: string | null;
  dosageForm: string;
  genericKey: string;
  /** "Amoxicillin 500 mg capsule": printed under the brand, kept on the sale line. */
  label: string;
}

/** The same key the database generates (`products.generic_key`, `prescription_items.generic_key`). */
export function genericKey(genericName: string, strength: string | null | undefined, dosageForm: string): string {
  return `${genericName.trim().replace(/\s+/g, ' ').toLowerCase()}|${(strength ?? '').replace(/\s+/g, '').toLowerCase()}|${dosageForm}`;
}

export function drugLabel(d: { genericName: string; strength: string | null; dosageForm: string }): string {
  return [d.genericName.trim(), d.strength?.trim(), d.dosageForm.toLowerCase()].filter(Boolean).join(' ');
}

const CLASS_RANK: Record<DrugInfo['drugClass'], number> = { OTC: 0, RX: 1, ANTIBIOTIC: 2, DANGEROUS: 3 };

/**
 * The medicines among these items (archived ones too: a recorded sale may name one). A pack never sells
 * a medicine without what its pieces need: an item takes the strictest drug class found on itself and
 * down its active pack links (box → strip → piece; OTC < RX < ANTIBIOTIC < DANGEROUS), so a box with no
 * drug details, or a weaker class, of a prescription medicine still needs the prescription. Its generic
 * name, strength and form are its own when it has them, else those of the nearest piece that has them.
 * (Pack links between different medicines are refused since the audit of 2026-10-21; this covers older ones.)
 */
export async function drugsOf(db: Database, variantIds: readonly string[]): Promise<Map<string, DrugInfo>> {
  const ids = [...new Set(variantIds)];
  if (!ids.length) return new Map();
  const { rows } = await db.execute<{ start_id: string; depth: number; drug_class: DrugInfo['drugClass']; generic_name: string; strength: string | null; dosage_form: string | null; generic_key: string }>(sql`
    WITH RECURSIVE chain(start_id, variant_id, depth) AS (
      SELECT x, x, 0 FROM unnest(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]) AS x
      UNION ALL
      SELECT c.start_id, pc.piece_variant_id, c.depth + 1
        FROM chain c JOIN pack_conversions pc ON pc.pack_variant_id = c.variant_id AND pc.archived_at IS NULL
       WHERE c.depth < 4)
    SELECT c.start_id, c.depth, p.drug_class, p.generic_name, p.strength, p.dosage_form, p.generic_key
      FROM chain c
      JOIN product_variants v ON v.id = c.variant_id
      JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
     WHERE p.drug_class IS NOT NULL AND p.generic_name IS NOT NULL
     ORDER BY c.start_id, c.depth`);
  const out = new Map<string, DrugInfo>();
  for (const r of rows) {
    const known = out.get(r.start_id);
    if (!known) {
      // The shallowest row: the item's own details when it has them, else the nearest piece's.
      const dosageForm = r.dosage_form ?? 'OTHER';
      out.set(r.start_id, {
        variantId: r.start_id, drugClass: r.drug_class, genericName: r.generic_name, strength: r.strength, dosageForm,
        genericKey: r.generic_key, label: drugLabel({ genericName: r.generic_name, strength: r.strength, dosageForm }),
      });
    } else if (CLASS_RANK[r.drug_class] > CLASS_RANK[known.drugClass]) {
      known.drugClass = r.drug_class;
    }
  }
  return out;
}

/**
 * Pieces in one unit of each item (ADR-0025 §6): a strip of 10 tablets is 10, a box of 10 strips 100,
 * following the active pack links down to the piece; 1 for an item that is not a pack. A piece has one
 * active pack (`pack_conversions_one_pack_per_piece`), but a pack may feed more than one piece item (a box
 * linked to its strips and to loose tablets): then the deepest chain wins, and among chains as deep the
 * one counting the most pieces (the smallest unit, so a prescription is never under-counted). Deterministic.
 */
export async function piecesPerUnit(db: Database, variantIds: readonly string[]): Promise<Map<string, Dec>> {
  const ids = [...new Set(variantIds)];
  if (!ids.length) return new Map();
  const { rows } = await db.execute<{ variant_id: string; pieces: string }>(sql`
    WITH RECURSIVE chain(start_id, variant_id, pieces, depth) AS (
      SELECT v, v, 1::numeric, 0 FROM unnest(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]) AS v
      UNION ALL
      SELECT c.start_id, pc.piece_variant_id, c.pieces * pc.pieces_per_pack, c.depth + 1
        FROM chain c JOIN pack_conversions pc ON pc.pack_variant_id = c.variant_id AND pc.archived_at IS NULL
       WHERE c.depth < 4)
    SELECT DISTINCT ON (start_id) start_id AS variant_id, pieces::text FROM chain ORDER BY start_id, depth DESC, pieces DESC`);
  return new Map(rows.map((r) => [r.variant_id, toDec(r.pieces)]));
}

// ------------------------------------------------------------------ expired stock (ADR-0025 §4)

/** The branch's rule: its setting, else BLOCK where prescription medicines are sold (PHARMACY, HYBRID; audit 2026-10-21 A2) and ALLOW for anyone else (as the lot trigger decides). */
export async function expiredStockRule(db: Database, branchId: string): Promise<'ALLOW' | 'BLOCK'> {
  const { rows: [r] } = await db.execute<{ rule: 'ALLOW' | 'BLOCK' }>(sql`
    SELECT coalesce(i.expired_stock, CASE WHEN t.business_type IN ('PHARMACY', 'HYBRID') THEN 'BLOCK' ELSE 'ALLOW' END) AS rule
      FROM branches b JOIN tenants t ON t.id = b.tenant_id
      LEFT JOIN inventory_settings i ON i.tenant_id = b.tenant_id AND i.branch_id = b.id
     WHERE b.id = ${branchId}`);
  return r?.rule ?? 'ALLOW';
}

/**
 * What of each item at a branch sits in expired or held lots (not for sale where the rule is BLOCK). A hold
 * covers the item's whole pack family, as `app_lot_held()` does (migration 0107): every item linked to it
 * through pack links either way, archived links included (lot codes copied down while a link was active
 * stay on the pieces). Read here under RLS rather than through the definer function.
 */
export async function unsellableAt(db: Database, branchId: string, variantIds: readonly string[]): Promise<Map<string, Dec>> {
  if (!variantIds.length) return new Map();
  const { rows } = await db.execute<{ variant_id: string; quantity: string }>(sql`
    WITH RECURSIVE family(start_id, v) AS (
      SELECT x, x FROM unnest(ARRAY[${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]) AS x
      UNION
      SELECT f.start_id, CASE WHEN pc.pack_variant_id = f.v THEN pc.piece_variant_id ELSE pc.pack_variant_id END
        FROM family f JOIN pack_conversions pc ON pc.pack_variant_id = f.v OR pc.piece_variant_id = f.v)
    SELECT l.variant_id, sum(l.quantity)::text AS quantity
      FROM stock_lots l JOIN branches b ON b.id = l.branch_id
     WHERE l.branch_id = ${branchId} AND l.quantity > 0
       AND l.variant_id IN (${sql.join(variantIds.map((id) => sql`${id}::uuid`), sql`, `)})
       AND (l.expires_on < (now() AT TIME ZONE b.timezone)::date
            OR (l.lot_code IS NOT NULL AND EXISTS (
                  SELECT 1 FROM lot_holds h JOIN family f ON f.start_id = l.variant_id AND f.v = h.variant_id
                   WHERE h.released_at IS NULL AND upper(btrim(h.lot_code)) = upper(btrim(l.lot_code))
                     AND (h.branch_id IS NULL OR h.branch_id = l.branch_id))))
     GROUP BY 1`);
  return new Map(rows.map((r) => [r.variant_id, toDec(r.quantity)]));
}

/**
 * BLOCK (ADR-0025 §4): refuse an online sale that could only be filled from expired or held lots. Run
 * after the sale's own pack openings, before the negative-stock rule, with the balances locked in variant
 * order (as the movements will lock them a moment later). Whatever is short of stock altogether is the
 * negative-stock rule's to decide; this refuses only what would take dated stock that may not be sold.
 */
export async function assertNotExpired(db: Database, branchId: string, lines: readonly { variantId: string; quantity: string; name: string }[]): Promise<void> {
  if (!lines.length || (await expiredStockRule(db, branchId)) !== 'BLOCK') return;
  const need = new Map<string, { quantity: Dec; name: string }>();
  for (const l of lines) need.set(l.variantId, { quantity: (need.get(l.variantId)?.quantity ?? new Dec(0)).plus(l.quantity), name: l.name });
  const ids = [...need.keys()].sort();
  const unsellable = await unsellableAt(db, branchId, ids);
  if (![...unsellable.values()].some((q) => q.gt(0))) return;
  const { rows } = await db.execute<{ variant_id: string; quantity: string }>(
    sql`SELECT variant_id, quantity::text FROM app_lock_stock_balances(${branchId}, ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[])`,
  );
  const reserved = await reservedAt(db, branchId, ids);
  const short = ids.flatMap((variantId) => {
    const blocked = unsellable.get(variantId) ?? new Dec(0);
    if (blocked.lte(0)) return [];
    const onHand = toDec(rows.find((r) => r.variant_id === variantId)?.quantity ?? '0');
    const sellable = Dec.max(onHand.minus(reserved.get(variantId) ?? 0).minus(blocked), 0);
    const { quantity, name } = need.get(variantId)!;
    return quantity.gt(sellable) ? [{ variantId, name, sellable: sellable.toString(), expiredOrHeld: blocked.toString(), requested: quantity.toString() }] : [];
  });
  if (short.length) {
    throw new AppError(
      'EXPIRED_STOCK',
      `Only expired or held stock is left: ${short.map((s) => `${s.name} (${s.sellable} sellable)`).join(', ')}. Write it off or return it to the supplier.`,
      HttpStatus.CONFLICT,
      { lines: short },
    );
  }
}

/** The lots a sale's movements drew while expired or held (an offline sale, a recipe's consumption). */
export async function expiredDraws(db: Database, saleId: string) {
  const { rows } = await db.execute<{ variant_id: string; lot_code: string | null; expires_on: string; quantity: string }>(sql`
    SELECT m.variant_id, s.lot_code, s.expires_on::text, (-sum(lm.quantity))::text AS quantity
      FROM stock_movements m
      JOIN stock_lot_movements lm ON lm.tenant_id = m.tenant_id AND lm.movement_id = m.id AND lm.expired
      JOIN stock_lots s ON s.tenant_id = lm.tenant_id AND s.id = lm.lot_id
     WHERE m.sale_id = ${saleId} AND m.type IN ('SALE', 'CONSUMPTION')
     GROUP BY 1, 2, 3`);
  return rows.map((r) => ({ variantId: r.variant_id, lotCode: r.lot_code, expiresOn: r.expires_on, quantity: toDec(r.quantity).toString() }));
}

/**
 * These items' medicine details as the till sees them (lookup, snapshot): by the `drugsOf` rule, so a box
 * of a prescription medicine needs the prescription at the till too, with the pieces in one unit.
 */
export async function tillDrugs(db: Database, variantIds: readonly string[]): Promise<Map<string, SnapshotDrug>> {
  const drugs = await drugsOf(db, variantIds);
  if (!drugs.size) return new Map();
  const pieces = await piecesPerUnit(db, [...drugs.keys()]);
  return new Map([...drugs].map(([id, d]) => [id, {
    drugClass: d.drugClass, genericName: d.genericName, strength: d.strength, dosageForm: d.dosageForm, genericKey: d.genericKey,
    piecesPerUnit: (pieces.get(id) ?? new Dec(1)).toString(),
  }]));
}

/** On hand less reserved and less expired or held lots: what of an item may be sold at a branch now. */
export async function sellableAt(db: Database, branchId: string, variantId: string): Promise<{ onHand: string; expiredOrHeld: string; sellable: string }> {
  const { rows: [b] } = await db.execute<{ quantity: string }>(sql`SELECT quantity::text FROM stock_balances WHERE branch_id = ${branchId} AND variant_id = ${variantId}`);
  const onHand = toDec(b?.quantity ?? '0');
  const blocked = (await unsellableAt(db, branchId, [variantId])).get(variantId) ?? new Dec(0);
  const reserved = (await reservedAt(db, branchId, [variantId])).get(variantId) ?? new Dec(0);
  return { onHand: onHand.toString(), expiredOrHeld: blocked.toString(), sellable: Dec.max(onHand.minus(reserved).minus(blocked), 0).toString() };
}
