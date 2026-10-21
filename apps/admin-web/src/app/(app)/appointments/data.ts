import { allProducts, apiOrNull, type ServiceStaff } from '@/lib/api';
import type { MessageKey } from '@/i18n/messages';
import type { BookableService } from './booking-form';

/** The services that can be booked (SERVICE items, with their durations; ones without show disabled). */
export async function bookableServices(): Promise<BookableService[]> {
  const products = (await allProducts())?.data ?? [];
  return products
    .filter((p) => p.productType === 'SERVICE' && !p.archivedAt)
    .flatMap((p) => p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, label: v.name ? `${p.name} — ${v.name}` : p.name, minutes: v.serviceMinutes ?? null })))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The branch's active staff. */
export async function branchStaff(branchId: string): Promise<ServiceStaff[]> {
  return (await apiOrNull<{ data: ServiceStaff[] }>(`/service-staff?branchId=${branchId}`))?.data ?? [];
}

/** Hours as a short line: "Mon 09:00–18:00 · Tue …", or "Any time" when none are set. */
export function hoursLine(staff: ServiceStaff, t: (k: MessageKey) => string) {
  if (!staff.hours.length) return t('sstaff.anyTime');
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order
    .filter((d) => staff.hours.some((h) => h.weekday === d))
    .map((d) => `${t(`appt.weekdayShort.${d}` as MessageKey)} ${staff.hours.filter((h) => h.weekday === d).map((h) => `${h.startsAt}–${h.endsAt}`).join(', ')}`)
    .join(' · ');
}

