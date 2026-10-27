'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SelectField } from '@/components/fields';
import { Sheet } from '@/components/sheet';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import { activeFilterCount, type ProductFilters } from '@/lib/product-filters';

type Option = [value: string, label: string];

/**
 * "Filters" beside the search box: the list's filters and sort in a sheet, like every other form.
 * Applying keeps the search words and drops the fields left at Any, so the address stays short.
 */
export function FilterSheet({ filters, categories, taxes }: { filters: ProductFilters; categories: Option[]; taxes: Option[] }) {
  const { t } = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters);
  const close = () => setOpen(false);

  function apply(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const s = new URLSearchParams();
    if (filters.q) s.set('q', filters.q);
    for (const [k, v] of new FormData(e.currentTarget)) if (typeof v === 'string' && v) s.set(k, v);
    close();
    router.push(s.size ? `/products?${s}` : '/products');
  }

  const select = (name: keyof ProductFilters, label: string, options: Option[], opts: { any?: string; hint?: string } = {}) => (
    <SelectField span="half" label={label} name={name} defaultValue={filters[name] ?? ''} hint={opts.hint}>
      <option value="">{opts.any ?? t('pf.any')}</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </SelectField>
  );
  const yesNo = (key: string): Option[] => [['true', t(`${key}.true` as MessageKey)], ['false', t(`${key}.false` as MessageKey)]];

  return (
    <>
      <button type="button" className="btn" aria-haspopup="dialog" data-testid="product-filters" onClick={() => setOpen(true)}>
        <SlidersHorizontal aria-hidden className="size-4" /> {count ? t('pf.filtersOn', { n: count }) : t('pf.filters')}
      </button>
      <Sheet open={open} title={t('pf.filters')} onClose={close}>
        <form onSubmit={apply} className="form-grid" noValidate>
          {select('category', t('prod.category'), [['none', t('prod.noCategory')], ...categories], { any: t('pf.anyCategory') })}
          {select('status', t('common.status'), [['archived', t('pf.status.archived')], ['all', t('pf.status.all')]], { any: t('pf.status.active') })}
          {select('type', t('pf.type'), [['STANDARD', t('pf.type.STANDARD')], ['SERVICE', t('pf.type.SERVICE')]])}
          {select('soldBy', t('prod.soldBy'), [['UNIT', t('prod.byUnit')], ['WEIGHT', t('prod.byWeight')]])}
          {select('tax', t('prod.tax'), taxes)}
          {select('stock', t('pf.stock'), yesNo('pf.stock'))}
          {select('expiry', t('pf.expiry'), yesNo('pf.expiry'))}
          {select('barcode', t('pf.barcode'), yesNo('pf.barcode'))}
          {select('price', t('pf.price'), yesNo('pf.price'), { hint: t('pf.priceHint') })}
          {select('variants', t('pf.variants'), yesNo('pf.variants'))}
          {select('sort', t('pf.sort'), [['newest', t('pf.sort.newest')], ['name', t('pf.sort.name')]], { any: t('pf.sort.oldest') })}
          <div className="form-actions">
            <button className="btn btn-primary">{t('common.show')}</button>
            {(count > 0 || filters.sort) && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  close();
                  router.push(filters.q ? `/products?${new URLSearchParams({ q: filters.q })}` : '/products');
                }}
              >
                {t('audit.clear')}
              </button>
            )}
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
