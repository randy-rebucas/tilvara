'use client';

import { Plus, Search } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '@/i18n/client';

export interface PickVariant {
  id: string;
  sku: string;
  name: string | null;
  barcodes?: string[];
}
export interface PickProduct {
  id: string;
  name: string;
  variants: PickVariant[];
}

/** "Product — Variant" (or the product alone when the variant has no name of its own). */
export const variantLabel = (p: { name: string }, v: { name: string | null }) => (v.name ? `${p.name} — ${v.name}` : p.name);

/**
 * Search the catalogue and add items: a whole product (every variant: all its sizes and colours)
 * or chosen variants. What is chosen is shown by the form that uses it.
 */
export function ItemPicker({ products, chosen, onAdd, label }: { products: PickProduct[]; chosen: ReadonlySet<string>; onAdd: (variantIds: string[]) => void; label?: string }) {
  const { t } = useT();
  const id = useId();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const matches = needle
    ? products
        .filter((p) => p.name.toLowerCase().includes(needle) || p.variants.some((v) => v.sku.toLowerCase().includes(needle) || (v.name ?? '').toLowerCase().includes(needle) || (v.barcodes ?? []).includes(q.trim())))
        .slice(0, 12)
    : [];
  return (
    <div className="flex flex-col gap-2">
      <div className="field">
        <label htmlFor={id}>{label ?? t('pick.search')}</label>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input
            id={id}
            className="input pl-9"
            value={q}
            placeholder={t('prod.search')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds the only match's items (a scanned barcode), and never submits the form.
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (matches.length === 1) {
                const p = matches[0]!;
                const hit = p.variants.filter((v) => v.sku.toLowerCase() === needle || (v.barcodes ?? []).includes(q.trim()));
                onAdd((hit.length ? hit : p.variants).map((v) => v.id).filter((v) => !chosen.has(v)));
                setQ('');
              }
            }}
          />
        </div>
      </div>
      {needle && (
        <ul className="flex flex-col rounded-[5px] border border-hair-soft bg-white" aria-label={t('pick.results')}>
          {matches.length === 0 && <li className="px-3 py-2 text-[0.875rem] text-muted">{t('pick.none', { q: q.trim() })}</li>}
          {matches.map((p) => {
            const open = p.variants.filter((v) => !chosen.has(v.id));
            return (
              <li key={p.id} className="flex flex-col gap-1.5 border-b border-hair-soft px-3 py-2 last:border-b-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{p.name}</span>
                  <button type="button" className="btn h-8 px-2.5 text-[0.8125rem]" disabled={open.length === 0} onClick={() => onAdd(open.map((v) => v.id))}>
                    <Plus aria-hidden className="size-3.5" /> {p.variants.length > 1 ? t('pick.addAll', { n: open.length }) : t('common.add')}
                  </button>
                </div>
                {p.variants.length > 1 && (
                  <div className="flex flex-wrap gap-1.5">
                    {p.variants.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        className="tag hover:text-ink disabled:opacity-50"
                        disabled={chosen.has(v.id)}
                        aria-label={t('pick.addOne', { name: variantLabel(p, v) })}
                        onClick={() => onAdd([v.id])}
                      >
                        <span className="serial">{v.sku}</span>
                        {v.name && <span className="ml-1">{v.name}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
