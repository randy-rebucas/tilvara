import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Me, type TaxCategory, type Uom } from '@/lib/api';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';
import { ProductsTabs } from '../tabs';
import { AddTaxCategory, AddUom } from './forms';

export const generateMetadata = pageTitle('products.units');

/**
 * Units of measure and tax categories, the two lists every product picks from. Adding a unit needs
 * catalog.manage; adding a tax category needs tax.manage (the API checks both).
 */
export default async function UnitsPage() {
  const { t } = await getT();
  const [me, uoms, taxes] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: Uom[] }>('/uoms'),
    apiOrNull<{ data: TaxCategory[] }>('/tax-categories'),
  ]);
  const permissions = me.activeTenant?.permissions ?? [];
  const canCatalog = permissions.includes('catalog.manage');
  const canTax = permissions.includes('tax.manage');
  const yes = t('units.yes');
  const no = t('units.no');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('prod.title')} lede={t('prod.lede')} />
      <ProductsTabs active="units" />

      <section className="flex flex-col gap-3" aria-labelledby="uoms-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="uoms-title" className="section-title pt-2">{t('units.uoms')}</h2>
            <p className="mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('units.uomsLede')}</p>
          </div>
          {canCatalog && uoms && <AddUom />}
        </div>
        <Note denom="blue" className="pr-2">
          {uoms && uoms.data.length > 0 ? (
            <RecordTable
              rows={uoms.data}
              rowKey={(u) => u.id}
              dimmed={(u) => !!u.archivedAt}
              columns={[
                { header: t('units.code'), cell: (u) => <Serial className="text-ink">{u.code}</Serial> },
                { header: t('common.name'), cell: (u) => u.name },
                { header: t('units.fraction'), cell: (u) => (u.allowsFraction ? yes : no) },
              ]}
              stacked={{ title: (u) => u.name, meta: (u) => <Serial>{u.code}</Serial>, figure: (u) => (u.allowsFraction ? t('units.fractionShort') : null) }}
            />
          ) : (
            <Empty>{uoms ? t('units.noUoms') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="tax-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="tax-title" className="section-title pt-2">{t('units.taxes')}</h2>
            <p className="mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('units.taxesLede')}</p>
          </div>
          {canTax && taxes && <AddTaxCategory />}
        </div>
        <Note denom="blue" className="pr-2">
          {taxes && taxes.data.length > 0 ? (
            <RecordTable
              rows={taxes.data}
              rowKey={(x) => x.id}
              dimmed={(x) => !!x.archivedAt}
              columns={[
                { header: t('units.code'), cell: (x) => <Serial className="text-ink">{x.code}</Serial> },
                { header: t('common.name'), cell: (x) => x.name },
                { header: t('units.vat'), cell: (x) => t(`units.vat.${x.vatTreatment}` as MessageKey) },
              ]}
              stacked={{ title: (x) => x.name, meta: (x) => <Serial>{x.code}</Serial>, figure: (x) => t(`units.vat.${x.vatTreatment}` as MessageKey) }}
            />
          ) : (
            <Empty>{taxes ? t('units.noTaxes') : t('common.noAccess')}</Empty>
          )}
        </Note>
        {!canTax && <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('units.taxNeeds')}</p>}
      </section>
    </div>
  );
}
