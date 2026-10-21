import type { ReactNode } from 'react';
import { Callout, Empty, Note, PageHeader, ToLocations } from '@/components/note';
import { ScopePicker, SubNav } from '@/components/scope';
import { api, apiOrNull, type Branch, type JobOrderStatus, type Me } from '@/lib/api';
import { servesLaundry } from '@/lib/business-type';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';

export type LaundryTab = 'board' | 'machines' | 'trips' | 'setup';
export const LAUNDRY_PATHS: Record<LaundryTab, string> = {
  board: '/laundry',
  machines: '/laundry/machines',
  trips: '/laundry/trips',
  setup: '/laundry/setup',
};

/** Active branches, and the one the page works on (?branch=, else the first). */
export async function laundryBranch(param: string | undefined) {
  const list = await apiOrNull<{ data: Branch[] }>('/branches');
  const branches = list?.data.filter((b) => !b.archivedAt) ?? [];
  return { branches, branch: branches.find((b) => b.id === param) ?? branches[0] };
}

/** What the person may do here (UI hints only; the API checks each branch). */
export async function laundryAccess() {
  const me = await api<Me>('/me');
  const p = me.activeTenant?.permissions ?? [];
  return {
    me,
    businessType: me.activeTenant?.businessType,
    canRead: p.includes('laundry.read'),
    /** Take in laundry, move jobs along, down payments, machine loads, trips, cancel with a refund. */
    canManage: p.includes('laundry.manage'),
    canDeliver: p.includes('laundry.deliver'),
    /** Dispose of unclaimed laundry, and keep a down payment on cancelling. */
    canDispose: p.includes('laundry.dispose'),
    canSetup: p.includes('laundry.setup'),
    canCustomers: p.includes('customers.read') || p.includes('customers.manage'),
    canCatalog: p.includes('catalog.read'),
  };
}

/**
 * Header, section tabs and branch picker of Laundry (ADR-0024). A business of another type sees why
 * instead (the API refuses laundry writes for it too).
 */
export async function LaundryChrome({
  tab,
  branches,
  branch,
  extra = {},
  actions,
  children,
}: {
  tab: LaundryTab;
  branches: Branch[];
  branch?: Branch;
  /** Other choices kept in the URL across the branch picker (e.g. the board's filter). */
  extra?: Record<string, string>;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = await getT();
  const { businessType, canSetup, canRead, canDeliver } = await laundryAccess();
  if (!servesLaundry(businessType)) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('lau.title')} lede={t('lau.lede')} />
        <Callout>
          {t('biz.laundryOff')}{' '}
          <a href="/subscription/business" className="font-semibold underline">{t('biz.restaurantOffLink')}</a>
        </Callout>
      </div>
    );
  }
  const q = branch ? `?branch=${branch.id}` : '';
  const tabs = (Object.keys(LAUNDRY_PATHS) as LaundryTab[]).filter((k) =>
    k === 'setup' ? canSetup : k === 'trips' ? canRead || canDeliver : canRead,
  );
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('lau.title')} lede={t('lau.lede')} actions={actions} />
      <SubNav label={t('common.sections')} active={tab} items={tabs.map((key) => ({ key, href: `${LAUNDRY_PATHS[key]}${q}`, label: t(`lau.tab.${key}` as MessageKey) }))} />
      <ScopePicker label={t('common.branch')} items={branches} selected={branch?.id} href={(id) => `${LAUNDRY_PATHS[tab]}?${new URLSearchParams({ branch: id, ...extra })}`} />
      {!branch ? <Note><Empty action={<ToLocations label={t('loc.goTo')} />}>{t('inv.noBranch')}</Empty></Note> : children}
    </div>
  );
}

/**
 * A job's status as one word everywhere: amber when the counter must act (overdue, or ready and
 * waiting too long), blue once ready (the Blue Tick Rule), plain otherwise.
 */
export function JobTag({ status, label, warn = false }: { status: JobOrderStatus; label: string; warn?: boolean }) {
  const look = warn
    ? 'tag border-[#ead3a6]! bg-amber-bg! text-[#6b4a12]!'
    : status === 'READY'
      ? 'tag border-blue! bg-blue! text-white!'
      : status === 'OUT_FOR_DELIVERY'
        ? 'tag border-blue/40! text-blue!'
        : status === 'CLAIMED'
          ? 'tag text-ink!'
          : 'tag';
  return <span className={look} data-job-status={status}>{label}</span>;
}
