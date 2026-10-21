import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { branches, eq, packConversions, packOpenings, sql, stockMovements, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import { packOpeningPosting } from '@1pos/accounting';
import type { CreatePackConversionInput, PackConversionQuery, PackOpeningInput, UpdatePackConversionInput } from '@1pos/validation';
import { post } from '../accounting/ledger.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { negativeStockPolicy } from '../sales/stock-policy.js';
import { unprocessable } from '../tax/tax.service.js';
import { reservedAt } from './reservations.service.js';

type LinkRow = {
  id: string;
  pack_variant_id: string;
  pack_sku: string;
  pack_name: string;
  piece_variant_id: string;
  piece_sku: string;
  piece_name: string;
  pieces_per_pack: string;
  auto_open: boolean;
  archived_at: string | null;
  created_at: string;
};

const LINKS = sql`
  SELECT c.id, c.pack_variant_id, pv.sku AS pack_sku, concat_ws(' ', pp.name, pv.name) AS pack_name,
         c.piece_variant_id, qv.sku AS piece_sku, concat_ws(' ', qp.name, qv.name) AS piece_name,
         c.pieces_per_pack::text, c.auto_open, c.archived_at, c.created_at
    FROM pack_conversions c
    JOIN product_variants pv ON pv.tenant_id = c.tenant_id AND pv.id = c.pack_variant_id
    JOIN products pp ON pp.tenant_id = pv.tenant_id AND pp.id = pv.product_id
    JOIN product_variants qv ON qv.tenant_id = c.tenant_id AND qv.id = c.piece_variant_id
    JOIN products qp ON qp.tenant_id = qv.tenant_id AND qp.id = qv.product_id`;

const view = (r: LinkRow) => ({
  id: r.id,
  pack: { variantId: r.pack_variant_id, sku: r.pack_sku, name: r.pack_name },
  piece: { variantId: r.piece_variant_id, sku: r.piece_sku, name: r.piece_name },
  piecesPerPack: toDec(r.pieces_per_pack).toString(),
  autoOpen: r.auto_open,
  archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(),
});

interface OpeningContext {
  tenantId: string;
  branchId: string;
  legalEntityId: string;
  userId: string;
  saleId?: string;
  saleNumber?: string;
  reason?: string;
  /** An offline sale books its entries on the day it happened. */
  entryDate?: string;
}

/**
 * One opening: the document, the packs out, then the pieces in (the trigger prices them at what the
 * packs took out), and its entry, which posts only a revaluation of pieces sold short (ADR-0020 §2).
 * The caller holds the balance locks or takes them here in variant order.
 */
async function recordOpening(db: Database, ctx: OpeningContext, link: { id: string; packVariantId: string; pieceVariantId: string; piecesPerPack: Dec; packSku: string }, packs: Dec) {
  const pieces = packs.times(link.piecesPerPack);
  const [doc] = await db
    .insert(packOpenings)
    .values({ tenantId: ctx.tenantId, branchId: ctx.branchId, conversionId: link.id, packs: packs.toString(), pieces: pieces.toString(), saleId: ctx.saleId ?? null, reason: ctx.reason ?? null, createdBy: ctx.userId })
    .returning();
  const ids = [link.packVariantId, link.pieceVariantId].sort();
  await db.execute(sql`SELECT 1 FROM app_lock_stock_balances(${ctx.branchId}, ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[])`);
  const base = { tenantId: ctx.tenantId, branchId: ctx.branchId, packOpeningId: doc!.id, createdBy: ctx.userId };
  const [out] = await db.insert(stockMovements).values({ ...base, variantId: link.packVariantId, quantity: packs.negated().toString(), type: 'UNPACK_OUT' }).returning({ value: stockMovements.value });
  const [inn] = await db.insert(stockMovements).values({ ...base, variantId: link.pieceVariantId, quantity: pieces.toString(), type: 'UNPACK_IN' }).returning({ value: stockMovements.value });
  await post(db, {
    tenantId: ctx.tenantId,
    legalEntityId: ctx.legalEntityId,
    branchId: ctx.branchId,
    sourceType: 'PACK_OPENING',
    sourceId: doc!.id,
    memo: ctx.saleNumber ? `Opened ${packs.toString()} × ${link.packSku} for sale #${ctx.saleNumber}` : `Opened ${packs.toString()} × ${link.packSku}: ${ctx.reason ?? ''}`,
    ...(ctx.entryDate && { entryDate: ctx.entryDate }),
    lines: packOpeningPosting({ packsValue: toDec(out!.value).negated(), piecesValue: toDec(inn!.value) }, ctx.branchId),
    createdBy: ctx.userId,
  });
  return { id: doc!.id, packs: packs.toString(), pieces: pieces.toString(), packsValue: toDec(out!.value).negated().toFixed(2), piecesValue: toDec(inn!.value).toFixed(2) };
}

/**
 * A sale short of pieces opens packs by itself (ADR-0020 §2), in the sale's transaction, before its
 * own movements and the BLOCK check. `outbound`: what the sale and its recipes take out, per item.
 * Every balance involved is locked first, in one call in variant order (as the sale's movements will
 * lock them a moment later), so two tills cannot open the same last pack for themselves.
 * Returns the openings made (none in the usual case: one indexed query).
 */
export async function openPacksForSale(db: Database, ctx: OpeningContext, outbound: readonly { variantId: string; quantity: string }[]) {
  const need = new Map<string, Dec>();
  for (const o of outbound) {
    const q = toDec(o.quantity);
    if (q.gt(0)) need.set(o.variantId, (need.get(o.variantId) ?? new Dec(0)).plus(q));
  }
  if (need.size === 0) return [];
  const { rows: links } = await db.execute<{ id: string; pack_variant_id: string; piece_variant_id: string; pieces_per_pack: string; pack_sku: string }>(sql`
    SELECT c.id, c.pack_variant_id, c.piece_variant_id, c.pieces_per_pack::text, pv.sku AS pack_sku
      FROM pack_conversions c
      JOIN product_variants pv ON pv.tenant_id = c.tenant_id AND pv.id = c.pack_variant_id
      JOIN products pp ON pp.tenant_id = pv.tenant_id AND pp.id = pv.product_id
     WHERE c.archived_at IS NULL AND c.auto_open AND pv.archived_at IS NULL AND pp.track_inventory
       AND c.piece_variant_id IN (${sql.join([...need.keys()].map((id) => sql`${id}::uuid`), sql`, `)})
     ORDER BY c.piece_variant_id`);
  if (links.length === 0) return [];

  const ids = [...new Set([...need.keys(), ...links.map((l) => l.pack_variant_id)])].sort();
  const { rows: locked } = await db.execute<{ variant_id: string; quantity: string }>(
    sql`SELECT variant_id, quantity::text FROM app_lock_stock_balances(${ctx.branchId}, ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[])`,
  );
  const onHand = new Map(locked.map((r) => [r.variant_id, toDec(r.quantity)]));
  const reserved = await reservedAt(db, ctx.branchId, ids);
  const free = (id: string) => (onHand.get(id) ?? new Dec(0)).minus(reserved.get(id) ?? 0);

  const made = [];
  for (const l of links) {
    const short = need.get(l.piece_variant_id)!.minus(Dec.max(free(l.piece_variant_id), 0));
    if (short.lte(0)) continue;
    // Packs this sale sells as packs are not there to open.
    const packsFree = free(l.pack_variant_id).minus(need.get(l.pack_variant_id) ?? 0).floor();
    if (packsFree.lt(1)) continue;
    const per = toDec(l.pieces_per_pack);
    const packs = Dec.min(short.div(per).ceil(), packsFree);
    made.push(await recordOpening(db, ctx, { id: l.id, packVariantId: l.pack_variant_id, pieceVariantId: l.piece_variant_id, piecesPerPack: per, packSku: l.pack_sku }, packs));
    onHand.set(l.pack_variant_id, (onHand.get(l.pack_variant_id) ?? new Dec(0)).minus(packs));
    onHand.set(l.piece_variant_id, (onHand.get(l.piece_variant_id) ?? new Dec(0)).plus(packs.times(per)));
  }
  return made;
}

/**
 * Packs and pieces (tingi, ADR-0020 §2): the links between a pack and the piece sold from it
 * (`catalog.manage`), and opening packs by hand at a branch (`inventory.adjust`).
 */
@Injectable()
export class PacksService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    pack_conversions_one_pack_per_piece: ['PIECE_HAS_PACK', 'This item already comes from another pack; archive that link first'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  listConversions(auth: AuthContext, q: PackConversionQuery) {
    this.assertHolds(auth, 'catalog.read');
    return this.read(auth, async (db) => {
      const { rows } = await db.execute<LinkRow>(sql`${LINKS}
        WHERE c.archived_at IS NULL ${q.variantId ? sql`AND (c.pack_variant_id = ${q.variantId} OR c.piece_variant_id = ${q.variantId})` : sql``}
        ORDER BY pp.name, pv.sku`);
      return { data: rows.map(view) };
    });
  }

  createConversion(auth: AuthContext, input: CreatePackConversionInput) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      // One link change at a time per business, so two cannot close a loop between them.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(app_current_tenant_id()::text || ':pack-links'))`);
      const { rows: items } = await db.execute<{ id: string; archived_at: string | null; track_inventory: boolean; product_archived_at: string | null; allows_fraction: boolean }>(sql`
        SELECT v.id, v.archived_at, p.track_inventory, p.archived_at AS product_archived_at, u.allows_fraction
          FROM product_variants v
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          JOIN units_of_measure u ON u.tenant_id = p.tenant_id AND u.id = p.uom_id
         WHERE v.id IN (${input.packVariantId}::uuid, ${input.pieceVariantId}::uuid)`);
      const pack = items.find((i) => i.id === input.packVariantId);
      const piece = items.find((i) => i.id === input.pieceVariantId);
      if (!pack || !piece) throw notFound('Item');
      if (pack.archived_at || pack.product_archived_at || piece.archived_at || piece.product_archived_at) throw archived('Item');
      if (!pack.track_inventory || !piece.track_inventory) throw unprocessable('NOT_TRACKED', 'Both the pack and the piece must count their stock');
      if (!piece.allows_fraction && !toDec(input.piecesPerPack).isInteger()) {
        throw unprocessable('FRACTIONAL_PIECES', 'This piece is counted in whole units, so a pack holds a whole number of them', { path: ['piecesPerPack'] });
      }
      // A loop (the piece is, through its packs, the pack's own source) would open packs in a circle.
      let current = input.packVariantId;
      for (let depth = 0; depth < 20; depth++) {
        const [up] = (await db.execute<{ pack_variant_id: string }>(
          sql`SELECT pack_variant_id FROM pack_conversions WHERE piece_variant_id = ${current} AND archived_at IS NULL`,
        )).rows;
        if (!up) break;
        if (up.pack_variant_id === input.pieceVariantId) throw unprocessable('PACK_LOOP', 'This piece already holds the pack, through its own packs');
        current = up.pack_variant_id;
      }
      const [row] = await db
        .insert(packConversions)
        .values({ tenantId: tenantOf(auth).tenantId, packVariantId: input.packVariantId, pieceVariantId: input.pieceVariantId, piecesPerPack: input.piecesPerPack, autoOpen: input.autoOpen, createdBy: auth.userId })
        .returning();
      await this.audit(db, auth, 'pack_link.created', 'pack_conversion', row!.id, { packVariantId: input.packVariantId, pieceVariantId: input.pieceVariantId, piecesPerPack: input.piecesPerPack });
      return this.link(db, row!.id);
    });
  }

  updateConversion(auth: AuthContext, id: string, input: UpdatePackConversionInput) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const before = await this.link(db, id);
      if (before.archivedAt) throw archived('Pack link');
      if (before.autoOpen !== input.autoOpen) {
        await db.update(packConversions).set({ autoOpen: input.autoOpen }).where(eq(packConversions.id, id));
        await this.audit(db, auth, 'pack_link.updated', 'pack_conversion', id, { autoOpen: input.autoOpen });
      }
      return this.link(db, id);
    });
  }

  archiveConversion(auth: AuthContext, id: string) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const before = await this.link(db, id);
      if (before.archivedAt) throw archived('Pack link');
      await db.update(packConversions).set({ archivedAt: new Date() }).where(eq(packConversions.id, id));
      await this.audit(db, auth, 'pack_link.archived', 'pack_conversion', id);
      return this.link(db, id);
    });
  }

  /** Open whole packs by hand. Under BLOCK, never more packs than are available. */
  open(auth: AuthContext, input: PackOpeningInput) {
    return this.mutate(auth, async (db) => {
      const branch = await this.branch(db, input.branchId);
      this.assertCan(auth, 'inventory.adjust', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      if (branch.archivedAt) throw archived('Branch');
      const link = await this.link(db, input.conversionId);
      if (link.archivedAt) throw archived('Pack link');
      const packs = toDec(input.packs);
      if ((await negativeStockPolicy(db, branch.id)) === 'BLOCK') {
        const { rows } = await db.execute<{ quantity: string }>(
          sql`SELECT quantity::text FROM app_lock_stock_balances(${branch.id}, ARRAY[${link.pack.variantId}]::uuid[])`,
        );
        const available = toDec(rows[0]?.quantity ?? '0').minus((await reservedAt(db, branch.id, [link.pack.variantId])).get(link.pack.variantId) ?? 0);
        if (packs.gt(available)) {
          throw new AppError('INSUFFICIENT_STOCK', `Not enough stock: ${link.pack.name} (${available.toString()} available)`, HttpStatus.CONFLICT, {
            lines: [{ variantId: link.pack.variantId, name: link.pack.name, available: available.toString(), requested: packs.toString() }],
          });
        }
      }
      const made = await recordOpening(
        db,
        { tenantId: tenantOf(auth).tenantId, branchId: branch.id, legalEntityId: branch.legalEntityId, userId: auth.userId, reason: input.reason },
        { id: link.id, packVariantId: link.pack.variantId, pieceVariantId: link.piece.variantId, piecesPerPack: toDec(link.piecesPerPack), packSku: link.pack.sku },
        packs,
      );
      await this.audit(db, auth, 'stock.pack_opened', 'pack_opening', made.id, { branchId: branch.id, conversionId: link.id, packs: made.packs, pieces: made.pieces, reason: input.reason });
      return this.opening(db, made.id);
    });
  }

  listOpenings(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const branch = await this.branch(db, branchId);
      this.assertCan(auth, 'inventory.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      const rows = await db.select({ id: packOpenings.id }).from(packOpenings).where(eq(packOpenings.branchId, branch.id)).orderBy(sql`${packOpenings.createdAt} DESC, ${packOpenings.id} DESC`).limit(200);
      const data = [];
      for (const r of rows) data.push(await this.opening(db, r.id));
      return { data };
    });
  }

  getOpening(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const doc = await this.opening(db, id);
      const branch = await this.branch(db, doc.branchId);
      this.assertCan(auth, 'inventory.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      return doc;
    });
  }

  private async opening(db: Database, id: string) {
    const { rows: [o] } = await db.execute<{ id: string; branch_id: string; conversion_id: string; packs: string; pieces: string; sale_id: string | null; sale_number: string | null; reason: string | null; created_by: string; created_at: string; packs_value: string | null; pieces_value: string | null }>(sql`
      SELECT o.id, o.branch_id, o.conversion_id, o.packs::text, o.pieces::text, o.sale_id, s.sale_number::text, o.reason, o.created_by, o.created_at,
             (SELECT (-value)::text FROM stock_movements WHERE pack_opening_id = o.id AND type = 'UNPACK_OUT') AS packs_value,
             (SELECT value::text FROM stock_movements WHERE pack_opening_id = o.id AND type = 'UNPACK_IN') AS pieces_value
        FROM pack_openings o LEFT JOIN sales s ON s.tenant_id = o.tenant_id AND s.id = o.sale_id
       WHERE o.id = ${id}`);
    if (!o) throw notFound('Pack opening');
    const link = await this.link(db, o.conversion_id);
    return {
      id: o.id,
      branchId: o.branch_id,
      conversionId: o.conversion_id,
      pack: link.pack,
      piece: link.piece,
      packs: toDec(o.packs).toString(),
      pieces: toDec(o.pieces).toString(),
      saleId: o.sale_id,
      saleNumber: o.sale_number,
      reason: o.reason,
      packsValue: toDec(o.packs_value ?? '0').toFixed(2),
      piecesValue: toDec(o.pieces_value ?? '0').toFixed(2),
      createdBy: o.created_by,
      createdAt: new Date(o.created_at).toISOString(),
    };
  }

  private async link(db: Database, id: string) {
    const { rows: [r] } = await db.execute<LinkRow>(sql`${LINKS} WHERE c.id = ${id}`);
    if (!r) throw notFound('Pack link');
    return view(r);
  }

  private async branch(db: Database, id: string) {
    const [row] = await db.select().from(branches).where(eq(branches.id, id));
    if (!row) throw notFound('Branch');
    return row;
  }
}
