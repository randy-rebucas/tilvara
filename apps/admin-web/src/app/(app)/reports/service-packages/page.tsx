import Link from 'next/link';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { ServicePackagesReport } from '@/lib/api';
import { formatDate, peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Service packages' };

/**
 * Service packages (ADR-0022 §6): value sold, used (turned into sales), refunded and restored at the
 * branch in the period; what the legal entity still owes at the end of it, against Prepaid service
 * packages in the books; and the customers' open packages.
 */
export default async function ServicePackagesPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<ServicePackagesReport>(`/reports/service-packages?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const d = r?.data;
  return (
    <ReportsChrome tab="servicePackages" scope={scope} error={r?.error}>
      <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('rep.pkgLede')}</p>
      {d && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure label={t('rep.pkgSold')}>{peso(d.sold)}</Figure>
            <Figure label={t('rep.pkgUsed')}>{peso(d.used)}</Figure>
            <Figure label={t('rep.pkgRefunded')}>{peso(d.refunded)}</Figure>
            <Figure label={t('rep.pkgOwed')}>{peso(d.owed)}</Figure>
          </div>
          <Serial className="block">
            {t('rep.pkgCount')} {d.packagesSold} · {t('rep.pkgSessionsSold')} {d.sessionsSold} · {t('rep.pkgSessionsUsed')} {d.sessionsUsed} · {t('rep.pkgRestored')} {peso(d.restored)}
          </Serial>
          {d.ledger === d.owed ? (
            <p className="text-[0.875rem] text-muted">{t('rep.pkgLedgerOk')}</p>
          ) : (
            <Callout tone="error">{t('rep.pkgLedgerOff', { v: peso(d.ledger) })}</Callout>
          )}
        </>
      )}
      <section aria-labelledby="open-packages">
        <h2 id="open-packages" className="section-title mb-3">{t('rep.pkgOpen')}</h2>
        <Note denom="blue" className="pr-2">
          {d && d.open.length > 0 ? (
            <RecordTable
              rows={d.open}
              rowKey={(o) => o.id}
              columns={[
                { header: t('doc.customer'), cell: (o) => <Link href={`/customers/${o.customerId}`} className="font-semibold underline">{o.customer}</Link> },
                { header: t('rep.pkgName'), cell: (o) => o.name },
                { header: t('rep.pkgExpires'), cell: (o) => (o.expiresOn ? formatDate(o.expiresOn, lang) : t('cpkg.noExpiry')) },
                { header: t('rep.pkgSessionsLeft'), num: true, cell: (o) => o.sessionsLeft },
                { header: t('rep.pkgValueLeft'), num: true, cell: (o) => <b className="money">{peso(o.valueLeft)}</b> },
              ]}
              stacked={{
                title: (o) => <Link href={`/customers/${o.customerId}`} className="underline">{o.customer}</Link>,
                meta: (o) => <Serial>{o.name} · {t('rep.pkgSessionsLeft')} {o.sessionsLeft}{o.expiresOn && ` · ${formatDate(o.expiresOn, lang)}`}</Serial>,
                figure: (o) => <span className="money font-semibold">{peso(o.valueLeft)}</span>,
              }}
            />
          ) : (
            <Empty>{t('rep.pkgNoneOpen')}</Empty>
          )}
        </Note>
      </section>
    </ReportsChrome>
  );
}
