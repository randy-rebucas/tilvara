import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { PrintButton } from '@/components/print-button';
import { RecordTable } from '@/components/record-table';
import { SubNav } from '@/components/scope';
import { apiOrNull, type TripRow } from '@/lib/api';
import { isDate } from '@/lib/calendar';
import { formatDate, formatDateTime, peso, signOf, todayManila } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { LaundryChrome, laundryAccess, laundryBranch } from '../chrome';
import { TripActions } from '../jobs/[id]/forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('laundry.trips');

const FILTERS = ['SCHEDULED', 'all', 'DONE', 'FAILED'] as const;

/**
 * The day's route (ADR-0024 §8): pickups and deliveries of the branch for a day, with addresses,
 * windows, the rider and what is left to collect at the door. Printable for the rider.
 */
export default async function TripsPage({ searchParams }: { searchParams: Promise<{ branch?: string; date?: string; status?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await laundryBranch(sp.branch);
  const { canManage, canDeliver } = await laundryAccess();
  const date = isDate(sp.date) ? sp.date : todayManila();
  const filter = (FILTERS as readonly string[]).includes(sp.status ?? '') ? (sp.status as (typeof FILTERS)[number]) : 'SCHEDULED';
  const trips = branch
    ? await apiOrNull<{ data: TripRow[] }>(`/laundry/trips?${new URLSearchParams({ branchId: branch.id, date, ...(filter !== 'all' && { status: filter }) })}`)
    : null;
  const href = (f: string) => `/laundry/trips?${new URLSearchParams({ branch: branch?.id ?? '', date, ...(f !== 'SCHEDULED' && { status: f }) })}`;

  return (
    <LaundryChrome tab="trips" branches={branches} branch={branch} extra={{ date, ...(filter !== 'SCHEDULED' && { status: filter }) }}>
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <form method="get" action="/laundry/trips" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="branch" value={branch?.id ?? ''} />
          {filter !== 'SCHEDULED' && <input type="hidden" name="status" value={filter} />}
          <div className="field">
            <label htmlFor="trip-date">{t('common.date')}</label>
            <input id="trip-date" name="date" type="date" className="input" defaultValue={date} />
          </div>
          <button className="btn">{t('common.show')}</button>
        </form>
        <PrintButton />
      </div>
      <p className="hidden text-[0.9375rem] print:block"><b>{t('lau.routeOf', { date: formatDate(date, lang) })}</b> · {branch?.name}</p>
      <div className="print:hidden">
        <SubNav level={2} label={t('lau.filterLabel')} active={filter} items={FILTERS.map((f) => ({ key: f, href: href(f), label: f === 'all' ? t('lau.filter.all') : t(`lau.tripStatus.${f}` as MessageKey) }))} />
      </div>
      {!trips ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <Note className="pr-2">
          {trips.data.length ? (
            <RecordTable
              rows={trips.data}
              rowKey={(x) => x.id}
              columns={[
                { header: t('lau.window'), cell: (x) => <Serial className="text-ink">{x.windowStart ? formatDateTime(x.windowStart, lang) : '—'}{x.windowEnd && ` – ${formatDateTime(x.windowEnd, lang)}`}</Serial> },
                { header: t('lau.tripKind'), cell: (x) => <span className="tag" data-trip-kind={x.kind}>{t(`lau.trip.${x.kind}` as MessageKey)}</span> },
                {
                  header: t('lau.customer'),
                  cell: (x) => (
                    <span>
                      <Link href={`/laundry/jobs/${x.jobOrderId}`} className="serial font-semibold underline">{x.jobReference}</Link> · {x.contactName ?? x.customer ?? '—'}
                      <span className="block text-[0.875rem]">{x.address}</span>
                      <span className="block text-[0.8125rem] text-muted">{x.contactPhone}{x.riderName && ` · ${t('lau.rider')}: ${x.riderName}`}{x.notes && ` · ${x.notes}`}</span>
                    </span>
                  ),
                },
                { header: t('lau.bags'), num: true, cell: (x) => <Serial className="text-ink">{x.bagCount}</Serial> },
                { header: t('lau.toCollect'), num: true, cell: (x) => <span className="money">{x.kind === 'DELIVERY' ? peso(signOf(x.balance) > 0 ? x.balance : '0') : '—'}</span> },
                {
                  header: t('common.status'),
                  cell: (x) => (
                    <div className="flex flex-col items-start gap-1.5">
                      <span className="tag" data-trip-status={x.status}>{t(`lau.tripStatus.${x.status}` as MessageKey)}</span>
                      {(canManage || canDeliver) && <div className="print:hidden"><TripActions trip={{ id: x.id, kind: x.kind, status: x.status, jobStatus: x.jobStatus }} /></div>}
                    </div>
                  ),
                },
              ]}
              stacked={{
                title: (x) => <><Link href={`/laundry/jobs/${x.jobOrderId}`} className="underline">{x.jobReference}</Link> · {t(`lau.trip.${x.kind}` as MessageKey)}</>,
                meta: (x) => (
                  <>
                    <span className="block text-[0.875rem]">{x.address}</span>
                    <Serial>{x.contactPhone}{x.windowStart && ` · ${formatDateTime(x.windowStart, lang)}`}</Serial>
                    {(canManage || canDeliver) && <div className="mt-2"><TripActions trip={{ id: x.id, kind: x.kind, status: x.status, jobStatus: x.jobStatus }} /></div>}
                  </>
                ),
                figure: (x) => <span className="tag">{t(`lau.tripStatus.${x.status}` as MessageKey)}</span>,
              }}
            />
          ) : (
            <Empty>{t('lau.noTripsDay')}</Empty>
          )}
        </Note>
      )}
      <p className="max-w-[68ch] text-[0.8125rem] text-muted print:hidden">{t('lau.tripsHint')}</p>
    </LaundryChrome>
  );
}
