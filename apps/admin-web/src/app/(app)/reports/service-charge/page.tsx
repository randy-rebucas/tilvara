import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { ServiceChargeReport } from '@/lib/api';
import { formatDate, peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Service charge' };

/**
 * Service charge collected for distribution to covered staff (RA 11360; DOLE): charged − given back
 * by returns, ex VAT, per day, checked against the liability in the books.
 */
export default async function ServiceChargePage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<ServiceChargeReport>(`/reports/service-charge?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const d = r?.data;

  return (
    <ReportsChrome tab="charge" scope={scope} error={r?.error}>
      {d && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure label={t('rep.distributable')}>{peso(d.distributable)}</Figure>
            <Figure label={t('rep.charged')}>{peso(d.totals.charged.amountDue)}</Figure>
            <Figure label={t('rep.returned')}>{peso(d.totals.returned.amountDue)}</Figure>
            <Figure label={t('rep.checks')}>{d.totals.checks}</Figure>
          </div>
          {d.ledger === d.distributable ? (
            <p className="text-[0.875rem] text-muted">{t('rep.ledgerOk')}</p>
          ) : (
            <Callout tone="error">{t('rep.ledgerOff', { v: peso(d.ledger) })}</Callout>
          )}
        </>
      )}
      <Note denom="ink" className="pr-2">
        {d && d.days.length > 0 ? (
          <RecordTable
            rows={d.days}
            rowKey={(x) => x.day}
            columns={[
              { header: t('common.date'), cell: (x) => formatDate(x.day, lang) },
              { header: t('rep.checks'), num: true, cell: (x) => x.checks },
              { header: t('rep.base'), num: true, cell: (x) => <span className="money">{peso(x.base)}</span> },
              { header: t('rep.charged'), num: true, cell: (x) => <span className="money">{peso(x.charged.amountDue)}</span> },
              { header: t('rep.returned'), num: true, cell: (x) => <span className="money">{peso(x.returned.amountDue)}</span> },
              { header: t('rep.vat'), num: true, cell: (x) => <span className="money">{peso(x.net.vat)}</span> },
              { header: t('rep.netExVat'), num: true, cell: (x) => <b className="money">{peso(x.net.exVat)}</b> },
            ]}
            stacked={{
              title: (x) => formatDate(x.day, lang),
              meta: (x) => <Serial>{x.checks} · {t('rep.charged')} {peso(x.charged.amountDue)} · {t('rep.returned')} {peso(x.returned.amountDue)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.net.exVat)}</span>,
            }}
            foot={{
              cells: [t('common.total'), d.totals.checks, <span key="b" className="money">{peso(d.totals.base)}</span>, <span key="c" className="money">{peso(d.totals.charged.amountDue)}</span>, <span key="r" className="money">{peso(d.totals.returned.amountDue)}</span>, <span key="v" className="money">{peso(d.totals.net.vat)}</span>, <span key="n" className="money">{peso(d.totals.net.exVat)}</span>],
              title: t('rep.distributable'),
              figure: <span className="money">{peso(d.distributable)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noCharge')}</Empty>
        )}
      </Note>
      <Callout tone="warn">{t('rep.chargeCaveat')}</Callout>
    </ReportsChrome>
  );
}
