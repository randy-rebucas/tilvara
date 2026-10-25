import type { ReactNode } from 'react';
import { Callout, Empty, Note, PageHeader, ToLocations } from '@/components/note';
import { ScopePicker, SubNav } from '@/components/scope';
import { api, apiOrNull, type Branch, type Me } from '@/lib/api';
import { servesAppointments } from '@/lib/business-type';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';

export type AppointmentsTab = 'calendar' | 'new' | 'staff';
const PATHS: Record<AppointmentsTab, string> = {
  calendar: '/appointments',
  new: '/appointments/new',
  staff: '/appointments/staff',
};

/** Active branches, and the one the page works on (?branch=, else the first). */
export async function appointmentsBranch(param: string | undefined) {
  const list = await apiOrNull<{ data: Branch[] }>('/branches');
  const branches = list?.data.filter((b) => !b.archivedAt) ?? [];
  return { branches, branch: branches.find((b) => b.id === param) ?? branches[0] };
}

/** What the person may do here (UI hints only; the API checks each branch). */
export async function appointmentsAccess() {
  const me = await api<Me>('/me');
  const p = me.activeTenant?.permissions ?? [];
  return {
    me,
    businessType: me.activeTenant?.businessType,
    canBook: p.includes('appointments.manage'),
    canStaff: p.includes('staff.manage'),
    canCustomers: p.includes('customers.read') || p.includes('customers.manage'),
  };
}

/**
 * Header, section tabs and branch picker of Appointments (ADR-0022). A business that does not take
 * appointments sees why instead (the API refuses bookings and staff changes for it too).
 */
export async function AppointmentsChrome({
  tab,
  branches,
  branch,
  extra = {},
  children,
}: {
  tab: AppointmentsTab;
  branches: Branch[];
  branch?: Branch;
  /** Other choices kept in the URL across the branch picker (e.g. the calendar's date). */
  extra?: Record<string, string>;
  children: ReactNode;
}) {
  const { t } = await getT();
  const { businessType, canBook } = await appointmentsAccess();
  const header = <PageHeader title={t('appt.title')} lede={t('appt.lede')} />;
  if (!servesAppointments(businessType)) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Callout>
          {t('biz.salonOff')}{' '}
          <a href="/subscription/business" className="font-semibold underline">{t('biz.changeTypeLink')}</a>
        </Callout>
      </div>
    );
  }
  const q = branch ? `?branch=${branch.id}` : '';
  const tabs = (Object.keys(PATHS) as AppointmentsTab[]).filter((k) => k !== 'new' || canBook);
  return (
    <div className="flex flex-col gap-6">
      {header}
      <SubNav label={t('common.sections')} active={tab} items={tabs.map((key) => ({ key, href: `${PATHS[key]}${q}`, label: t(`appt.tab.${key}` as MessageKey) }))} />
      <ScopePicker label={t('common.branch')} items={branches} selected={branch?.id} href={(id) => `${PATHS[tab]}?${new URLSearchParams({ branch: id, ...extra })}`} />
      {!branch ? <Note><Empty action={<ToLocations label={t('loc.goTo')} />}>{t('inv.noBranch')}</Empty></Note> : children}
    </div>
  );
}

/** A status as one word everywhere; amber when someone must act (the client is here, waiting to be rung up). */
export function StatusTag({ status, label }: { status: string; label: string }) {
  const look =
    status === 'ARRIVED'
      ? 'tag border-[#ead3a6]! bg-amber-bg! text-[#6b4a12]!'
      : status === 'BOOKED'
        ? 'tag border-blue/40! text-blue!'
        : status === 'COMPLETED'
          ? 'tag text-ink!'
          : 'tag';
  return <span className={look} data-status={status}>{label}</span>;
}

/** A staff member's calendar colour (their own choice), or a neutral ink when none is set. */
export const staffColor = (c: string | null | undefined) => c ?? '#8a8f99';
