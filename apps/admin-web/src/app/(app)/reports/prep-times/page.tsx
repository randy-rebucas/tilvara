import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { PrepFigures, PrepTimes, PrepTimesGrouped } from '@/lib/api';
import { duration } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Prep times' };

const BY = ['station', 'hour', 'item'] as const;
type By = (typeof BY)[number];

/** Kitchen preparation times per station, local hour fired or menu item: sent → ready, the wait before cooking, and ready → served. */
export default async function PrepTimesPage({ searchParams }: { searchParams: Promise<ReportQuery & { by?: string }> }) {
  const { t } = await getT();
  const sp = await searchParams;
  const by: By = BY.includes(sp.by as By) ? (sp.by as By) : 'station';
  const scope = await reportScope(sp);
  const path = scope.branch ? `/reports/prep-times?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}&by=${by}` : null;
  const r = path ? await loadReport<PrepTimes | PrepTimesGrouped>(path) : null;
  const href = (b: By) => `/reports/prep-times?${new URLSearchParams({ ...(scope.branch && { branch: scope.branch.id }), from: scope.from, to: scope.to, by: b })}`;
  const figures = <T extends PrepFigures>() => [
    { header: t('rep.itemsTimed'), num: true, cell: (s: T) => `${s.timed} / ${s.items}` },
    { header: t('rep.average'), num: true, cell: (s: T) => <b className="money">{duration(s.prepSeconds.average)}</b> },
    { header: t('rep.median'), num: true, cell: (s: T) => <span className="money">{duration(s.prepSeconds.median)}</span> },
    { header: t('rep.p90'), num: true, cell: (s: T) => <span className="money">{duration(s.prepSeconds.p90)}</span> },
    { header: t('rep.longest'), num: true, cell: (s: T) => <span className="money">{duration(s.prepSeconds.max)}</span> },
    { header: t('rep.wait'), num: true, cell: (s: T) => <span className="money">{duration(s.waitSeconds)}</span> },
    { header: t('rep.pass'), num: true, cell: (s: T) => <span className="money">{duration(s.passSeconds)}</span> },
  ];
  const hour = (h: number) => `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`;

  return (
    <ReportsChrome tab="prep" scope={scope} error={r?.error}>
      <section>
        <p className="mb-3 max-w-[68ch] text-[0.875rem] text-muted">{t('rep.prepLede')}</p>
        <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label={t('rep.prepBy')}>
          {BY.map((b) => (
            <Link key={b} href={href(b)} className="btn h-9" aria-current={b === by ? 'true' : undefined} aria-pressed={b === by}>
              {t(`rep.prepBy.${b}`)}
            </Link>
          ))}
        </div>
        <Note className="pr-2">
          {by === 'station' && r?.data && 'stations' in r.data && r.data.stations.length > 0 ? (
            <RecordTable
              rows={r.data.stations}
              rowKey={(s) => s.stationId}
              columns={[{ header: t('rest.station'), cell: (s) => <>{s.name} <Serial className="text-violet">{s.code}</Serial></> }, ...figures<PrepTimes['stations'][number]>()]}
              stacked={{
                title: (s) => s.name,
                meta: (s) => <Serial>{s.timed} / {s.items} · {t('rep.p90')} {duration(s.prepSeconds.p90)} · {t('rep.longest')} {duration(s.prepSeconds.max)}</Serial>,
                figure: (s) => <span className="money font-semibold">{duration(s.prepSeconds.average)}</span>,
              }}
              foot={(() => {
                const o = r.data.overall;
                return o
                  ? {
                      cells: [t('rep.allStations'), `${o.timed} / ${o.items}`, duration(o.prepSeconds.average), duration(o.prepSeconds.median), duration(o.prepSeconds.p90), duration(o.prepSeconds.max), duration(o.waitSeconds), duration(o.passSeconds)],
                      title: t('rep.allStations'),
                      figure: <span className="money">{duration(o.prepSeconds.average)}</span>,
                    }
                  : undefined;
              })()}
            />
          ) : by !== 'station' && r?.data && 'groups' in r.data && r.data.groups.length > 0 ? (
            <RecordTable
              rows={r.data.groups}
              rowKey={(g) => g.key}
              columns={[
                { header: by === 'hour' ? t('rep.prepBy.hour') : t('common.item'), cell: (g) => (by === 'hour' ? <Serial className="text-ink">{hour(g.hour!)}</Serial> : g.name) },
                ...figures<PrepTimesGrouped['groups'][number]>(),
              ]}
              stacked={{
                title: (g) => (by === 'hour' ? hour(g.hour!) : g.name),
                meta: (g) => <Serial>{g.timed} / {g.items} · {t('rep.p90')} {duration(g.prepSeconds.p90)} · {t('rep.longest')} {duration(g.prepSeconds.max)}</Serial>,
                figure: (g) => <span className="money font-semibold">{duration(g.prepSeconds.average)}</span>,
              }}
            />
          ) : (
            <Empty>{t('rep.noTickets')}</Empty>
          )}
        </Note>
        <p className="mt-2 text-[0.8125rem] text-muted">{by === 'station' ? t('rep.prepNote') : by === 'hour' ? t('rep.prepHourNote') : t('rep.prepItemNote')}</p>
      </section>
    </ReportsChrome>
  );
}
