'use client';

import { Disclosure } from '@/components/disclosure-form';
import { useT } from '@/i18n/client';
import type { ServiceStaff } from '@/lib/api';
import { BookingForm, type BookableService, type BookingInitial } from '../booking-form';

/** Change an open appointment in place: the same form as booking, its services replaced as a whole. */
export function ChangeAppointment(props: { branch: { id: string; timezone: string }; services: BookableService[]; staff: ServiceStaff[]; initial: BookingInitial; canSearchCustomers: boolean }) {
  const { t } = useT();
  return (
    <Disclosure kind="edit" label={t('appt.change')}>
      {(close) => <BookingForm {...props} defaults={{ date: props.initial.services[0]?.date ?? '' }} onDone={close} />}
    </Disclosure>
  );
}
