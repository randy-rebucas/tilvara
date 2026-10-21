import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { KitchenVoids } from '@/lib/api';
import { formatDateTime, peso, qty } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.kitchen-voids');

/** Items voided after they were sent to the kitchen: how far cooking got, and what was thrown away (ADR-0014 §10). */
export default async function KitchenVoidsPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<KitchenVoids>(`/reports/kitchen-voids?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const d = r?.data;
  const where = (v: KitchenVoids['data'][number]) => `${v.order.tableCode ?? t('rest.takeaway')} · #${v.order.orderNumber}`;

  return (
    <ReportsChrome tab="voids" scope={scope} error={r?.error}>
      {d && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label={t('rep.voids')}>{d.totals.voids}</Figure>
          <Figure label={t('rep.cookingStarted')}>{d.totals.cookingStarted}</Figure>
          <Figure label={t('rep.wasted')}>{d.totals.wasted}</Figure>
          <Figure label={t('rep.wasteValue')}>{peso(d.totals.wasteValue)}</Figure>
        </div>
      )}
      <section>
        <p className="mb-3 max-w-[68ch] text-[0.875rem] text-muted">{t('rep.voidsLede')}</p>
        <Note className="pr-2">
          {d && d.data.length > 0 ? (
            <RecordTable
              rows={d.data}
              rowKey={(v) => v.orderItemId}
              columns={[
                { header: t('rep.when'), cell: (v) => formatDateTime(v.voidedAt, lang) },
                { header: t('rep.where'), cell: (v) => <Serial className="text-ink">{where(v)}</Serial> },
                { header: t('common.item'), cell: (v) => <>{qty(v.quantity)}× {v.name}{v.modifiers.length > 0 && <span className="block text-[0.8125rem] text-muted">{v.modifiers.join(' · ')}</span>}</> },
                { header: t('rep.stage'), cell: (v) => <span className={`tag ${v.cookingStarted ? 'tag-warn' : ''}`}>{t(`rep.stage.${v.stage}`)}</span> },
                { header: t('common.reason'), cell: (v) => <>{v.reason}<span className="block text-[0.8125rem] text-muted">{v.voidedBy.displayName}</span></> },
                {
                  header: t('rep.wasteValue'),
                  num: true,
                  cell: (v) => (v.wasted && v.wasteAdjustmentId ? <Link className="money text-blue" href={`/inventory/adjustments/${v.wasteAdjustmentId}`}>{peso(v.wasteValue)}</Link> : <span className="text-muted">{t('rep.notWasted')}</span>),
                },
              ]}
              stacked={{
                title: (v) => `${qty(v.quantity)}× ${v.name}`,
                meta: (v) => <Serial>{where(v)} · {t(`rep.stage.${v.stage}`)} · {v.reason}</Serial>,
                figure: (v) => (v.wasted ? <span className="money font-semibold">{peso(v.wasteValue)}</span> : <span className="text-[0.75rem] text-muted">{t('rep.notWasted')}</span>),
              }}
            />
          ) : (
            <Empty>{t('rep.noVoids')}</Empty>
          )}
        </Note>
      </section>
      {d && d.data.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section>
            <h2 className="section-title mb-2">{t('rep.byReason')}</h2>
            <Note className="pr-2">
              <RecordTable
                rows={d.byReason}
                rowKey={(x) => x.reason}
                columns={[
                  { header: t('common.reason'), cell: (x) => x.reason },
                  { header: t('rep.voids'), num: true, cell: (x) => x.voids },
                  { header: t('rep.wasted'), num: true, cell: (x) => x.wasted },
                  { header: t('rep.wasteValue'), num: true, cell: (x) => <span className="money">{peso(x.wasteValue)}</span> },
                ]}
                stacked={{ title: (x) => x.reason, meta: (x) => <Serial>{x.voids} · {t('rep.wasted')} {x.wasted}</Serial>, figure: (x) => <span className="money">{peso(x.wasteValue)}</span> }}
              />
            </Note>
          </section>
          <section>
            <h2 className="section-title mb-2">{t('rep.byPerson')}</h2>
            <Note className="pr-2">
              <RecordTable
                rows={d.byUser}
                rowKey={(x) => x.userId}
                columns={[
                  { header: t('rep.person'), cell: (x) => x.displayName ?? '—' },
                  { header: t('rep.voids'), num: true, cell: (x) => x.voids },
                  { header: t('rep.cookingStarted'), num: true, cell: (x) => x.cookingStarted },
                  { header: t('rep.wasteValue'), num: true, cell: (x) => <span className="money">{peso(x.wasteValue)}</span> },
                ]}
                stacked={{ title: (x) => x.displayName ?? '—', meta: (x) => <Serial>{x.voids} · {t('rep.cookingStarted')} {x.cookingStarted}</Serial>, figure: (x) => <span className="money">{peso(x.wasteValue)}</span> }}
              />
            </Note>
          </section>
        </div>
      )}
    </ReportsChrome>
  );
}
