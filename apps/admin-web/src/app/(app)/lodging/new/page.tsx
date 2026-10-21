import Link from 'next/link';
import { Callout, Note } from '@/components/note';
import { apiOrNull, type Room, type RoomType } from '@/lib/api';
import { addDays, isDate } from '@/lib/calendar';
import { isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { branchToday, LodgingChrome, lodgingAccess, lodgingBranch } from '../chrome';
import { StayBookingForm } from './booking-form';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('lodging.new');

/** A new booking (ADR-0023 §3): from the front desk, or a free night of the room calendar (room and date filled). */
export default async function NewBookingPage({ searchParams }: { searchParams: Promise<{ branch?: string; room?: string; arrival?: string }> }) {
  const sp = await searchParams;
  const { t } = await getT();
  const { branches, branch } = await lodgingBranch(sp.branch);
  const { canManage, canRates, canCustomers } = await lodgingAccess();
  const today = branchToday(branch);
  const arrival = isDate(sp.arrival) ? sp.arrival : today;
  const [rooms, types] = branch
    ? await Promise.all([apiOrNull<{ data: Room[] }>(`/rooms?branchId=${branch.id}`), apiOrNull<{ data: RoomType[] }>('/room-types')])
    : [null, null];
  const roomList = (rooms?.data ?? []).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));

  return (
    <LodgingChrome tab="calendar" branches={branches} branch={branch} extra={{ arrival, ...(sp.room && { room: sp.room }) }}>
      <h2 className="text-[1.0625rem] font-semibold">{t('lod.newBooking')}</h2>
      {!canManage ? (
        <Callout>{t('lod.cannotBook')}</Callout>
      ) : roomList.length === 0 ? (
        <Callout>
          {t('lod.noRooms')} <Link href={`/lodging/setup?branch=${branch!.id}`} className="font-semibold underline">{t('lod.tab.setup')}</Link>
        </Callout>
      ) : (
        <Note className="px-5 py-5 pr-8">
          <StayBookingForm
            branchId={branch!.id}
            rooms={roomList}
            types={types?.data ?? []}
            defaults={{ arrival, departure: addDays(arrival, 1), roomId: sp.room && isUuid(sp.room) ? sp.room : '' }}
            canRates={canRates}
            canSearchCustomers={canCustomers}
          />
        </Note>
      )}
    </LodgingChrome>
  );
}
