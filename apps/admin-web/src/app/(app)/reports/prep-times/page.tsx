import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { PrepTimes } from '@/lib/api';
import { duration } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Prep times' };

/** Kitchen preparation times per station: sent → ready, the wait before cooking, and ready → served. */
export default async function PrepTimesPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<PrepTimes>(`/reports/prep-times?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const d = r?.data;
  const o = d?.overall;

  return (
    <ReportsChrome tab="prep" scope={scope} error={r?.error}>
      <section>
        <p className="mb-3 max-w-[68ch] text-[0.875rem] text-muted">{t('rep.prepLede')}</p>
        <Note className="pr-2">
          {d && d.stations.length > 0 ? (
            <RecordTable
              rows={d.stations}
              rowKey={(s) => s.stationId}
              columns={[
                { header: t('rest.station'), cell: (s) => <>{s.name} <Serial className="text-violet">{s.code}</Serial></> },
                { header: t('rep.itemsTimed'), num: true, cell: (s) => `${s.timed} / ${s.items}` },
                { header: t('rep.average'), num: true, cell: (s) => <b className="money">{duration(s.prepSeconds.average)}</b> },
                { header: t('rep.median'), num: true, cell: (s) => <span className="money">{duration(s.prepSeconds.median)}</span> },
                { header: t('rep.p90'), num: true, cell: (s) => <span className="money">{duration(s.prepSeconds.p90)}</span> },
                { header: t('rep.longest'), num: true, cell: (s) => <span className="money">{duration(s.prepSeconds.max)}</span> },
                { header: t('rep.wait'), num: true, cell: (s) => <span className="money">{duration(s.waitSeconds)}</span> },
                { header: t('rep.pass'), num: true, cell: (s) => <span className="money">{duration(s.passSeconds)}</span> },
              ]}
              stacked={{
                title: (s) => s.name,
                meta: (s) => <Serial>{s.timed} / {s.items} · {t('rep.p90')} {duration(s.prepSeconds.p90)} · {t('rep.longest')} {duration(s.prepSeconds.max)}</Serial>,
                figure: (s) => <span className="money font-semibold">{duration(s.prepSeconds.average)}</span>,
              }}
              foot={
                o
                  ? {
                      cells: [t('rep.allStations'), `${o.timed} / ${o.items}`, duration(o.prepSeconds.average), duration(o.prepSeconds.median), duration(o.prepSeconds.p90), duration(o.prepSeconds.max), duration(o.waitSeconds), duration(o.passSeconds)],
                      title: t('rep.allStations'),
                      figure: <span className="money">{duration(o.prepSeconds.average)}</span>,
                    }
                  : undefined
              }
            />
          ) : (
            <Empty>{t('rep.noTickets')}</Empty>
          )}
        </Note>
        <p className="mt-2 text-[0.8125rem] text-muted">{t('rep.prepNote')}</p>
      </section>
    </ReportsChrome>
  );
}
