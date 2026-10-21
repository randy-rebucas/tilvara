import type { ReactNode } from 'react';
import { Empty, Note, PageHeader, ToLocations } from '@/components/note';
import { ScopePicker, SubNav } from '@/components/scope';
import { apiOrNull, type Branch } from '@/lib/api';
import { getT } from '@/i18n/server';

export type InventoryTab = 'stock' | 'expiry' | 'packs' | 'reservations' | 'transfers' | 'counts' | 'movements' | 'settings';
const PATHS: Record<InventoryTab, string> = {
  stock: '/inventory',
  expiry: '/inventory/expiry',
  packs: '/inventory/packs',
  reservations: '/inventory/reservations',
  transfers: '/inventory/transfers',
  counts: '/inventory/counts',
  movements: '/inventory/movements',
  settings: '/inventory/settings',
};

/** `?branch=all` on the stock page: every branch side by side. */
export const ALL = 'all';

/** Active branches, and the one the page works on (?branch=, else the first). */
export async function inventoryBranch(param: string | undefined) {
  const list = await apiOrNull<{ data: Branch[] }>('/branches');
  const branches = list?.data.filter((b) => !b.archivedAt) ?? [];
  return { branches, branch: branches.find((b) => b.id === param) ?? branches[0] };
}

/**
 * Page header, section tabs and branch picker shared by the inventory pages. `all`: the stock page's
 * "All branches" view (ADR-0021 §5), offered there when there is more than one branch.
 */
export async function InventoryChrome({ tab, branches, branch, all = false, children }: { tab: InventoryTab; branches: Branch[]; branch: Branch | undefined; all?: boolean; children: ReactNode }) {
  const { t } = await getT();
  const q = branch ? `?branch=${branch.id}` : '';
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('inv.title')} lede={t('inv.lede')} />
      <SubNav
        label={t('common.sections')}
        active={tab}
        items={[
          { key: 'stock', href: `${PATHS.stock}${q}`, label: t('inv.tab.stock') },
          { key: 'expiry', href: `${PATHS.expiry}${q}`, label: t('inv.tab.expiry') },
          { key: 'packs', href: `${PATHS.packs}${q}`, label: t('inv.tab.packs') },
          { key: 'reservations', href: `${PATHS.reservations}${q}`, label: t('inv.tab.reservations') },
          { key: 'transfers', href: `${PATHS.transfers}${q}`, label: t('inv.tab.transfers') },
          { key: 'counts', href: `${PATHS.counts}${q}`, label: t('inv.tab.counts') },
          { key: 'movements', href: `${PATHS.movements}${q}`, label: t('inv.tab.movements') },
          { key: 'settings', href: `${PATHS.settings}${q}`, label: t('inv.tab.settings') },
        ]}
      />
      <ScopePicker
        label={t('common.branch')}
        items={tab === 'stock' && branches.length > 1 ? [{ id: ALL, name: t('rep.allBranches') }, ...branches] : branches}
        selected={all ? ALL : branch?.id}
        href={(id) => `${PATHS[tab]}?branch=${id}`}
      />
      {branch || all ? children : <Note><Empty action={<ToLocations label={t('loc.goTo')} />}>{t('inv.noBranch')}</Empty></Note>}
    </div>
  );
}
