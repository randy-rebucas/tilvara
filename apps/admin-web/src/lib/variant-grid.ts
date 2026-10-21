/**
 * Sizes and colours (ADR-0021 §2): every combination of up to three options (Size: S, M, L ×
 * Colour: Black, White), at most 100, each with an SKU built from the base and the values, a name
 * ("M / Black") and its attributes ({"Size": "M", "Colour": "Black"}).
 */
export const MAX_OPTIONS = 3;
export const MAX_COMBINATIONS = 100;
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

export interface VariantOptionInput {
  name: string;
  values: string[];
}

export interface Combination {
  sku: string;
  name: string;
  attributes: Record<string, string>;
}

/** "S, M, L" or one per line → distinct trimmed values, in order. */
export function splitValues(text: string): string[] {
  const out: string[] = [];
  for (const v of text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    if (!out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

/** An SKU part: uppercase, spaces to '-', only letters, digits and . _ / - kept. */
export function skuPart(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9._/-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._/]+|[-._/]+$/g, '');
}

/** `${base}-${VAL1}-${VAL2}`, cut to 64 characters; null when it cannot make a valid SKU. */
export function skuFor(base: string, values: string[]): string | null {
  const parts = [skuPart(base), ...values.map(skuPart)].filter(Boolean);
  const sku = parts.join('-').slice(0, 64).replace(/[-._/]+$/, '');
  return SKU_PATTERN.test(sku) ? sku : null;
}

/** Options that have a name and at least one value. */
export function usableOptions(options: VariantOptionInput[]): VariantOptionInput[] {
  return options.filter((o) => o.name.trim() && o.values.length > 0).slice(0, MAX_OPTIONS).map((o) => ({ name: o.name.trim(), values: o.values }));
}

export function combinationCount(options: VariantOptionInput[]): number {
  const usable = usableOptions(options);
  return usable.length === 0 ? 0 : usable.reduce((n, o) => n * o.values.length, 1);
}

/**
 * Every combination, first option slowest (S/Black, S/White, M/Black…). Throws past
 * MAX_COMBINATIONS; an SKU that cannot be made falls back to the base and the position.
 */
export function combinations(base: string, options: VariantOptionInput[]): Combination[] {
  const usable = usableOptions(options);
  if (usable.length === 0) return [];
  if (combinationCount(usable) > MAX_COMBINATIONS) throw new Error(`more than ${MAX_COMBINATIONS} combinations`);
  let rows: string[][] = [[]];
  for (const o of usable) rows = rows.flatMap((r) => o.values.map((v) => [...r, v]));
  return rows.map((values, i) => ({
    sku: skuFor(base, values) ?? skuFor(base, [String(i + 1)]) ?? String(i + 1),
    name: values.join(' / '),
    attributes: Object.fromEntries(usable.map((o, k) => [o.name, values[k]!])),
  }));
}

/** The same attributes (names and values, ignoring case and order). */
export function sameAttributes(a: Record<string, string>, b: Record<string, string>): boolean {
  const norm = (r: Record<string, string>) =>
    Object.entries(r)
      .map(([k, v]) => `${k.trim().toLowerCase()}=${v.trim().toLowerCase()}`)
      .sort()
      .join('|');
  return norm(a) === norm(b);
}

/** The options a product's variants already have, to start the grid from on its page. */
export function optionsFrom(variants: { attributes?: Record<string, string> | null }[]): VariantOptionInput[] {
  const out: VariantOptionInput[] = [];
  for (const v of variants) {
    for (const [name, value] of Object.entries(v.attributes ?? {})) {
      let o = out.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!o) {
        if (out.length >= MAX_OPTIONS) continue;
        o = { name, values: [] };
        out.push(o);
      }
      if (!o.values.some((x) => x.toLowerCase() === value.toLowerCase())) o.values.push(value);
    }
  }
  return out;
}
