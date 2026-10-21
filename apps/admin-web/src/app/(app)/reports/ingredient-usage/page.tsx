import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { IngredientUsage } from '@/lib/api';
import { peso, qty, signed, signOf, sumDecimal } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.ingredient-usage');

/**
 * Theoretical vs actual use per ingredient (ADR-0014 §10): expected = recipes + sold as itself;
 * actual adds what was thrown away and what the counts found missing.
 */
export default async function IngredientUsagePage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<IngredientUsage>(`/reports/ingredient-usage?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const d = r?.data;
  const over = (v: string) => (signOf(v) > 0 ? 'text-red' : '');

  return (
    <ReportsChrome tab="usage" scope={scope} error={r?.error}>
      {d && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label={t('rep.expectedValue')}>{peso(d.totals.expectedValue)}</Figure>
          <Figure label={t('rep.wasteValue')}>{peso(d.totals.wasteValue)}</Figure>
          <Figure label={t('rep.actualValue')}>{peso(d.totals.actualValue)}</Figure>
          <Figure label={t('rep.varianceValue')} tone={signOf(d.totals.varianceValue) > 0 ? 'red' : undefined}>{signed(d.totals.varianceValue, peso)}</Figure>
        </div>
      )}
      <section>
        <p className="mb-3 max-w-[68ch] text-[0.875rem] text-muted">{t('rep.usageLede')}</p>
        <Note denom="gold" className="pr-2">
          {d && d.data.length > 0 ? (
            <RecordTable
              rows={d.data}
              rowKey={(x) => x.variantId}
              columns={[
                { header: t('rest.ingredient'), cell: (x) => <>{x.name} <Serial className="text-gold">{x.sku}</Serial></> },
                { header: t('rep.expected'), num: true, cell: (x) => `${qty(x.quantity.expected)} ${x.unit}` },
                { header: t('rep.waste'), num: true, cell: (x) => `${qty(sumDecimal([x.quantity.preparedWaste, x.quantity.otherWaste]))} ${x.unit}` },
                { header: t('rep.countVariance'), num: true, cell: (x) => `${signed(x.quantity.countVariance)} ${x.unit}` },
                { header: t('rep.actual'), num: true, cell: (x) => <b>{qty(x.quantity.actual)} {x.unit}</b> },
                { header: t('rep.variance'), num: true, cell: (x) => <span className={over(x.quantity.variance)}>{signed(x.quantity.variance)}{x.variancePct !== null ? ` (${x.variancePct}%)` : ''}</span> },
                { header: t('rep.varianceValue'), num: true, cell: (x) => <span className={`money ${over(x.value.variance)}`}>{signed(x.value.variance, peso)}</span> },
              ]}
              stacked={{
                title: (x) => x.name,
                meta: (x) => <Serial>{t('rep.expected')} {qty(x.quantity.expected)} {x.unit} · {t('rep.actual')} {qty(x.quantity.actual)} {x.unit}</Serial>,
                figure: (x) => (
                  <span className="block">
                    <span className={`money block font-semibold ${over(x.value.variance)}`}>{signed(x.value.variance, peso)}</span>
                    <span className="text-[0.75rem] text-muted">{x.variancePct !== null ? `${x.variancePct}%` : '—'}</span>
                  </span>
                ),
              }}
            />
          ) : (
            <Empty>{t('rep.noUsage')}</Empty>
          )}
        </Note>
        <p className="mt-2 text-[0.8125rem] text-muted">{t('rep.usageNote')}</p>
      </section>
    </ReportsChrome>
  );
}
