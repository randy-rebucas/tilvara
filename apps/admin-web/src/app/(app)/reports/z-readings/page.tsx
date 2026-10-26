import { Fragment } from 'react';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { ScopePicker } from '@/components/scope';
import { api, apiOrNull, type Me, type Register, type ZReading } from '@/lib/api';
import { peso } from '@/lib/format';
import { tenderLabel } from '@/lib/tenders';
import { getT } from '@/i18n/server';
import { ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { TakeZReading } from './take';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.z-readings');

/** End-of-day readings per register (fiscal gate G2; not BIR-accredited), with the accumulated grand total. */
export default async function ZReadingsPage({ searchParams }: { searchParams: Promise<ReportQuery & { register?: string }> }) {
  const { t } = await getT();
  const sp = await searchParams;
  const scope = await reportScope(sp);
  const [me, regs] = await Promise.all([api<Me>('/me'), apiOrNull<{ data: Register[] }>('/registers')]);
  const registers = (regs?.data ?? []).filter((r) => r.branchId === scope.branch?.id && !r.archivedAt);
  const register = registers.find((r) => r.id === sp.register) ?? registers[0];
  const list = register ? await apiOrNull<{ data: ZReading[] }>(`/registers/${register.id}/z-readings`) : null;
  const rows = list?.data ?? [];
  const canTake = me.activeTenant?.permissions.includes('cash.reconcile') ?? false;
  const latest = rows[0];
  const q = (id: string) => `/reports/z-readings?${new URLSearchParams({ ...(scope.branch && { branch: scope.branch.id }), register: id, from: scope.from, to: scope.to })}`;

  return (
    <ReportsChrome tab="z" scope={scope}>
      <section className="flex flex-col gap-4">
        <Callout tone="info">{t('z.notAccredited')}</Callout>
        <div className="print:hidden">
          <ScopePicker label={t('z.register')} items={registers} selected={register?.id} href={q} />
        </div>
        {!register ? (
          <Note><Empty>{t('z.noRegister')}</Empty></Note>
        ) : (
          <>
            {canTake && <div className="print:hidden"><TakeZReading registerId={register.id} today={scope.to} /></div>}
            {latest && (
              <Note denom="blue" className="px-5 py-4 pr-8">
                <div className="grid gap-1" data-testid="z-latest">
                <p className="font-semibold">{t('z.latest', { n: latest.zNumber, day: latest.businessDay })}</p>
                <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-[0.9375rem] sm:max-w-[520px]">
                  <dt>{t('z.numbers')}</dt><dd className="money text-right">{latest.firstSaleNumber ?? '—'} – {latest.lastSaleNumber ?? '—'}</dd>
                  <dt>{t('z.gross')}</dt><dd className="money text-right">{peso(latest.gross)}</dd>
                  <dt>{t('z.discounts')}</dt><dd className="money text-right">{peso(latest.discount)}</dd>
                  {Object.entries(latest.statutory).map(([k, v]) => (
                    <Fragment key={k}><dt>{t('z.statutory', { scheme: k })}</dt><dd className="money text-right">{peso(v)}</dd></Fragment>
                  ))}
                  <dt>{t('z.vatable')}</dt><dd className="money text-right">{peso(latest.vatableSales)}</dd>
                  <dt>{t('z.vat')}</dt><dd className="money text-right">{peso(latest.vatAmount)}</dd>
                  <dt>{t('z.exempt')}</dt><dd className="money text-right">{peso(latest.vatExemptSales)}</dd>
                  <dt>{t('z.zero')}</dt><dd className="money text-right">{peso(latest.zeroRatedSales)}</dd>
                  <dt>{t('z.sales')}</dt><dd className="money text-right">{peso(latest.salesAmount)}</dd>
                  <dt>{t('z.returns', { n: latest.returnsCount })}</dt><dd className="money text-right">−{peso(latest.returnsAmount)}</dd>
                  <dt>{t('z.voids', { n: latest.voidsCount })}</dt><dd className="money text-right">−{peso(latest.voidsAmount)}</dd>
                  <dt className="font-semibold">{t('z.net')}</dt><dd className="money text-right font-semibold">{peso(latest.netAmount)}</dd>
                  {Object.entries(latest.tenders).map(([k, v]) => (
                    <Fragment key={k}><dt>{t('z.tender', { method: tenderLabel(t, k) })}</dt><dd className="money text-right">{peso(v)}</dd></Fragment>
                  ))}
                  <dt>{t('z.previousGt')}</dt><dd className="money text-right">{peso(latest.previousGrandTotal)}</dd>
                  <dt className="font-semibold">{t('z.grandTotal')}</dt><dd className="money text-right font-semibold">{peso(latest.grandTotal)}</dd>
                  <dt>{t('z.resetCounter')}</dt><dd className="money text-right">{latest.resetCounter}</dd>
                </dl>
                </div>
              </Note>
            )}
            <Note className="pr-2">
              {rows.length > 0 ? (
                <RecordTable
                  rows={rows}
                  rowKey={(z) => z.id}
                  columns={[
                    { header: t('z.number'), cell: (z) => <Serial className="text-ink">Z-{String(z.zNumber).padStart(4, '0')}</Serial> },
                    { header: t('common.date'), cell: (z) => z.businessDay },
                    { header: t('z.sales'), num: true, cell: (z) => <span className="money">{peso(z.salesAmount)}</span> },
                    { header: t('z.net'), num: true, cell: (z) => <span className="money">{peso(z.netAmount)}</span> },
                    { header: t('z.grandTotal'), num: true, cell: (z) => <b className="money">{peso(z.grandTotal)}</b> },
                  ]}
                  stacked={{
                    title: (z) => `Z-${String(z.zNumber).padStart(4, '0')} · ${z.businessDay}`,
                    meta: (z) => <Serial>{t('z.net')} {peso(z.netAmount)}</Serial>,
                    figure: (z) => <span className="money font-semibold">{peso(z.grandTotal)}</span>,
                  }}
                />
              ) : (
                <Empty>{t('z.none')}</Empty>
              )}
            </Note>
          </>
        )}
      </section>
    </ReportsChrome>
  );
}
