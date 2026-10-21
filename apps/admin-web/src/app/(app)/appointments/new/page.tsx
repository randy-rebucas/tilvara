import Link from 'next/link';
import { Callout, Note } from '@/components/note';
import { isDate, isTime, localParts } from '@/lib/calendar';
import { isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { BookingForm } from '../booking-form';
import { AppointmentsChrome, appointmentsAccess, appointmentsBranch } from '../chrome';
import { bookableServices, branchStaff } from '../data';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('appointments.new');

/** Book an appointment (ADR-0022 §4); the calendar's empty slots open this with the staff and time filled. */
export default async function NewAppointmentPage({ searchParams }: { searchParams: Promise<{ branch?: string; date?: string; staff?: string; time?: string }> }) {
  const sp = await searchParams;
  const { t } = await getT();
  const { branches, branch } = await appointmentsBranch(sp.branch);
  const { canBook, canCustomers } = await appointmentsAccess();
  const tz = branch?.timezone || 'Asia/Manila';
  const [services, staff] = branch && canBook ? await Promise.all([bookableServices(), branchStaff(branch.id)]) : [[], []];
  const date = isDate(sp.date) ? sp.date : localParts(new Date().toISOString(), tz).date;

  return (
    <AppointmentsChrome tab="new" branches={branches} branch={branch} extra={{ date }}>
      {!canBook ? (
        <Callout>{t('appt.cannotBook')}</Callout>
      ) : staff.length === 0 ? (
        <Callout tone="warn">
          {t('appt.noStaffYet')}{' '}
          <Link href={`/appointments/staff?branch=${branch!.id}`} className="font-semibold underline">{t('appt.toStaff')}</Link>
        </Callout>
      ) : (
        <Note denom="none" className="px-5 py-4 pr-8">
          <BookingForm
            branch={{ id: branch!.id, timezone: tz }}
            services={services}
            staff={staff}
            defaults={{ date, staffId: sp.staff && isUuid(sp.staff) ? sp.staff : undefined, time: isTime(sp.time) ? sp.time : undefined }}
            canSearchCustomers={canCustomers}
          />
        </Note>
      )}
    </AppointmentsChrome>
  );
}
