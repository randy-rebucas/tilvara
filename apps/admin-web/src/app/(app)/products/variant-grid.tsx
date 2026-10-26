'use client';

import { Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, TextField } from '@/components/fields';
import { useT } from '@/i18n/client';
import type { ProductDetail } from '@/lib/api';
import { send } from '@/lib/client-api';
import { combinationCount, combinations, MAX_COMBINATIONS, MAX_OPTIONS, optionsFrom, sameAttributes, skuPart, splitValues, type Combination, type VariantOptionInput } from '@/lib/variant-grid';

export interface OptionRow {
  name: string;
  values: string;
}

export const toInputs = (rows: OptionRow[]): VariantOptionInput[] => rows.map((r) => ({ name: r.name, values: splitValues(r.values) }));

/** Up to three options, each a name and its values ("Size": "S, M, L"). */
export function OptionsEditor({ rows, onChange }: { rows: OptionRow[]; onChange: (rows: OptionRow[]) => void }) {
  const { t } = useT();
  const set = (i: number, patch: Partial<OptionRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-end gap-2">
          <TextField label={t('vgrid.option')} labelClassName={i > 0 ? 'sr-only' : undefined} value={r.name} placeholder={i === 0 ? t('vgrid.optionHint1') : t('vgrid.optionHint2')} onChange={(e) => set(i, { name: e.target.value })} />
          <TextField label={t('vgrid.values')} labelClassName={i > 0 ? 'sr-only' : undefined} value={r.values} placeholder={i === 0 ? 'S, M, L, XL' : t('vgrid.valuesHint2')} onChange={(e) => set(i, { values: e.target.value })} />
          <button type="button" className="btn h-[2.4rem] px-2.5" aria-label={t('vgrid.removeOption', { n: i + 1 })} disabled={rows.length <= 1} onClick={() => onChange(rows.filter((_, k) => k !== i))}>
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ))}
      <p className="text-[0.8125rem] text-muted">{t('vgrid.valuesHelp')}</p>
      {rows.length < MAX_OPTIONS && (
        <div>
          <button type="button" className="btn" onClick={() => onChange([...rows, { name: '', values: '' }])}>
            <Plus aria-hidden className="size-4" /> {t('vgrid.addOption')}
          </button>
        </div>
      )}
    </div>
  );
}

/** The variants the grid makes, before anything is saved; `status` per row while adding them. */
export function GridPreview({ rows, status }: { rows: Combination[]; status?: Record<string, { ok: boolean; message?: string }> }) {
  const { t } = useT();
  if (rows.length === 0) return null;
  return (
    <div className="max-h-[320px] overflow-auto rounded-[5px] border border-hair-soft">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t('prod.sku')}</th>
            <th>{t('prod.variantName')}</th>
            {status && <th>{t('common.status')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = status?.[r.sku];
            return (
              <tr key={r.sku}>
                <td><span className="serial text-[0.8125rem]">{r.sku}</span></td>
                <td>{r.name}</td>
                {status && <td className={s && !s.ok ? 'text-red' : 'text-muted'}>{s ? (s.ok ? t('vgrid.added') : s.message) : t('vgrid.waiting')}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Combinations for a base SKU, or the reason there are none / too many. */
export function useGrid(base: string, rows: OptionRow[]) {
  const inputs = toInputs(rows);
  const count = combinationCount(inputs);
  const tooMany = count > MAX_COMBINATIONS;
  const list = !tooMany && skuPart(base) ? combinations(base, inputs) : [];
  return { count, tooMany, list };
}

/**
 * On a product's page: add the combinations it does not have yet, one variant at a time (each with
 * its own Idempotency-Key for this open panel, so a retry never adds one twice).
 */
function AddCombinationsFields({ close, product }: { close: () => void; product: ProductDetail }) {
  const { t } = useT();
  const router = useRouter();
  const live = product.variants.filter((v) => !v.archivedAt);
  const firstWithAttrs = live.find((v) => v.attributes && Object.keys(v.attributes).length > 0);
  const guessBase = () => {
    const v = firstWithAttrs ?? live[0];
    if (!v) return '';
    const suffix = Object.values(v.attributes ?? {}).map(skuPart).filter(Boolean).join('-');
    return suffix && v.sku.toUpperCase().endsWith(`-${suffix}`) ? v.sku.slice(0, -(suffix.length + 1)) : v.sku;
  };
  const start = optionsFrom(live);
  const [base, setBase] = useState(guessBase);
  const [rows, setRows] = useState<OptionRow[]>(start.length ? start.map((o) => ({ name: o.name, values: o.values.join(', ') })) : [{ name: '', values: '' }]);
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [status, setStatus] = useState<Record<string, { ok: boolean; message?: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  // Frozen when adding starts: added variants leave the missing list once the page refreshes.
  const [plan, setPlan] = useState<Combination[] | null>(null);
  const keys = useRef(new Map<string, string>());
  const grid = useGrid(base, rows);
  const skus = new Set(product.variants.map((v) => v.sku.toLowerCase()));
  const missing = grid.list.filter((c) => !live.some((v) => sameAttributes(v.attributes ?? {}, c.attributes)));
  const fresh = missing.filter((c) => !skus.has(c.sku.toLowerCase()));
  const clash = missing.length - fresh.length;
  const priceOk = !price.trim() || /^\d{1,16}(\.\d{1,4})?$/.test(price.trim());
  const costOk = !cost.trim() || /^\d{1,16}(\.\d{1,4})?$/.test(cost.trim());

  async function addAll() {
    setBusy(true);
    const list = plan ?? fresh;
    setPlan(list);
    const out: Record<string, { ok: boolean; message?: string }> = { ...status };
    for (const c of list) {
      if (out[c.sku]?.ok) continue;
      if (!keys.current.has(c.sku)) keys.current.set(c.sku, crypto.randomUUID());
      const r = await send('POST', `/api/v1/products/${product.id}/variants`, {
        sku: c.sku,
        name: c.name,
        attributes: c.attributes,
        barcodes: [],
        ...(price.trim() ? { price: price.trim() } : {}),
        ...(cost.trim() ? { referenceCost: cost.trim() } : {}),
      }, { idempotencyKey: keys.current.get(c.sku)! });
      out[c.sku] = r.ok ? { ok: true } : { ok: false, message: r.error.message };
      setStatus({ ...out });
    }
    setBusy(false);
    router.refresh();
  }

  const shown = plan ?? fresh;
  const done = status ? shown.filter((c) => status[c.sku]?.ok).length : 0;
  const failed = status ? shown.filter((c) => status[c.sku] && !status[c.sku]!.ok).length : 0;
  return (
    <div className="flex flex-col gap-4">
      <p className="-mt-2 text-[0.875rem] text-muted">{t('vgrid.pageHint')}</p>
      <fieldset disabled={plan !== null} className="flex flex-col gap-4">
      <div className="grid gap-3 @lg:grid-cols-3">
        <TextField label={t('vgrid.baseSku')} value={base} onChange={(e) => setBase(e.target.value)} hint={t('vgrid.baseSkuHint')} />
        <TextField label={`${t('prod.price')} (${t('common.optional')})`} inputMode="decimal" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} error={priceOk ? undefined : t('vgrid.badAmount')} />
        <TextField label={`${t('prod.refCost')} (${t('common.optional')})`} inputMode="decimal" placeholder="0.00" value={cost} onChange={(e) => setCost(e.target.value)} error={costOk ? undefined : t('vgrid.badAmount')} />
      </div>
      <OptionsEditor rows={rows} onChange={setRows} />
      </fieldset>
      {plan ? null : grid.tooMany ? (
        <FormError message={t('vgrid.tooMany', { n: grid.count, max: MAX_COMBINATIONS })} />
      ) : (
        <p className="text-[0.9375rem]" role="status">
          {t('vgrid.missing', { n: fresh.length, all: grid.list.length })}
          {clash > 0 && <span className="text-muted"> · {t('vgrid.skuClash', { n: clash })}</span>}
        </p>
      )}
      <GridPreview rows={shown} status={status ?? undefined} />
      {status && <p className="text-[0.875rem]" role="status">{t('vgrid.progress', { done, all: shown.length })}{failed > 0 && ` · ${t('vgrid.failed', { n: failed })}`}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" disabled={busy || shown.length === 0 || !priceOk || !costOk || (status !== null && done === shown.length)} onClick={() => void addAll()}>
          {failed > 0 ? t('vgrid.retry') : t('vgrid.addN', { n: shown.length - done })}
        </button>
        <button type="button" className="btn" onClick={close} disabled={busy}>{status && done > 0 ? t('common.done') : t('common.cancel')}</button>
      </div>
    </div>
  );
}

export function AddCombinations({ product }: { product: ProductDetail }) {
  const { t } = useT();
  return <Disclosure wide label={t('vgrid.addTitle')}>{(close) => <AddCombinationsFields close={close} product={product} />}</Disclosure>;
}
