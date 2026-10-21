import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { Empty, Note } from '@/components/note';
import { apiOrNull, type Room, type RoomBlock, type StayRow } from '@/lib/api';
import { addDays, isDate, weekdayOf } from '@/lib/calendar';
import { formatDate } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { branchToday, LodgingChrome, lodgingAccess, lodgingBranch } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('lodging.calendar');

const NIGHTS = 14;
const SHOWN: StayRow['status'][] = ['BOOKED', 'IN_HOUSE', 'CHECKED_OUT'];

/**
 * Rooms × nights (ADR-0023 §3): each stay a bar from its arrival night to its last night, out-of-order
 * dates shaded, and a free night opening the booking form with the room and date filled. The grid
 * scrolls inside its note on a phone; the page itself never scrolls sideways.
 */
export default async function RoomCalendarPage({ searchParams }: { searchParams: Promise<{ branch?: string; from?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await lodgingBranch(sp.branch);
  const { canManage } = await lodgingAccess();
  const today = branchToday(branch);
  const from = isDate(sp.from) ? sp.from : today;
  const to = addDays(from, NIGHTS);
  const nights = Array.from({ length: NIGHTS }, (_, i) => addDays(from, i));

  const [rooms, stays, blocks] = branch
    ? await Promise.all([
        apiOrNull<{ data: Room[] }>(`/rooms?branchId=${branch.id}`),
        apiOrNull<{ data: StayRow[] }>(`/stays?${new URLSearchParams({ branchId: branch.id, from, to, limit: '200' })}`),
        apiOrNull<{ data: RoomBlock[] }>(`/room-blocks?${new URLSearchParams({ branchId: branch.id, from, to })}`),
      ])
    : [null, null, null];
  const roomList = (rooms?.data ?? []).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  const shown = (stays?.data ?? []).filter((s) => SHOWN.includes(s.status));
  /** Column (1-based, after the room column) of a date, clamped to the grid. */
  const col = (date: string) => Math.max(0, Math.min(NIGHTS, nights.indexOf(date) === -1 ? (date < from ? 0 : NIGHTS) : nights.indexOf(date))) + 2;
  const q = (extra: Record<string, string>) => `/lodging/calendar?${new URLSearchParams({ ...(branch && { branch: branch.id }), ...extra })}`;
  const template = `minmax(96px, 120px) repeat(${NIGHTS}, minmax(48px, 1fr))`;

  return (
    <LodgingChrome
      tab="calendar"
      branches={branches}
      branch={branch}
      extra={{ from }}
      actions={canManage && branch ? <Link href={`/lodging/new?branch=${branch.id}`} className="btn btn-primary"><Plus aria-hidden className="size-4" /> {t('lod.newBooking')}</Link> : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={q({ from: addDays(from, -7) })} className="btn" aria-label={t('lod.prevWeek')}><ChevronLeft aria-hidden className="size-4" /></Link>
          <Link href={q({ from: today })} className="btn" aria-current={from === today ? 'date' : undefined}>{t('appt.today')}</Link>
          <Link href={q({ from: addDays(from, 7) })} className="btn" aria-label={t('lod.nextWeek')}><ChevronRight aria-hidden className="size-4" /></Link>
          <h2 className="ml-1 text-[1.0625rem] font-semibold" data-testid="grid-range">{formatDate(from, lang)} – {formatDate(addDays(to, -1), lang)}</h2>
        </div>
        <form method="get" action="/lodging/calendar" className="flex items-end gap-2">
          {branch && <input type="hidden" name="branch" value={branch.id} />}
          <label className="sr-only" htmlFor="grid-from">{t('common.from')}</label>
          <input id="grid-from" name="from" type="date" className="input w-auto" defaultValue={from} />
          <button className="btn">{t('common.show')}</button>
        </form>
      </div>

      {!rooms || !stays ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : roomList.length === 0 ? (
        <Note><Empty action={<Link href={`/lodging/setup?branch=${branch!.id}`} className="btn">{t('lod.tab.setup')}</Link>}>{t('lod.noRooms')}</Empty></Note>
      ) : (
        <Note className="p-2 pr-3">
          <div className="overflow-x-auto" data-testid="room-grid">
            <div className="grid min-w-[760px]" style={{ gridTemplateColumns: template }}>
              <div className="border-b border-hair px-2 pb-2 text-[0.75rem] font-semibold uppercase tracking-[0.06em] text-muted">{t('lod.room')}</div>
              {nights.map((d) => (
                <div key={d} className={`border-b border-l border-hair-soft px-1 pb-2 text-center ${d === today ? 'text-blue' : ''}`}>
                  <span className="block text-[0.6875rem] uppercase text-muted">{t(`appt.weekdayShort.${weekdayOf(d)}` as MessageKey)}</span>
                  <span className="serial text-[0.8125rem] font-semibold">{d.slice(8)}</span>
                </div>
              ))}
            </div>
            {roomList.map((r) => {
              const own = shown.filter((s) => s.roomId === r.id);
              const blocked = (blocks?.data ?? []).filter((b) => b.roomId === r.id);
              const busy = (d: string) => own.some((s) => s.arrivalDate <= d && s.departureDate > d) || blocked.some((b) => b.startsOn <= d && b.endsOn > d);
              return (
                <div key={r.id} className="grid min-w-[760px] border-b border-hair-soft last:border-b-0" style={{ gridTemplateColumns: template, gridTemplateRows: '40px' }} data-room={r.number}>
                  <div className="flex min-w-0 flex-col justify-center px-2" style={{ gridColumn: 1, gridRow: 1 }}>
                    <span className="truncate font-semibold leading-tight">{r.number}</span>
                    <span className="serial truncate text-[0.6875rem] text-muted">{r.roomType?.code}</span>
                  </div>
                  {nights.map((d, i) =>
                    canManage && !busy(d) ? (
                      <Link
                        key={d}
                        href={`/lodging/new?${new URLSearchParams({ branch: branch!.id, room: r.id, arrival: d })}`}
                        aria-label={t('lod.bookRoomOn', { room: r.number, date: formatDate(d, lang) })}
                        data-night={d}
                        className="group grid place-items-center border-l border-hair-soft hover:bg-blue/5"
                        style={{ gridColumn: i + 2, gridRow: 1 }}
                      >
                        <Plus aria-hidden className="size-3.5 text-blue opacity-0 group-hover:opacity-100" />
                      </Link>
                    ) : (
                      <div key={d} className="border-l border-hair-soft" style={{ gridColumn: i + 2, gridRow: 1 }} data-night={d} />
                    ),
                  )}
                  {blocked.map((b) => (
                    <div
                      key={b.id}
                      title={b.reason}
                      className="z-10 m-1 flex items-center overflow-hidden rounded-[4px] border border-hair px-2 text-[0.75rem] text-muted"
                      style={{ gridColumn: `${col(b.startsOn)} / ${col(b.endsOn)}`, gridRow: 1, background: 'repeating-linear-gradient(135deg, var(--color-paper) 0 6px, var(--color-paper-deep) 6px 12px)' }}
                      data-block={b.id}
                    >
                      <span className="truncate">{t('lod.hk.OUT_OF_ORDER')} · {b.reason}</span>
                    </div>
                  ))}
                  {own.map((s) => (
                    <Link
                      key={s.id}
                      href={`/lodging/stays/${s.id}`}
                      data-stay={s.id}
                      title={`${s.guestDisplayName ?? '—'} · ${s.arrivalDate} → ${s.departureDate}`}
                      className={`z-10 m-1 flex items-center overflow-hidden rounded-[4px] border px-2 text-[0.8125rem] leading-tight shadow-[0_1px_2px_rgb(60_50_20/0.08)] hover:border-ink/40 ${
                        s.status === 'IN_HOUSE' ? 'border-blue bg-blue text-white' : s.status === 'BOOKED' ? 'border-blue/50 bg-[#e9eff8] text-ink' : 'border-hair bg-paper text-muted'
                      }`}
                      style={{ gridColumn: `${col(s.arrivalDate)} / ${col(s.departureDate)}`, gridRow: 1 }}
                    >
                      <span className="truncate font-semibold">{s.guestDisplayName ?? '—'}</span>
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-2 text-[0.8125rem] text-muted">
            <span><span aria-hidden className="mr-1 inline-block size-3 rounded-[2px] bg-[#e9eff8] align-[-2px] outline outline-1 outline-blue/50" />{t('lod.status.BOOKED')}</span>
            <span><span aria-hidden className="mr-1 inline-block size-3 rounded-[2px] bg-blue align-[-2px]" />{t('lod.status.IN_HOUSE')}</span>
            <span><span aria-hidden className="mr-1 inline-block size-3 rounded-[2px] bg-paper align-[-2px] outline outline-1 outline-hair" />{t('lod.status.CHECKED_OUT')}</span>
          </p>
        </Note>
      )}
    </LodgingChrome>
  );
}
