import { HttpStatus } from '@nestjs/common';
import {
  customerPackageEntries,
  customerPackageItems,
  customerPackages,
  eq,
  inArray,
  inSequence,
  servicePackageItems,
  sql,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import { AppError } from '../infrastructure/http-error.filter.js';
import { unprocessable } from '../tax/tax.service.js';
import type { EffectivePrice } from '../catalog/pricing.service.js';

/** What `record()` knows of a line that matters to packages (ADR-0022 §6). */
export interface PackageLineInfo {
  productType: string;
  variantId: string;
  quantity: string;
  /** Ex-VAT sales of the line (Σ sales buckets). */
  exVat: Dec;
  /** A session of this customer package. */
  packageId: string | null;
  hasStatutory: boolean;
  name: string;
}

interface SoldUnit {
  unitNo: number;
  value: Dec;
  items: { serviceVariantId: string; sessions: number; value: Dec }[];
}

export interface PackagePlan {
  /** Package lines sold: their units and how each unit's value splits over its services. */
  sold: { index: number; variantId: string; name: string; validDays: number | null; units: SoldUnit[] }[];
  /** Sessions used, with the value each turns from owed into sales. */
  redeemed: { index: number; packageId: string; itemId: string; sessions: number; value: Dec }[];
  /** Σ package lines ex VAT: credited to Prepaid service packages instead of Sales. */
  deferred: Dec;
  /** Σ sessions' value: from Prepaid service packages into Sales. */
  recognized: Dec;
}

export const EMPTY_PLAN: PackagePlan = { sold: [], redeemed: [], deferred: new Dec(0), recognized: new Dec(0) };

/** A calendar date (YYYY-MM-DD) plus some days. */
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const cents = (d: Dec) => d.toDecimalPlaces(2, Dec.ROUND_DOWN);

/** Split `total` in proportion to `weights`, to the centavo, the largest remainders taking the leftover centavos. */
export function splitByWeight(total: Dec, weights: Dec[]): Dec[] {
  const sum = weights.reduce((a, w) => a.plus(w), new Dec(0));
  if (sum.isZero()) return splitByWeight(total, weights.map(() => new Dec(1)));
  const exact = weights.map((w) => total.times(w).dividedBy(sum));
  const parts = exact.map(cents);
  let left = total.minus(parts.reduce((a, p) => a.plus(p), new Dec(0)));
  const order = exact.map((e, i) => ({ i, r: e.minus(parts[i]!) })).sort((a, b) => b.r.comparedTo(a.r) || a.i - b.i);
  for (const { i } of order) {
    if (left.lt('0.01')) break;
    parts[i] = parts[i]!.plus('0.01');
    left = left.minus('0.01');
  }
  // Sub-centavo dust (a total not in centavos) goes to the first part, so the parts always add up.
  parts[0] = parts[0]!.plus(left);
  return parts;
}

/** Lock one package's entries for this transaction (the entry trigger takes the same lock). */
export const lockPackage = (db: Database, packageId: string) => db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`package:${packageId}`}, 0))`);

/** What is left of a package item: sessions and value (Σ entries). */
async function itemBalances(db: Database, itemIds: string[]) {
  if (!itemIds.length) return new Map<string, { sessions: number; value: Dec }>();
  const { rows } = await db.execute<{ id: string; sessions: number; value: string }>(sql`
    SELECT customer_package_item_id AS id, sum(sessions)::int AS sessions, sum(value)::text AS value
      FROM customer_package_entries WHERE customer_package_item_id IN (${sql.join(itemIds.map((i) => sql`${i}`), sql`, `)}) GROUP BY 1`);
  return new Map(rows.map((r) => [r.id, { sessions: Number(r.sessions), value: toDec(r.value) }]));
}

/**
 * Check a sale's package lines and sessions before they are recorded (ADR-0022 §6):
 * - a package sold needs the customer on the sale, whole units, no SC/PWD and contents; its ex-VAT
 *   value is split over its units, then over its services by list price × sessions;
 * - a session needs the package's customer, the sale's legal entity, an unexpired package holding the
 *   service and enough sessions; each session takes what is left of the value ÷ sessions left.
 * Locks every package used, so two tills cannot spend the same session.
 */
export async function planPackages(
  db: Database,
  ctx: { customerId: string | null; legalEntityId: string; localDate: string; prices: (variantIds: string[]) => Promise<Map<string, EffectivePrice>> },
  lines: PackageLineInfo[],
): Promise<PackagePlan> {
  const plan: PackagePlan = { sold: [], redeemed: [], deferred: new Dec(0), recognized: new Dec(0) };
  const selling = lines.map((l, index) => ({ l, index })).filter(({ l }) => l.productType === 'PACKAGE');
  const using = lines.map((l, index) => ({ l, index })).filter(({ l }) => l.packageId);
  if (!selling.length && !using.length) return plan;
  if (!ctx.customerId) {
    throw unprocessable('PACKAGE_NEEDS_CUSTOMER', 'Put the customer on the sale to sell or use a package', { line: (selling[0] ?? using[0])!.index });
  }

  if (selling.length) {
    const ids = [...new Set(selling.map((s) => s.l.variantId))];
    const [contents, { rows: validity }] = await inSequence(
      () => db.select().from(servicePackageItems).where(inArray(servicePackageItems.packageVariantId, ids)),
      () => db.execute<{ id: string; days: number | null }>(sql`SELECT id, package_valid_days AS days FROM product_variants WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`),
    );
    const prices = await ctx.prices([...new Set(contents.map((c) => c.serviceVariantId))]);
    for (const { l, index } of selling) {
      const q = toDec(l.quantity);
      if (!q.isInteger()) throw unprocessable('QUANTITY_NOT_ALLOWED', 'A package is sold in whole units', { line: index });
      if (l.hasStatutory) throw unprocessable('PACKAGE_NO_STATUTORY', 'A package takes no SC/PWD discount; give it on the service when it is used', { line: index });
      const items = contents.filter((c) => c.packageVariantId === l.variantId);
      if (!items.length) throw unprocessable('PACKAGE_EMPTY', `${l.name} has no services in it yet`, { line: index });
      const n = q.toNumber();
      const unitValues = splitByWeight(l.exVat, Array.from({ length: n }, () => new Dec(1)));
      const weights = items.map((it) => toDec(prices.get(it.serviceVariantId)?.amount ?? '0').times(it.sessions));
      const anyPrice = weights.some((w) => !w.isZero());
      plan.sold.push({
        index,
        variantId: l.variantId,
        name: l.name,
        validDays: validity.find((v) => v.id === l.variantId)?.days ?? null,
        units: unitValues.map((value, u) => {
          const split = splitByWeight(value, anyPrice ? weights : items.map((it) => new Dec(it.sessions)));
          return { unitNo: u + 1, value, items: items.map((it, k) => ({ serviceVariantId: it.serviceVariantId, sessions: it.sessions, value: split[k]! })) };
        }),
      });
      plan.deferred = plan.deferred.plus(l.exVat);
    }
  }

  if (using.length) {
    const packageIds = [...new Set(using.map((u) => u.l.packageId!))];
    // Lock order by id: two sales using the same packages wait for each other instead of deadlocking.
    for (const id of [...packageIds].sort()) await lockPackage(db, id);
    const pkgs = await db.select().from(customerPackages).where(inArray(customerPackages.id, packageIds));
    const items = await db.select().from(customerPackageItems).where(inArray(customerPackageItems.customerPackageId, packageIds));
    const balances = await itemBalances(db, items.map((i) => i.id));
    for (const { l, index } of using) {
      const pkg = pkgs.find((p) => p.id === l.packageId);
      if (!pkg) throw new AppError('NOT_FOUND', 'Package not found', HttpStatus.NOT_FOUND, { line: index });
      if (pkg.customerId !== ctx.customerId) throw unprocessable('PACKAGE_CUSTOMER_MISMATCH', 'This package belongs to another customer', { line: index });
      if (pkg.legalEntityId !== ctx.legalEntityId) throw unprocessable('PACKAGE_OTHER_ENTITY', 'This package was bought from another company of the business; use it there', { line: index });
      if (pkg.expiresOn && pkg.expiresOn < ctx.localDate) throw new AppError('PACKAGE_EXPIRED', `This package expired on ${pkg.expiresOn}`, HttpStatus.CONFLICT, { line: index, expiresOn: pkg.expiresOn });
      const item = items.find((i) => i.customerPackageId === pkg.id && i.serviceVariantId === l.variantId);
      if (!item) throw unprocessable('PACKAGE_DOES_NOT_COVER', `${pkg.name} does not include ${l.name}`, { line: index });
      const q = toDec(l.quantity);
      if (!q.isInteger()) throw unprocessable('QUANTITY_NOT_ALLOWED', 'Sessions are used in whole units', { line: index });
      const sessions = q.toNumber();
      const left = balances.get(item.id) ?? { sessions: 0, value: new Dec(0) };
      if (left.sessions < sessions) {
        throw new AppError('PACKAGE_EXHAUSTED', 'The package does not have that many sessions left', HttpStatus.CONFLICT, { line: index, sessionsLeft: left.sessions });
      }
      // What is left of the value ÷ the sessions left, to the centavo; the last session takes the rest.
      const value = sessions === left.sessions ? left.value : cents(left.value.dividedBy(left.sessions)).times(sessions);
      balances.set(item.id, { sessions: left.sessions - sessions, value: left.value.minus(value) });
      plan.redeemed.push({ index, packageId: pkg.id, itemId: item.id, sessions, value });
      plan.recognized = plan.recognized.plus(value);
    }
  }
  return plan;
}

/** Write the packages a sale sold and the sessions it used, once its lines exist (`lineIds` by line index). */
export async function recordPackages(
  db: Database,
  ctx: { tenantId: string; legalEntityId: string; branchId: string; customerId: string; saleId: string; userId: string; localDate: string },
  plan: PackagePlan,
  lineIds: string[],
) {
  for (const s of plan.sold) {
    for (const unit of s.units) {
      const [pkg] = await db
        .insert(customerPackages)
        .values({
          tenantId: ctx.tenantId, legalEntityId: ctx.legalEntityId, branchId: ctx.branchId, customerId: ctx.customerId, packageVariantId: s.variantId,
          name: s.name, saleId: ctx.saleId, saleLineId: lineIds[s.index]!, unitNo: unit.unitNo, value: unit.value.toString(),
          expiresOn: s.validDays ? addDays(ctx.localDate, s.validDays) : null,
        })
        .returning({ id: customerPackages.id });
      const items = await db
        .insert(customerPackageItems)
        .values(unit.items.map((it) => ({ tenantId: ctx.tenantId, customerPackageId: pkg!.id, serviceVariantId: it.serviceVariantId, sessions: it.sessions, value: it.value.toString() })))
        .returning({ id: customerPackageItems.id, serviceVariantId: customerPackageItems.serviceVariantId });
      await db.insert(customerPackageEntries).values(unit.items.map((it) => ({
        tenantId: ctx.tenantId, customerPackageId: pkg!.id, customerPackageItemId: items.find((x) => x.serviceVariantId === it.serviceVariantId)!.id,
        kind: 'SOLD' as const, sessions: it.sessions, value: it.value.toString(), saleId: ctx.saleId, saleLineId: lineIds[s.index]!, createdBy: ctx.userId,
      })));
    }
  }
  for (const r of plan.redeemed) {
    await db.insert(customerPackageEntries).values({
      tenantId: ctx.tenantId, customerPackageId: r.packageId, customerPackageItemId: r.itemId, kind: 'REDEEMED',
      sessions: -r.sessions, value: r.value.negated().toString(), saleId: ctx.saleId, saleLineId: lineIds[r.index]!, createdBy: ctx.userId,
    });
  }
}

type SoldPackage = typeof customerPackages.$inferSelect;

/**
 * Which packages a return of `n` units of a package line gives back: unused ones (every service still
 * holds all its sessions), the last sold first. PACKAGE_USED when fewer are unused.
 */
async function chooseUnused(db: Database, sold: SoldPackage[], requests: { saleLineId: string; n: number }[]) {
  const items = sold.length ? await db.select().from(customerPackageItems).where(inArray(customerPackageItems.customerPackageId, sold.map((p) => p.id))) : [];
  // A package whose sessions all came back counts as unused.
  const balances = await itemBalances(db, items.map((i) => i.id));
  const notWhole = new Set(items.filter((i) => (balances.get(i.id)?.sessions ?? 0) !== i.sessions).map((i) => i.customerPackageId));
  const out = new Map<string, SoldPackage[]>();
  for (const r of requests) {
    const ofLine = sold.filter((p) => p.saleLineId === r.saleLineId).sort((a, b) => b.unitNo - a.unitNo);
    if (!ofLine.length) continue;
    const unused = ofLine.filter((p) => !notWhole.has(p.id));
    if (unused.length < r.n) {
      throw new AppError('PACKAGE_USED', 'Only packages with no sessions used can be returned', HttpStatus.CONFLICT, { saleLineId: r.saleLineId, unused: unused.length });
    }
    out.set(r.saleLineId, unused.slice(0, r.n));
  }
  return { chosen: out, items };
}

/**
 * The recorded value of the packages a return of a package line would give back (null for another
 * line). The return's share of the line is exactly this, so Sales returns (4010) nets to zero against
 * what leaves Prepaid service packages (audit 2026-10-21: a prorated share could differ by a centavo).
 */
export async function packageReturnValue(db: Database, saleLineId: string, quantity: Dec): Promise<Dec | null> {
  const sold = await db.select().from(customerPackages).where(eq(customerPackages.saleLineId, saleLineId));
  if (!sold.length) return null;
  const { chosen } = await chooseUnused(db, sold, [{ saleLineId, n: quantity.toNumber() }]);
  return (chosen.get(saleLineId) ?? []).reduce((a, p) => a.plus(p.value), new Dec(0));
}

/**
 * A return or void of package lines and sessions (ADR-0022 §6), in the return's transaction:
 * - a package line returns whole unused packages only (PACKAGE_USED otherwise): their sessions and
 *   value leave (REFUNDED), and the liability goes down by exactly their value (`prepaid`);
 * - a session line gives its sessions back (RESTORED, naming the line) with their share of the value
 *   it turned into sales (`restored`: back from Sales into Prepaid service packages).
 * Whole units and sessions only: the return plan refuses a fraction first.
 */
export async function returnPackages(
  db: Database,
  ctx: { tenantId: string; saleReturnId: string; userId: string },
  lines: { saleLineId: string; quantity: Dec; soldQuantity: Dec; customerPackageId: string | null; packageValue: string | null }[],
): Promise<{ prepaid: Dec; restored: Dec }> {
  let prepaid = new Dec(0);
  let restored = new Dec(0);
  const lineIds = lines.map((l) => l.saleLineId);
  if (!lineIds.length) return { prepaid, restored };
  for (const l of lines) {
    if (l.customerPackageId && !l.quantity.isInteger()) throw unprocessable('QUANTITY_NOT_ALLOWED', 'Package sessions are returned in whole sessions', { saleLineId: l.saleLineId });
  }
  const sold = await db.select().from(customerPackages).where(inArray(customerPackages.saleLineId, lineIds));
  for (const id of [...new Set([...sold.map((p) => p.id), ...lines.flatMap((l) => (l.customerPackageId ? [l.customerPackageId] : []))])].sort()) await lockPackage(db, id);

  if (sold.length) {
    for (const l of lines) {
      if (sold.some((p) => p.saleLineId === l.saleLineId) && !l.quantity.isInteger()) throw unprocessable('QUANTITY_NOT_ALLOWED', 'A package is returned in whole units', { saleLineId: l.saleLineId });
    }
    const { chosen, items } = await chooseUnused(db, sold, lines.map((l) => ({ saleLineId: l.saleLineId, n: l.quantity.toNumber() })));
    for (const pkgs of chosen.values()) {
      for (const pkg of pkgs) {
        const its = items.filter((i) => i.customerPackageId === pkg.id);
        await db.insert(customerPackageEntries).values(its.map((i) => ({
          tenantId: ctx.tenantId, customerPackageId: pkg.id, customerPackageItemId: i.id, kind: 'REFUNDED' as const,
          sessions: -i.sessions, value: toDec(i.value).negated().toString(), saleReturnId: ctx.saleReturnId, createdBy: ctx.userId,
        })));
        prepaid = prepaid.plus(pkg.value);
      }
    }
  }

  for (const l of lines.filter((x) => x.customerPackageId)) {
    const { rows: entries } = await db.execute<{ customer_package_item_id: string; redeemed: number; value: string; restored: number; restored_value: string }>(sql`
      SELECT r.customer_package_item_id, -r.sessions AS redeemed, (-r.value)::text AS value,
             coalesce(sum(x.sessions), 0)::int AS restored, coalesce(sum(x.value), 0)::text AS restored_value
        FROM customer_package_entries r
        -- What earlier returns gave back of this line: RESTORED entries name their line (rows written
        -- before they did are matched through their return's lines).
        LEFT JOIN customer_package_entries x ON x.kind = 'RESTORED' AND x.customer_package_item_id = r.customer_package_item_id
         AND (x.sale_line_id = r.sale_line_id
              OR (x.sale_line_id IS NULL AND EXISTS (SELECT 1 FROM sale_return_lines rl WHERE rl.sale_return_id = x.sale_return_id AND rl.sale_line_id = r.sale_line_id)))
       WHERE r.kind = 'REDEEMED' AND r.sale_line_id = ${l.saleLineId}
       GROUP BY r.id, r.customer_package_item_id, r.sessions, r.value`);
    const e = entries[0];
    if (!e) continue;
    const sessions = l.quantity.toNumber();
    const left = Number(e.redeemed) - Number(e.restored);
    // The return that gives back the last of the line's sessions takes the exact rest of its value.
    const value = sessions >= left ? toDec(e.value).minus(e.restored_value) : cents(toDec(e.value).times(sessions).dividedBy(e.redeemed));
    await db.insert(customerPackageEntries).values({
      tenantId: ctx.tenantId, customerPackageId: l.customerPackageId!, customerPackageItemId: e.customer_package_item_id, kind: 'RESTORED',
      sessions, value: value.toString(), saleLineId: l.saleLineId, saleReturnId: ctx.saleReturnId, createdBy: ctx.userId,
    });
    restored = restored.plus(value);
  }
  return { prepaid, restored };
}

/** A customer's packages with what is left of each service (the till and the client's history). Expiry is judged in the selling branch's calendar. */
export async function customerPackageBalances(db: Database, customerId: string, opts: { openOnly?: boolean } = {}) {
  const pkgs = await db.select().from(customerPackages).where(eq(customerPackages.customerId, customerId)).orderBy(customerPackages.createdAt);
  if (!pkgs.length) return [];
  const list = sql.join(pkgs.map((p) => sql`${p.id}`), sql`, `);
  const [{ rows }, { rows: expiry }] = await inSequence(
    () => db.execute<{ package_id: string; item_id: string; service_variant_id: string; name: string; sessions: number; left: number; value_left: string }>(sql`
      SELECT i.customer_package_id AS package_id, i.id AS item_id, i.service_variant_id, p.name || coalesce(' — ' || v.name, '') AS name, i.sessions,
             coalesce(sum(e.sessions), 0)::int AS left, coalesce(sum(e.value), 0)::text AS value_left
        FROM customer_package_items i
        JOIN product_variants v ON v.id = i.service_variant_id JOIN products p ON p.id = v.product_id
        LEFT JOIN customer_package_entries e ON e.customer_package_item_id = i.id
       WHERE i.customer_package_id IN (${list})
       GROUP BY 1, 2, 3, 4, 5 ORDER BY 4`),
    () => db.execute<{ id: string; expired: boolean }>(sql`
      SELECT c.id, coalesce(c.expires_on < (now() AT TIME ZONE b.timezone)::date, false) AS expired
        FROM customer_packages c JOIN branches b ON b.id = c.branch_id WHERE c.id IN (${list})`),
  );
  const out = pkgs.map((p) => {
    const its = rows.filter((r) => r.package_id === p.id);
    return {
      id: p.id, name: p.name, legalEntityId: p.legalEntityId, branchId: p.branchId, saleId: p.saleId, boughtAt: p.createdAt, expiresOn: p.expiresOn,
      expired: expiry.find((x) => x.id === p.id)?.expired ?? false,
      value: toDec(p.value).toFixed(2),
      valueLeft: its.reduce((a, r) => a.plus(r.value_left), new Dec(0)).toFixed(2),
      services: its.map((r) => ({ itemId: r.item_id, variantId: r.service_variant_id, name: r.name, sessions: Number(r.sessions), sessionsLeft: Number(r.left) })),
    };
  });
  return opts.openOnly ? out.filter((p) => !p.expired && p.services.some((s) => s.sessionsLeft > 0)) : out;
}
