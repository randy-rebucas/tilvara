import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type LodgingSettings, type Room, type RoomBlock, type RoomType } from '@/lib/api';
import { addDays } from '@/lib/calendar';
import { formatDate, percentFromRate } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { branchToday, LodgingChrome, lodgingAccess, lodgingBranch, RoomStatusTag } from '../chrome';
import { AddBlock, AddRoom, AddRoomType, EditRoom, EditRoomType, LodgingSettingsForm, NightAuditButton, RemoveButton } from '../forms';

export const metadata = { title: 'Lodging set-up' };

/**
 * Set-up (ADR-0023 §2, §7, §9, §10): room types with their room-night item (its branch price is the
 * rack rate), the branch's rooms, dates a room is out of order, and the branch's lodging settings.
 */
export default async function LodgingSetupPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await lodgingBranch(sp.branch);
  const { canSetup, canManage } = await lodgingAccess();
  const today = branchToday(branch);
  const [types, rooms, blocks, settings] = branch
    ? await Promise.all([
        apiOrNull<{ data: RoomType[] }>('/room-types'),
        apiOrNull<{ data: Room[] }>(`/rooms?branchId=${branch.id}`),
        apiOrNull<{ data: RoomBlock[] }>(`/room-blocks?${new URLSearchParams({ branchId: branch.id, from: addDays(today, -1) })}`),
        apiOrNull<LodgingSettings>(`/branches/${branch.id}/lodging-settings`),
      ])
    : [null, null, null, null];
  const typeList = types?.data ?? [];
  const roomList = (rooms?.data ?? []).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));

  return (
    <LodgingChrome tab="setup" branches={branches} branch={branch}>
      {!types ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          <section aria-labelledby="room-types" className="flex flex-col gap-3">
            <h2 id="room-types" className="section-title">{t('lod.roomTypes')}</h2>
            <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('lod.roomTypesLede')}</p>
            <Note denom="violet" className="pr-2">
              {typeList.length ? (
                <RecordTable
                  rows={typeList}
                  rowKey={(x) => x.id}
                  columns={[
                    { header: t('lod.code'), cell: (x) => <Serial className="font-semibold text-violet">{x.code}</Serial> },
                    { header: t('common.name'), cell: (x) => <span className="font-semibold">{x.name}</span> },
                    { header: t('lod.occupancy'), cell: (x) => <Serial className="text-ink">{t('lod.occupancyOf', { base: x.baseOccupancy, max: x.maxOccupancy })}</Serial> },
                    { header: t('lod.nightItem'), cell: (x) => <Serial className="text-ink">{x.nightItem ? `${x.nightItem.sku} · ${x.nightItem.name}` : '—'}</Serial> },
                    { header: t('lod.rooms'), num: true, cell: (x) => <Serial className="text-ink">{x.rooms}</Serial> },
                    { header: '', cell: (x) => (canSetup ? <EditRoomType type={x} /> : null) },
                  ]}
                  stacked={{
                    title: (x) => <>{x.name} <Serial className="text-violet">{x.code}</Serial></>,
                    meta: (x) => (
                      <>
                        <Serial>{t('lod.occupancyOf', { base: x.baseOccupancy, max: x.maxOccupancy })} · {x.nightItem?.sku ?? '—'}</Serial>
                        {canSetup && <div className="mt-2"><EditRoomType type={x} /></div>}
                      </>
                    ),
                    figure: (x) => <Serial className="text-ink">{t('lod.roomsN', { n: x.rooms })}</Serial>,
                  }}
                />
              ) : (
                <Empty>{t('lod.noRoomTypes')}</Empty>
              )}
            </Note>
            {canSetup && <div><AddRoomType /></div>}
          </section>

          <section aria-labelledby="rooms" className="flex flex-col gap-3">
            <h2 id="rooms" className="section-title">{t('lod.roomsOf', { branch: branch!.name })}</h2>
            <Note denom="violet" className="pr-2">
              {roomList.length ? (
                <RecordTable
                  rows={roomList}
                  rowKey={(r) => r.id}
                  columns={[
                    { header: t('lod.room'), cell: (r) => <b data-room-row={r.number}>{r.number}</b> },
                    { header: t('lod.roomType'), cell: (r) => <Serial className="text-ink">{r.roomType?.code ?? '—'} · {r.roomType?.name ?? ''}</Serial> },
                    { header: t('lod.floor'), cell: (r) => r.floor ?? '—' },
                    { header: t('lod.housekeeping'), cell: (r) => <RoomStatusTag status={r.housekeepingStatus} label={t(`lod.hk.${r.housekeepingStatus}` as MessageKey)} /> },
                    { header: t('common.notes'), cell: (r) => <span className="text-[0.875rem] text-muted">{r.notes ?? ''}</span> },
                    { header: '', cell: (r) => (canSetup ? <EditRoom room={r} types={typeList} /> : null) },
                  ]}
                  stacked={{
                    title: (r) => <>{t('lod.roomN', { n: r.number })}</>,
                    meta: (r) => (
                      <>
                        <Serial>{r.roomType?.code ?? '—'}{r.floor ? ` · ${t('lod.floor')} ${r.floor}` : ''}</Serial>
                        {canSetup && <div className="mt-2"><EditRoom room={r} types={typeList} /></div>}
                      </>
                    ),
                    figure: (r) => <RoomStatusTag status={r.housekeepingStatus} label={t(`lod.hk.${r.housekeepingStatus}` as MessageKey)} />,
                  }}
                />
              ) : (
                <Empty>{typeList.length ? t('lod.noRooms') : t('lod.typesFirst')}</Empty>
              )}
            </Note>
            {canSetup && typeList.length > 0 && <div><AddRoom branchId={branch!.id} types={typeList} /></div>}
          </section>

          <section aria-labelledby="blocks" className="flex flex-col gap-3">
            <h2 id="blocks" className="section-title">{t('lod.blocks')}</h2>
            <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('lod.blocksLede')}</p>
            <Note className="pr-2">
              {blocks?.data.length ? (
                <RecordTable
                  rows={blocks.data}
                  rowKey={(b) => b.id}
                  columns={[
                    { header: t('lod.room'), cell: (b) => <b>{b.roomNumber}</b> },
                    { header: t('lod.dates'), cell: (b) => <Serial className="text-ink">{formatDate(b.startsOn, lang)} → {formatDate(b.endsOn, lang)}</Serial> },
                    { header: t('common.reason'), cell: (b) => b.reason },
                    { header: '', cell: (b) => (canSetup || canManage ? <RemoveButton url={`/api/v1/room-blocks/${b.id}`} label={t('lod.removeBlock')} confirmText={t('lod.removeBlockConfirm')} /> : null) },
                  ]}
                  stacked={{
                    title: (b) => t('lod.roomN', { n: b.roomNumber }),
                    meta: (b) => <>{b.reason}{(canSetup || canManage) && <div className="mt-2"><RemoveButton url={`/api/v1/room-blocks/${b.id}`} label={t('lod.removeBlock')} confirmText={t('lod.removeBlockConfirm')} /></div>}</>,
                    figure: (b) => <Serial className="text-ink">{b.startsOn.slice(5)} → {b.endsOn.slice(5)}</Serial>,
                  }}
                />
              ) : (
                <Empty>{t('lod.noBlocks')}</Empty>
              )}
            </Note>
            {(canSetup || canManage) && roomList.length > 0 && <div><AddBlock rooms={roomList} today={today} /></div>}
          </section>

          {settings && (
            <section aria-labelledby="branch-settings" className="flex flex-col gap-3">
              <h2 id="branch-settings" className="section-title">{t('lod.settingsOf', { branch: branch!.name })}</h2>
              <Callout tone="warn">{t('lod.accommodationTaxUnverified')}</Callout>
              <Note className="px-5 py-4 pr-8">
                {canSetup ? (
                  <LodgingSettingsForm settings={settings} />
                ) : (
                  <dl className="grid gap-2 text-[0.9375rem] sm:grid-cols-3">
                    <div><dt className="text-[0.8125rem] text-muted">{t('lod.nightAuditTime')}</dt><dd>{settings.nightAuditTime}</dd></div>
                    <div><dt className="text-[0.8125rem] text-muted">{t('lod.accommodationTax')}</dt><dd>{settings.accommodationTaxRate ? `${percentFromRate(settings.accommodationTaxRate)}%` : t('lod.none')}</dd></div>
                    <div><dt className="text-[0.8125rem] text-muted">{t('lod.forfeitOnCancel')}</dt><dd>{settings.forfeitOnCancel ? t('lod.yes') : t('lod.no')}</dd></div>
                  </dl>
                )}
              </Note>
              {canManage && (
                <div className="flex flex-col gap-2">
                  <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('lod.nightAuditHint')}</p>
                  <NightAuditButton branchId={branch!.id} />
                </div>
              )}
            </section>
          )}
        </>
      )}
    </LodgingChrome>
  );
}
