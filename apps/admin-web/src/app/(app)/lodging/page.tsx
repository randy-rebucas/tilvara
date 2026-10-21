import { Plus } from 'lucide-react';
import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { apiOrNull, type StayRow } from '@/lib/api';
import { addDays } from '@/lib/calendar';
import { formatDate } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { NightAuditButton } from './forms';
import { branchToday, LodgingChrome, lodgingAccess, lodgingBranch, nightsBetween, StayTag } from './chrome';

export const metadata = { title: 'Front desk' };

/**
 * The front desk (ADR-0023 §4): today's arrivals (bookings due, the late ones first), the guests in
 * house and today's departures, each linking to its stay. Bookings and the night audit start here.
 */
export default async function FrontDeskPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await lodgingBranch(sp.branch);
  const { canManage } = await lodgingAccess();
  const today = branchToday(branch);

  const [booked, inHouse] = branch
    ? await Promise.all([
        // Bookings that should have arrived by today (a late one is a possible no-show).
        apiOrNull<{ data: StayRow[] }>(`/stays?${new URLSearchParams({ branchId: branch.id, status: 'BOOKED', from: addDays(today, -31), to: addDays(today, 1), limit: '200' })}`),
        apiOrNull<{ data: StayRow[] }>(`/stays?${new URLSearchParams({ branchId: branch.id, status: 'IN_HOUSE', limit: '200' })}`),
      ])
    : [null, null];
  const byRoom = (a: StayRow, b: StayRow) => (a.room?.number ?? '').localeCompare(b.room?.number ?? '', undefined, { numeric: true });
  const arrivals = (booked?.data ?? []).filter((s) => s.arrivalDate <= today).sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate) || byRoom(a, b));
  const staying = (inHouse?.data ?? []).sort(byRoom);
  const departures = staying.filter((s) => s.departureDate <= today);
  const status = (s: StayRow['status']) => t(`lod.status.${s}` as MessageKey);
  const who = (s: StayRow) => s.guestDisplayName ?? '—';

  /** Amber when the desk must act: a guest due (or late) to arrive, or due to leave. */
  const tagFor = (s: StayRow, kind: 'arrive' | 'stay' | 'leave') =>
    kind === 'arrive'
      ? { due: true, label: t(s.arrivalDate < today ? 'lod.late' : 'lod.arrivesToday') }
      : s.departureDate <= today
        ? { due: true, label: t('lod.leavesToday') }
        : { due: false, label: status(s.status) };

  const table = (rows: StayRow[], kind: 'arrive' | 'stay' | 'leave') => (
    <RecordTable
      rows={rows}
      rowKey={(s) => s.id}
      columns={[
        { header: t('lod.room'), cell: (s) => <Serial className="text-ink">{s.room?.number ?? '—'} · {s.roomType?.code ?? ''}</Serial> },
        { header: t('lod.guest'), cell: (s) => <Link href={`/lodging/stays/${s.id}`} className="font-semibold underline" data-stay={s.id}>{who(s)}</Link> },
        { header: t('lod.dates'), cell: (s) => <Serial className="text-ink">{formatDate(s.arrivalDate, lang)} → {formatDate(s.departureDate, lang)} · {t('lod.nightsN', { n: nightsBetween(s.arrivalDate, s.departureDate) })}</Serial> },
        { header: t('lod.guests'), num: true, cell: (s) => <Serial className="text-ink">{s.adults + s.children}</Serial> },
        { header: t('common.status'), cell: (s) => <StayTag status={s.status} {...tagFor(s, kind)} /> },
      ]}
      stacked={{
        title: (s) => <Link href={`/lodging/stays/${s.id}`} className="underline">{who(s)}</Link>,
        meta: (s) => <Serial>{t('lod.room')} {s.room?.number ?? '—'} · {formatDate(s.arrivalDate, lang)} → {formatDate(s.departureDate, lang)}</Serial>,
        figure: (s) => <StayTag status={s.status} {...tagFor(s, kind)} />,
      }}
    />
  );

  return (
    <LodgingChrome
      tab="desk"
      branches={branches}
      branch={branch}
      actions={canManage && branch ? (
        <Link href={`/lodging/new?branch=${branch.id}`} className="btn btn-primary"><Plus aria-hidden className="size-4" /> {t('lod.newBooking')}</Link>
      ) : undefined}
    >
      {!booked || !inHouse ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          <Note className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4" denom="violet">
            <Figure label={t('lod.arrivals')}>{arrivals.length}</Figure>
            <Figure label={t('lod.inHouse')}>{staying.length}</Figure>
            <Figure label={t('lod.departures')}>{departures.length}</Figure>
            <div className="min-w-0">
              <div className="text-[0.8125rem] text-muted">{t('lod.today')}</div>
              <div className="mt-1 font-semibold" data-testid="desk-today">{formatDate(today, lang)}</div>
            </div>
          </Note>

          <section aria-labelledby="arrivals">
            <h2 id="arrivals" className="section-title mb-3">{t('lod.arrivals')}</h2>
            <Note className="pr-2">{arrivals.length ? table(arrivals, 'arrive') : <Empty>{t('lod.noArrivals')}</Empty>}</Note>
          </section>
          <section aria-labelledby="departures">
            <h2 id="departures" className="section-title mb-3">{t('lod.departures')}</h2>
            <Note className="pr-2">{departures.length ? table(departures, 'leave') : <Empty>{t('lod.noDepartures')}</Empty>}</Note>
          </section>
          <section aria-labelledby="in-house">
            <h2 id="in-house" className="section-title mb-3">{t('lod.inHouse')}</h2>
            <Note className="pr-2">{staying.length ? table(staying, 'stay') : <Empty>{t('lod.noneInHouse')}</Empty>}</Note>
          </section>

          {canManage && branch && (
            <section aria-labelledby="night-audit" className="flex flex-col gap-2">
              <h2 id="night-audit" className="section-title">{t('lod.nightAudit')}</h2>
              <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('lod.nightAuditHint')}</p>
              <NightAuditButton branchId={branch.id} />
            </section>
          )}
        </>
      )}
    </LodgingChrome>
  );
}
