import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { ByAttribute } from '@/lib/api';
import { peso, qty, sumDecimal } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.sizes-colours');

/** Sales lines totalled by the value of one attribute of the item sold (ADR-0021 §2), e.g. by Size. */
export default async function SizesColoursPage({ searchParams }: { searchParams: Promise<ReportQuery & { attribute?: string }> }) {
  const { t } = await getT();
  const q = await searchParams;
  const scope = await reportScope(q);
  const wanted = q.attribute?.trim().slice(0, 50) || undefined;
  const r = scope.branch
    ? await loadReport<ByAttribute>(`/reports/by-attribute?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}${wanted ? `&attribute=${encodeURIComponent(wanted)}` : ''}`)
    : null;
  const report = r?.data;
  const rows = report?.data ?? [];
  const attribute = report?.attribute ?? wanted;
  const total = (k: 'netSales' | 'revenueExVat') => sumDecimal(rows.map((x) => x[k]));
  const keep = (a: string) =>
    `/reports/sizes-colours?${new URLSearchParams({ ...(scope.branch && { branch: scope.branch.id }), from: scope.from, to: scope.to, attribute: a })}`;

  return (
    <ReportsChrome tab="attributes" scope={scope} error={r?.error} extra={attribute ? { attribute } : {}}>
      {report && report.attributes.length > 0 && (
        <nav aria-label={t('rep.attribute')} className="flex flex-wrap items-center gap-1.5 print:hidden">
          <span className="mr-1 text-[0.875rem] text-muted">{t('rep.attribute')}:</span>
          {report.attributes.map((a) => (
            <Link key={a} href={keep(a)} aria-current={a === attribute ? 'true' : undefined} className={`tag h-8! px-3! text-[0.8125rem]! ${a === attribute ? 'border-blue! text-ink!' : 'hover:text-ink'}`}>
              {a}
            </Link>
          ))}
        </nav>
      )}
      <Note denom="blue" className="pr-2">
        {rows.length > 0 && attribute ? (
          <RecordTable
            rows={rows}
            rowKey={(x) => x.value ?? '∅'}
            columns={[
              { header: attribute, cell: (x) => (x.value === null ? <span className="text-muted">{t('rep.attrNone', { attribute })}</span> : <b>{x.value}</b>) },
              { header: t('rep.qtySold'), num: true, cell: (x) => qty(x.quantitySold) },
              { header: t('rep.qtyReturned'), num: true, cell: (x) => qty(x.quantityReturned) },
              { header: t('csv.netQty'), num: true, cell: (x) => qty(x.netQuantity) },
              { header: t('rep.netSales'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.netSales)}</span> },
              { header: t('rep.revenueExVat'), num: true, cell: (x) => <span className="money">{peso(x.revenueExVat)}</span> },
            ]}
            stacked={{
              title: (x) => x.value ?? t('rep.attrNone', { attribute }),
              meta: (x) => <Serial>{t('csv.netQty')} {qty(x.netQuantity)} · {t('rep.revenueExVat')} {peso(x.revenueExVat)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.netSales)}</span>,
            }}
            foot={{
              cells: [t('common.total'), '', '', '', <span key="n" className="money">{peso(total('netSales'))}</span>, <span key="r" className="money">{peso(total('revenueExVat'))}</span>],
              title: t('rep.netSales'),
              figure: <span className="money">{peso(total('netSales'))}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noAttributes')}</Empty>
        )}
      </Note>
    </ReportsChrome>
  );
}
