import { Dec, roundTo, toDec, type RoundingMode } from '@1pos/money';

/**
 * Promotions (ADR-0021). Pure: callers load the promotions in force for the branch at the pricing
 * instant and the cart's priced lines, and feed each line's result to the tax engine as its ordinary
 * `discount`. The server (`TaxService.computeCart`) and the offline till call this same function, so
 * an offline total is what the server's re-pricing gives.
 */

export type PromotionKind = 'MULTI_BUY' | 'BUY_X_GET_Y' | 'QUANTITY_BREAK';

export interface PromotionTier {
  /** Total quantity of the set at which the tier starts (decimal string, > 0). */
  minQuantity: string;
  /** Fraction off each line of the set, in (0, 1]. */
  rate: string;
}

export interface Promotion {
  id: string;
  name: string;
  kind: PromotionKind;
  /** ISO instant; the earlier start wins a tie between equal discounts. */
  startsAt: string;
  /** The items of the set (mix and match within it). */
  variantIds: readonly string[];
  /** MULTI_BUY: `quantity` whole units for `price` (on the price list's basis). */
  quantity?: number;
  price?: string;
  /** BUY_X_GET_Y: buy `buyQuantity`, get `getQuantity` at `getRate` off ("1" = free). */
  buyQuantity?: number;
  getQuantity?: number;
  getRate?: string;
  /** QUANTITY_BREAK: the highest tier reached applies. */
  tiers?: readonly PromotionTier[];
}

export interface PromotionLine {
  id: string;
  variantId: string;
  /** Unit price on the price list's basis. */
  unitPrice: string;
  quantity: string;
  /** False for a line with its own discount, an approved price or SC/PWD (ADR-0021 §1). */
  eligible: boolean;
}

export interface PromotionLineResult {
  id: string;
  promotionId: string | null;
  /** Rounded to the currency's minor units; null when no promotion applies. */
  discount: string | null;
}

export interface PromotionRounding {
  /** The currency's minor units (2 for PHP). */
  scale: number;
  mode: RoundingMode;
}

export class PromotionError extends Error {
  constructor(
    message: string,
    readonly promotionId: string,
  ) {
    super(message);
    this.name = 'PromotionError';
  }
}

const ZERO = new Dec(0);

interface Unit {
  /** Index of the line in the input. */
  line: number;
  price: Dec;
  count: number;
}

interface Outcome {
  promotion: Promotion;
  total: Dec;
  /** Discount per line index (rounded), for every line that took part (0 allowed). */
  parts: Map<number, Dec>;
}

const isWhole = (d: Dec) => d.isInteger();

function positiveInt(value: number | undefined, what: string, p: Promotion): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) throw new PromotionError(`${what} must be a whole number of at least 1`, p.id);
  return value;
}

function fraction(value: string | undefined, what: string, p: Promotion): Dec {
  let d: Dec;
  try {
    d = toDec(value ?? '');
  } catch {
    throw new PromotionError(`${what} must be a decimal string`, p.id);
  }
  if (d.lte(0) || d.gt(1)) throw new PromotionError(`${what} must be in (0, 1]`, p.id);
  return d;
}

/** Units of the given lines, highest price first, then line order (whole quantities only). */
function runs(lines: readonly PromotionLine[], members: readonly number[]): Unit[] {
  return members
    .map((i) => ({ line: i, price: toDec(lines[i]!.unitPrice), count: toDec(lines[i]!.quantity).toNumber() }))
    .sort((a, b) => b.price.comparedTo(a.price) || a.line - b.line);
}

/**
 * Split `amount` over `weights` in proportion, rounded to `scale` by the largest remainder, so the
 * parts add up to exactly `amount` (which is already at `scale`).
 */
export function allocate(amount: Dec, weights: readonly Dec[], scale: number): Dec[] {
  const total = weights.reduce((a, w) => a.plus(w), ZERO);
  if (total.isZero()) return weights.map((_, i) => (i === 0 ? amount : ZERO));
  const unit = new Dec(1).dividedBy(new Dec(10).pow(scale));
  const exact = weights.map((w) => amount.times(w).dividedBy(total));
  const floors = exact.map((e) => e.toDecimalPlaces(scale, Dec.ROUND_DOWN));
  let left = amount.minus(floors.reduce((a, f) => a.plus(f), ZERO));
  const order = exact.map((e, i) => ({ i, rem: e.minus(floors[i]!) })).sort((a, b) => b.rem.comparedTo(a.rem) || a.i - b.i);
  for (const { i } of order) {
    if (left.lte(0)) break;
    floors[i] = floors[i]!.plus(unit);
    left = left.minus(unit);
  }
  return floors;
}

/**
 * Walk `units` in groups of `size` (a group may span lines). `onGroup` gets each complete group as
 * (line index, price, count) pieces and how many identical groups it stands for; units left over that
 * do not fill a group take no part.
 */
function groups(units: Unit[], size: number, onGroup: (pieces: Unit[], times: number) => void) {
  const queue = units.map((u) => ({ ...u }));
  let total = queue.reduce((a, u) => a + u.count, 0);
  let k = 0;
  while (total >= size && k < queue.length) {
    const head = queue[k]!;
    if (head.count === 0) {
      k++;
      continue;
    }
    // Whole groups inside one line's run are identical: take them at once.
    const inside = Math.floor(head.count / size);
    if (inside > 0) {
      onGroup([{ line: head.line, price: head.price, count: size }], inside);
      head.count -= inside * size;
      total -= inside * size;
      continue;
    }
    const pieces: Unit[] = [];
    let need = size;
    for (let j = k; need > 0 && j < queue.length; j++) {
      const u = queue[j]!;
      const take = Math.min(u.count, need);
      if (take === 0) continue;
      pieces.push({ line: u.line, price: u.price, count: take });
      u.count -= take;
      need -= take;
    }
    total -= size;
    onGroup(pieces, 1);
  }
}

function multiBuy(p: Promotion, lines: readonly PromotionLine[], members: number[], r: PromotionRounding): Outcome {
  const size = positiveInt(p.quantity, 'quantity', p);
  let price: Dec;
  try {
    price = toDec(p.price ?? '');
  } catch {
    throw new PromotionError('price must be a decimal string', p.id);
  }
  if (price.isNegative()) throw new PromotionError('price must not be negative', p.id);
  const parts = new Map<number, Dec>();
  let total = ZERO;
  groups(runs(lines, members.filter((i) => isWhole(toDec(lines[i]!.quantity)))), size, (pieces, times) => {
    const sum = pieces.reduce((a, u) => a.plus(u.price.times(u.count)), ZERO);
    const off = roundTo(Dec.max(ZERO, sum.minus(price)), r.scale, r.mode);
    const shares = allocate(off, pieces.map((u) => u.price.times(u.count)), r.scale);
    pieces.forEach((u, i) => parts.set(u.line, (parts.get(u.line) ?? ZERO).plus(shares[i]!.times(times))));
    total = total.plus(off.times(times));
  });
  return { promotion: p, total, parts };
}

function buyXGetY(p: Promotion, lines: readonly PromotionLine[], members: number[], r: PromotionRounding): Outcome {
  const buy = positiveInt(p.buyQuantity, 'buyQuantity', p);
  const get = positiveInt(p.getQuantity, 'getQuantity', p);
  const rate = fraction(p.getRate, 'getRate', p);
  const exact = new Map<number, Dec>();
  groups(runs(lines, members.filter((i) => isWhole(toDec(lines[i]!.quantity)))), buy + get, (pieces, times) => {
    // Pieces run from the dearest unit down: the last `get` units of the group are the cheap ones.
    let skip = buy;
    for (const u of pieces) {
      const paid = Math.min(skip, u.count);
      skip -= paid;
      const free = u.count - paid;
      exact.set(u.line, (exact.get(u.line) ?? ZERO).plus(u.price.times(rate).times(free).times(times)));
    }
  });
  const parts = new Map<number, Dec>();
  let total = ZERO;
  for (const [line, d] of exact) {
    const off = roundTo(d, r.scale, r.mode);
    parts.set(line, off);
    total = total.plus(off);
  }
  return { promotion: p, total, parts };
}

function quantityBreak(p: Promotion, lines: readonly PromotionLine[], members: number[], r: PromotionRounding): Outcome {
  const tiers = (p.tiers ?? []).map((t) => {
    let min: Dec;
    try {
      min = toDec(t.minQuantity);
    } catch {
      throw new PromotionError('minQuantity must be a decimal string', p.id);
    }
    if (min.lte(0)) throw new PromotionError('minQuantity must be positive', p.id);
    return { min, rate: fraction(t.rate, 'rate', p) };
  });
  if (!tiers.length) throw new PromotionError('A quantity break needs at least one tier', p.id);
  const quantity = members.reduce((a, i) => a.plus(toDec(lines[i]!.quantity)), ZERO);
  const tier = tiers.filter((t) => t.min.lte(quantity)).sort((a, b) => b.min.comparedTo(a.min))[0];
  const parts = new Map<number, Dec>();
  let total = ZERO;
  if (!tier) return { promotion: p, total, parts };
  for (const i of members) {
    const l = lines[i]!;
    const gross = roundTo(toDec(l.unitPrice).times(l.quantity), r.scale, r.mode);
    const off = roundTo(gross.times(tier.rate), r.scale, r.mode);
    parts.set(i, off);
    total = total.plus(off);
  }
  return { promotion: p, total, parts };
}

function evaluate(p: Promotion, lines: readonly PromotionLine[], members: number[], r: PromotionRounding): Outcome {
  if (p.kind === 'MULTI_BUY') return multiBuy(p, lines, members, r);
  if (p.kind === 'BUY_X_GET_Y') return buyXGetY(p, lines, members, r);
  if (p.kind === 'QUANTITY_BREAK') return quantityBreak(p, lines, members, r);
  throw new PromotionError(`Unknown promotion kind ${String(p.kind)}`, p.id);
}

/**
 * The promotions a cart earns (ADR-0021 §1): one per line, the customer's best first. Each round
 * evaluates every promotion not yet applied on the eligible lines not yet claimed and applies the one
 * with the largest discount (ties: earlier start, then id); the lines that took part are claimed.
 * Returns one result per input line, in order. A line's discount never exceeds its gross.
 */
export function applyPromotions(lines: readonly PromotionLine[], promotions: readonly Promotion[], r: PromotionRounding): PromotionLineResult[] {
  const out: PromotionLineResult[] = lines.map((l) => ({ id: l.id, promotionId: null, discount: null }));
  const claimed = new Set<number>();
  const pending = [...promotions].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  const sets = new Map(pending.map((p) => [p.id, new Set(p.variantIds)]));
  for (;;) {
    let best: Outcome | null = null;
    for (const p of pending) {
      const set = sets.get(p.id)!;
      const members = lines.flatMap((l, i) => (l.eligible && !claimed.has(i) && set.has(l.variantId) && toDec(l.quantity).gt(0) ? [i] : []));
      if (!members.length) continue;
      const o = evaluate(p, lines, members, r);
      if (o.total.gt(0) && (!best || o.total.gt(best.total))) best = o;
    }
    if (!best) break;
    for (const [i, d] of best.parts) {
      claimed.add(i);
      const l = lines[i]!;
      const gross = roundTo(toDec(l.unitPrice).times(l.quantity), r.scale, r.mode);
      out[i] = { id: l.id, promotionId: best.promotion.id, discount: Dec.min(d, gross).toFixed(r.scale) };
    }
    pending.splice(pending.indexOf(best.promotion), 1);
  }
  return out;
}
