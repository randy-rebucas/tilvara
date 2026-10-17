import type { Branch, Product } from './api';

/**
 * Selectable items for document lines; `stocked` keeps only items that track inventory; `units`
 * (uom id → code) adds the unit a quantity is counted in, e.g. "(KG)" for a recipe ingredient.
 */
export function variantOptions(products: Product[] | undefined, { stocked = false, units }: { stocked?: boolean; units?: Map<string, string> } = {}) {
  return (products ?? [])
    .filter((p) => !p.archivedAt && (!stocked || p.trackInventory))
    .flatMap((p) => {
      const unit = units && p.uomId ? units.get(p.uomId) : undefined;
      return p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, label: `${v.sku} · ${p.name}${v.name ? ` — ${v.name}` : ''}${unit ? ` (${unit})` : ''}` }));
    });
}

/** Detail routes 404 on anything that is not an id (the API would answer 400). */
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** "SKU · Name" per variant id, for documents whose lines carry only the id. */
export function variantNames(products: Product[] | undefined) {
  return new Map((products ?? []).flatMap((p) => p.variants.map((v) => [v.id, { sku: v.sku, name: v.name ? `${p.name} — ${v.name}` : p.name }] as const)));
}

/** Document numbers print like serials: 000012. */
export const docNo = (n: number) => String(n).padStart(6, '0');

export function branchLabel(branches: Branch[] | undefined, id: string | null | undefined): string {
  const b = branches?.find((x) => x.id === id);
  return b ? b.code : '—';
}
