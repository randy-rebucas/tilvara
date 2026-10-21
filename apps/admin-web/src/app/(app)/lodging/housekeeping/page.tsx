import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { SubNav } from '@/components/sub-nav';
import { apiOrNull, type HousekeepingBoard, type HousekeepingStatus } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { LodgingChrome, lodgingAccess, lodgingBranch, RoomStatusTag } from '../chrome';
import { RoomStatusButtons } from '../forms';

export const metadata = { title: 'Housekeeping' };

const FILTERS = ['all', 'DIRTY', 'CLEAN', 'INSPECTED', 'OUT_OF_ORDER'] as const;

/**
 * The housekeeping board (ADR-0023 §9): every room of the branch with its status, who set it last,
 * and whether it is occupied, has a departure or an arrival today. Rooms to clean come first.
 */
export default async function HousekeepingPage({ searchParams }: { searchParams: Promise<{ branch?: string; status?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await lodgingBranch(sp.branch);
  const { canHousekeeping } = await lodgingAccess();
  const filter = (FILTERS as readonly string[]).includes(sp.status ?? '') ? (sp.status as (typeof FILTERS)[number]) : 'all';
  const board = branch ? await apiOrNull<HousekeepingBoard>(`/lodging/housekeeping?branchId=${branch.id}`) : null;
  const order: HousekeepingStatus[] = ['DIRTY', 'OUT_OF_ORDER', 'CLEAN', 'INSPECTED'];
  const rooms = (board?.data ?? [])
    .filter((r) => filter === 'all' || r.status === filter)
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.number.localeCompare(b.number, undefined, { numeric: true }));
  const count = (s: HousekeepingStatus) => (board?.data ?? []).filter((r) => r.status === s).length;

  return (
    <LodgingChrome tab="housekeeping" branches={branches} branch={branch} extra={filter === 'all' ? {} : { status: filter }}>
      {!board ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          <SubNav
            level={2}
            label={t('lod.hkFilter')}
            active={filter}
            items={FILTERS.map((f) => ({
              key: f,
              href: `/lodging/housekeeping?${new URLSearchParams({ branch: branch!.id, ...(f !== 'all' && { status: f }) })}`,
              label: f === 'all' ? `${t('lod.hkAll')} · ${board.data.length}` : `${t(`lod.hk.${f}` as MessageKey)} · ${count(f)}`,
            }))}
          />
          {rooms.length === 0 ? (
            <Note>
              <Empty action={board.data.length === 0 ? <Link href={`/lodging/setup?branch=${branch!.id}`} className="btn">{t('lod.tab.setup')}</Link> : undefined}>
                {board.data.length === 0 ? t('lod.noRooms') : t('lod.hkNone')}
              </Empty>
            </Note>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="housekeeping-board">
              {rooms.map((r) => (
                <Note key={r.roomId} as="li" denom="violet" className="flex flex-col gap-2 px-4 py-3 pr-6">
                  <div className="flex items-start justify-between gap-2" data-room={r.number}>
                    <div className="min-w-0">
                      <p className="text-[1.0625rem] font-semibold">{t('lod.roomN', { n: r.number })}</p>
                      <Serial>{r.roomType.code} · {r.roomType.name}{r.floor ? ` · ${t('lod.floor')} ${r.floor}` : ''}</Serial>
                    </div>
                    <RoomStatusTag status={r.status} label={t(`lod.hk.${r.status}` as MessageKey)} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {r.occupied && <span className="tag">{t('lod.occupied')}</span>}
                    {r.departingToday && <span className="tag border-[#ead3a6]! bg-amber-bg! text-[#6b4a12]!">{t('lod.leavesToday')}</span>}
                    {r.arrivingToday && <span className="tag border-[#ead3a6]! bg-amber-bg! text-[#6b4a12]!">{t('lod.arrivesToday')}</span>}
                    {!r.occupied && !r.arrivingToday && <span className="tag">{t('lod.vacant')}</span>}
                  </div>
                  <p className="text-[0.8125rem] text-muted">
                    {r.lastChange ? t('lod.lastChange', { who: r.lastChange.byName ?? '—', at: formatDateTime(r.lastChange.at, lang) }) : t('lod.noChangeYet')}
                    {r.lastChange?.note && <span className="block text-ink">{r.lastChange.note}</span>}
                  </p>
                  {canHousekeeping && <RoomStatusButtons roomId={r.roomId} number={r.number} status={r.status} />}
                </Note>
              ))}
            </ul>
          )}
        </>
      )}
    </LodgingChrome>
  );
}
