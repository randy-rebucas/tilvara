import type { ReactNode } from 'react';
import { Callout, Empty, Note, PageHeader, ToLocations } from '@/components/note';
import { ScopePicker, SubNav } from '@/components/scope';
import { api, apiOrNull, type Branch, type HousekeepingStatus, type Me, type StayStatus } from '@/lib/api';
import { servesLodging } from '@/lib/business-type';
import { addDays, localParts } from '@/lib/calendar';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';

export type LodgingTab = 'desk' | 'calendar' | 'housekeeping' | 'setup';
export const LODGING_PATHS: Record<LodgingTab, string> = {
  desk: '/lodging',
  calendar: '/lodging/calendar',
  housekeeping: '/lodging/housekeeping',
  setup: '/lodging/setup',
};

/** Active branches, and the one the page works on (?branch=, else the first). */
export async function lodgingBranch(param: string | undefined) {
  const list = await apiOrNull<{ data: Branch[] }>('/branches');
  const branches = list?.data.filter((b) => !b.archivedAt) ?? [];
  return { branches, branch: branches.find((b) => b.id === param) ?? branches[0] };
}

/** What the person may do here (UI hints only; the API checks each branch). */
export async function lodgingAccess() {
  const me = await api<Me>('/me');
  const p = me.activeTenant?.permissions ?? [];
  return {
    me,
    businessType: me.activeTenant?.businessType,
    canRead: p.includes('lodging.read'),
    canManage: p.includes('lodging.manage'),
    /** Agreed rates, folio adjustments, night reversals, bank transfers, refunds against the default. */
    canRates: p.includes('lodging.rates') || p.includes('prices.manage'),
    canHousekeeping: p.includes('lodging.housekeeping'),
    canSetup: p.includes('lodging.setup'),
    canCustomers: p.includes('customers.read') || p.includes('customers.manage'),
  };
}

/** Today in the branch's calendar (the API decides what is due by the same calendar). */
export const branchToday = (branch: Pick<Branch, 'timezone'> | undefined) => localParts(new Date().toISOString(), branch?.timezone || 'Asia/Manila').date;

/** Nights between two dates (departure − arrival). */
export function nightsBetween(from: string, to: string) {
  let n = 0;
  for (let d = from; d < to && n < 400; d = addDays(d, 1)) n++;
  return n;
}

/**
 * Header, section tabs and branch picker of Lodging (ADR-0023). A business without rooms sees why
 * instead (the API refuses lodging writes for it too).
 */
export async function LodgingChrome({
  tab,
  branches,
  branch,
  extra = {},
  actions,
  children,
}: {
  tab: LodgingTab;
  branches: Branch[];
  branch?: Branch;
  /** Other choices kept in the URL across the branch picker (e.g. the grid's first night). */
  extra?: Record<string, string>;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = await getT();
  const { businessType, canSetup, canRead } = await lodgingAccess();
  const header = <PageHeader title={t('lod.title')} lede={t('lod.lede')} actions={actions} />;
  if (!servesLodging(businessType)) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('lod.title')} lede={t('lod.lede')} />
        <Callout>
          {t('biz.lodgingOff')}{' '}
          <a href="/subscription/business" className="font-semibold underline">{t('biz.restaurantOffLink')}</a>
        </Callout>
      </div>
    );
  }
  const q = branch ? `?branch=${branch.id}` : '';
  const tabs = (Object.keys(LODGING_PATHS) as LodgingTab[]).filter((k) => (k !== 'setup' || canSetup) && (k === 'housekeeping' || k === 'setup' || canRead));
  return (
    <div className="flex flex-col gap-6">
      {header}
      <SubNav label={t('common.sections')} active={tab} items={tabs.map((key) => ({ key, href: `${LODGING_PATHS[key]}${q}`, label: t(`lod.tab.${key}` as MessageKey) }))} />
      <ScopePicker label={t('common.branch')} items={branches} selected={branch?.id} href={(id) => `${LODGING_PATHS[tab]}?${new URLSearchParams({ branch: id, ...extra })}`} />
      {!branch ? <Note><Empty action={<ToLocations label={t('loc.goTo')} />}>{t('inv.noBranch')}</Empty></Note> : children}
    </div>
  );
}

/** A stay's status as one word everywhere; amber when the front desk must act (due to arrive or leave). */
export function StayTag({ status, label, due = false }: { status: StayStatus; label: string; due?: boolean }) {
  const look = due
    ? 'tag border-[#ead3a6]! bg-amber-bg! text-[#6b4a12]!'
    : status === 'BOOKED'
      ? 'tag border-blue/40! text-blue!'
      : status === 'IN_HOUSE'
        ? 'tag text-ink!'
        : 'tag';
  return <span className={look} data-stay-status={status}>{label}</span>;
}

/** A room's housekeeping status: amber when it needs cleaning, blue when ready (the Blue Tick Rule). */
export function RoomStatusTag({ status, label }: { status: HousekeepingStatus; label: string }) {
  const look =
    status === 'DIRTY'
      ? 'tag border-[#ead3a6]! bg-amber-bg! text-[#6b4a12]!'
      : status === 'INSPECTED'
        ? 'tag border-blue! bg-blue! text-white!'
        : status === 'CLEAN'
          ? 'tag border-blue/40! text-blue!'
          : 'tag border-ink/40! text-ink!';
  return <span className={look} data-room-status={status}>{label}</span>;
}
