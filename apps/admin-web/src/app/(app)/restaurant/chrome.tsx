import type { ReactNode } from 'react';
import { Empty, Note, PageHeader } from '@/components/note';
import { ScopePicker, SubNav } from '@/components/scope';
import { apiOrNull, type Branch } from '@/lib/api';
import { getT } from '@/i18n/server';

export type RestaurantTab = 'floor' | 'menus' | 'modifiers' | 'recipes' | 'settings';
const PATHS: Record<RestaurantTab, string> = {
  floor: '/restaurant',
  menus: '/restaurant/menus',
  modifiers: '/restaurant/modifiers',
  recipes: '/restaurant/recipes',
  settings: '/restaurant/settings',
};
/** Tabs whose content belongs to one branch (the others are tenant-wide). */
const PER_BRANCH: RestaurantTab[] = ['floor', 'settings'];

/** Active branches, and the one the page works on (?branch=, else the first). */
export async function restaurantBranch(param: string | undefined) {
  const list = await apiOrNull<{ data: Branch[] }>('/branches');
  const branches = list?.data.filter((b) => !b.archivedAt) ?? [];
  return { branches, branch: branches.find((b) => b.id === param) ?? branches[0] };
}

/** Page header, section tabs and (for per-branch tabs) the branch picker of the restaurant set-up. */
export async function RestaurantChrome({ tab, branches = [], branch, children }: { tab: RestaurantTab; branches?: Branch[]; branch?: Branch; children: ReactNode }) {
  const { t } = await getT();
  const q = branch ? `?branch=${branch.id}` : '';
  const perBranch = PER_BRANCH.includes(tab);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('rest.title')} lede={t('rest.lede')} />
      <SubNav
        label={t('common.sections')}
        active={tab}
        items={(Object.keys(PATHS) as RestaurantTab[]).map((key) => ({ key, href: `${PATHS[key]}${PER_BRANCH.includes(key) ? q : ''}`, label: t(`rest.tab.${key}`) }))}
      />
      {perBranch && <ScopePicker label={t('common.branch')} items={branches} selected={branch?.id} href={(id) => `${PATHS[tab]}?branch=${id}`} />}
      {perBranch && !branch ? <Note><Empty>{t('inv.noBranch')}</Empty></Note> : children}
    </div>
  );
}
