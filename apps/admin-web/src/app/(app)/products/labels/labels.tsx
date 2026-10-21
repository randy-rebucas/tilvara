'use client';

import { Printer, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { BarcodeSvg } from '@/components/barcode-svg';
import { SelectField, TextField } from '@/components/fields';
import { ItemPicker, variantLabel, type PickProduct } from '@/components/item-picker';
import { Note } from '@/components/note';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import { peso } from '@/lib/format';
import { expandCopies, LAYOUTS, paginate, slotPosition, type Layout, type LayoutKey } from '@/lib/labels';

interface Picked {
  variantId: string;
  copies: number;
}
interface LabelData {
  variantId: string;
  name: string;
  sku: string;
  code: string;
  price: string | null;
  location: string | null;
}

const MAX_LABELS = 2000;

/** One label: name, price, barcode, SKU and shelf location, sized for its layout. */
function Label({ d, layout, noPrice }: { d: LabelData; layout: Layout; noPrice: string }) {
  const small = layout.h < 28;
  const pad = small ? 1.5 : 2.2;
  const inner = layout.w - pad * 2;
  const priceMm = layout.shelf ? 9 : small ? 4 : 5.2;
  const nameMm = layout.shelf ? 3.2 : small ? 2.5 : 3;
  const barMm = layout.shelf ? 8 : small ? 7.5 : 11;
  return (
    <div className="flex h-full flex-col justify-between overflow-hidden text-black" style={{ padding: `${pad}mm` }}>
      <div className="flex items-start justify-between gap-[1mm]">
        <p className="min-w-0 font-semibold leading-tight" style={{ fontSize: `${nameMm}mm`, display: '-webkit-box', WebkitLineClamp: small ? 1 : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {d.name}
        </p>
        {d.location && !layout.shelf && (
          <span className="serial shrink-0 rounded-[1mm] border border-black px-[0.8mm] leading-none" style={{ fontSize: `${nameMm * 0.85}mm` }}>{d.location}</span>
        )}
      </div>
      <p className="money font-bold leading-none" style={{ fontSize: `${priceMm}mm` }}>{d.price ? peso(d.price) : noPrice}</p>
      <div className="flex items-end justify-between gap-[1mm]">
        <BarcodeSvg code={d.code} widthMm={layout.shelf ? inner * 0.62 : inner} heightMm={barMm} />
        {layout.shelf && (
          <div className="serial min-w-0 text-right leading-tight" style={{ fontSize: '2.4mm' }}>
            <div className="truncate">{d.sku}</div>
            {d.location && <div className="font-semibold" style={{ fontSize: '3.2mm' }}>{d.location}</div>}
          </div>
        )}
      </div>
      {!layout.shelf && !small && <p className="serial truncate leading-none" style={{ fontSize: '2.2mm' }}>{d.sku}</p>}
    </div>
  );
}

/** Pick items and copies, a branch for the price and shelf location, a layout; preview, then print. */
export function LabelMaker({
  products,
  branches,
  byBranch,
}: {
  products: PickProduct[];
  branches: { id: string; code: string; name: string }[];
  byBranch: Record<string, { prices: Record<string, string>; locations: Record<string, string> }>;
}) {
  const { t } = useT();
  const [branchId, setBranchId] = useState(branches[0]!.id);
  const [layoutKey, setLayoutKey] = useState<LayoutKey>('a4_21');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [skip, setSkip] = useState('0');
  const layout = LAYOUTS[layoutKey];
  const chosen = useMemo(() => new Set(picked.map((p) => p.variantId)), [picked]);
  const variants = useMemo(() => new Map(products.flatMap((p) => p.variants.map((v) => [v.id, { product: p, v }] as const))), [products]);
  const scope = byBranch[branchId] ?? { prices: {}, locations: {} };

  const data = (id: string): LabelData | null => {
    const hit = variants.get(id);
    if (!hit) return null;
    return {
      variantId: id,
      name: variantLabel(hit.product, hit.v),
      sku: hit.v.sku,
      // The item's barcode (an EAN-13 prints as one), else its SKU as Code 128.
      code: hit.v.barcodes?.[0] ?? hit.v.sku,
      price: scope.prices[id] ?? null,
      location: scope.locations[id] ?? null,
    };
  };
  const labels = expandCopies(picked).slice(0, MAX_LABELS).map((p) => data(p.variantId)).filter((d): d is LabelData => !!d);
  const total = picked.reduce((n, p) => n + p.copies, 0);
  const skipN = /^\d{1,3}$/.test(skip) ? Number(skip) : 0;
  const pages = paginate(labels, layout, skipN);
  const noPrice = picked.filter((p) => !scope.prices[p.variantId]).length;

  // The printer's page: its size and no margins (the sheet positions every label itself).
  const printCss = `@media print { @page { size: ${layout.page}; margin: 0; } .label-page { box-shadow: none !important; border: 0 !important; margin: 0 !important; break-after: page; } .label-page:last-child { break-after: auto; } .label-sheets { gap: 0 !important; overflow: visible !important; } }`;

  return (
    <>
      <style>{printCss}</style>
      <div className="grid gap-6 print:hidden lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Note denom="blue" className="flex flex-col gap-4 px-5 py-4 pr-8">
          <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('lbl.lede')}</p>
          <ItemPicker products={products} chosen={chosen} onAdd={(ids) => setPicked((all) => [...all, ...ids.filter((id) => !all.some((p) => p.variantId === id)).map((variantId) => ({ variantId, copies: 1 }))])} />
          {picked.length > 0 ? (
            <ul className="flex flex-col">
              {picked.map((p) => {
                const d = data(p.variantId);
                return (
                  <li key={p.variantId} className="grid grid-cols-[minmax(0,1fr)_88px_auto] items-center gap-2 border-b border-hair-soft py-2 last:border-b-0">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{d?.name ?? '—'}</div>
                      <div className="serial truncate text-[0.8125rem] text-muted">
                        {d?.sku} · {d?.price ? peso(d.price) : t('lbl.noPrice')}{d?.location ? ` · ${d.location}` : ''}
                      </div>
                    </div>
                    <TextField
                      label={t('lbl.copiesFor', { name: d?.name ?? '' })}
                      labelClassName="sr-only"
                      type="number"
                      min={1}
                      max={500}
                      inputMode="numeric"
                      value={String(p.copies)}
                      onChange={(e) => {
                        const n = Math.max(0, Math.min(500, Math.floor(Number(e.target.value) || 0)));
                        setPicked((all) => all.map((x) => (x.variantId === p.variantId ? { ...x, copies: n } : x)));
                      }}
                    />
                    <button type="button" className="btn h-[2.4rem] px-2.5" aria-label={t('promo.removeItem', { name: d?.name ?? '' })} onClick={() => setPicked((all) => all.filter((x) => x.variantId !== p.variantId))}>
                      <X aria-hidden className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[0.875rem] text-muted">{t('lbl.noItems')}</p>
          )}
        </Note>

        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label={t('lbl.branch')} value={branchId} onChange={(e) => setBranchId(e.target.value)} hint={t('lbl.branchHint')}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
            </SelectField>
            <SelectField label={t('lbl.layout')} value={layoutKey} onChange={(e) => setLayoutKey(e.target.value as LayoutKey)}>
              {(Object.keys(LAYOUTS) as LayoutKey[]).map((k) => <option key={k} value={k}>{t(`lbl.layout.${k}` as MessageKey)}</option>)}
            </SelectField>
            {layoutKey !== 'roll' && (
              <TextField label={t('lbl.skip')} type="number" min={0} inputMode="numeric" value={skip} onChange={(e) => setSkip(e.target.value)} hint={t('lbl.skipHint')} />
            )}
          </div>
          <p className="text-[0.9375rem]" role="status">
            {t('lbl.summary', { labels: labels.length, pages: pages.length })}
            {total > MAX_LABELS && <span className="text-red"> · {t('lbl.tooMany', { max: MAX_LABELS })}</span>}
            {noPrice > 0 && <span className="text-muted"> · {t('lbl.someNoPrice', { n: noPrice })}</span>}
          </p>
          <div>
            <button type="button" className="btn btn-primary" disabled={labels.length === 0} onClick={() => window.print()}>
              <Printer aria-hidden className="size-4" /> {t('lbl.print')}
            </button>
          </div>
          <p className="text-[0.8125rem] text-muted">{t('lbl.printHint')}</p>
        </div>
      </div>

      {pages.length > 0 && (
        <section aria-label={t('lbl.preview')} className="flex flex-col gap-3">
          <h2 className="section-title print:hidden">{t('lbl.preview')}</h2>
          <div className="label-sheets flex flex-col items-start gap-6 overflow-x-auto pb-2">
            {pages.map((page, pi) => (
              <div
                key={pi}
                className="label-page relative shrink-0 bg-white shadow-[0_1px_2px_rgb(60_50_20/0.06),0_4px_12px_-6px_rgb(60_50_20/0.12)] border border-hair"
                style={{ width: `${layout.pageW}mm`, height: `${layout.pageH}mm` }}
              >
                {page.map((d, i) => {
                  const at = slotPosition(layout, i);
                  return (
                    <div
                      key={i}
                      className={`absolute ${d ? 'outline outline-dashed outline-hair-soft print:outline-0' : ''}`}
                      style={{ left: `${at.x}mm`, top: `${at.y}mm`, width: `${layout.w}mm`, height: `${layout.h}mm` }}
                    >
                      {d && <Label d={d} layout={layout} noPrice={t('lbl.noPrice')} />}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
