import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { api, apiOrNull, type Branch, type KitchenStation, type Menu, type MenuVersion, type ModifierGroup, type Product } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { branchLabel, isUuid, variantOptions } from '@/lib/options';
import { getT } from '@/i18n/server';
import { RestaurantChrome } from '../../chrome';
import { MenuEditor, RowAction } from '../../forms';

export const metadata = { title: 'Menu' };

/** One menu: its draft (editable), the published version (frozen) and the version history. */
export default async function MenuPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const menu = await apiOrNull<Menu>(`/menus/${id}`);
  if (!menu) notFound();
  const [draft, published, groups, products, branches] = await Promise.all([
    menu.draft ? api<MenuVersion>(`/menu-versions/${menu.draft.id}`) : null,
    menu.published ? api<MenuVersion>(`/menu-versions/${menu.published.id}`) : null,
    apiOrNull<{ data: ModifierGroup[] }>('/modifier-groups'),
    apiOrNull<{ data: Product[] }>('/products?limit=200'),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  // Station codes offered for routing: those of every branch (a menu is tenant-wide).
  const stationLists = await Promise.all((branches?.data ?? []).filter((b) => !b.archivedAt).map((b) => apiOrNull<{ data: KitchenStation[] }>(`/kitchen-stations?branchId=${b.id}`)));
  const stations = [...new Set(stationLists.flatMap((s) => s?.data.map((x) => x.code) ?? []))].sort();
  const groupName = new Map((groups?.data ?? []).map((g) => [g.id, g.name]));

  return (
    <RestaurantChrome tab="menus">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/restaurant/menus" className="text-[0.875rem] text-blue">← {t('rest.tab.menus')}</Link>
          <h2 className="text-[1.375rem] font-semibold">{menu.name}</h2>
          <Serial>
            {menu.published ? t('rest.versionN', { n: menu.published.version }) : t('rest.notPublished')}
            {menu.servedBy.length > 0 && <> · {t('rest.servedBy')}: <span className="text-violet">{menu.servedBy.map((s) => branchLabel(branches?.data, s.branchId)).join(', ')}</span></>}
          </Serial>
        </div>
        {!menu.archivedAt && menu.servedBy.length === 0 && <RowAction url={`/api/v1/menus/${menu.id}/archive`} label={t('common.archive')} danger confirmText={t('rest.archiveConfirm', { name: menu.name })} />}
      </div>

      <section>
        <h3 className="section-title mb-3">{draft ? t('rest.draftN', { n: draft.version }) : t('rest.draft')}</h3>
        {draft ? (
          <Note denom="blue" className="p-4 pr-6">
            <p className="mb-4 text-[0.875rem] text-muted">{t('rest.draftLede')}</p>
            <MenuEditor key={draft.id} draft={draft} variants={variantOptions(products?.data)} groups={groups?.data ?? []} stations={stations} />
          </Note>
        ) : (
          <Note className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-muted">{t('rest.noDraft')}</p>
            {!menu.archivedAt && <ActionButton url={`/api/v1/menus/${menu.id}/drafts`} label={t('rest.startDraft')} primary />}
          </Note>
        )}
      </section>

      <section>
        <h3 className="section-title">{published ? t('rest.publishedN', { n: published.version }) : t('rest.published')}</h3>
        {published && <Serial className="mt-1 block">{t('rest.publishedOn', { date: formatDateTime(published.publishedAt, lang) })}</Serial>}
        {published ? (
          <Note denom="blue" className="mt-3 p-4 pr-6">
            <div className="grid gap-4 md:grid-cols-2">
              {published.sections.map((s) => (
                <div key={s.id}>
                  <p className="font-semibold">{s.name}</p>
                  <ul className="mt-1">
                    {s.items.map((i) => (
                      <li key={i.id} className="border-t border-hair-soft py-1.5 text-[0.9375rem]">
                        {i.name} <Serial>{i.sku}{i.stationCode ? ` · ${i.stationCode}` : ''}</Serial>
                        {i.modifierGroupIds.length > 0 && <span className="block text-[0.8125rem] text-muted">{i.modifierGroupIds.map((g) => groupName.get(g) ?? '?').join(' · ')}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Note>
        ) : (
          <Note className="mt-3"><Empty>{t('rest.notPublishedYet')}</Empty></Note>
        )}
        {published && menu.servedBy.length === 0 && <div className="mt-3"><Callout>{t('rest.notServedHint')}</Callout></div>}
      </section>

      {menu.versions.length > 1 && (
        <section>
          <h3 className="section-title mb-2">{t('rest.history')}</h3>
          <ul className="text-[0.875rem] text-muted">
            {menu.versions.map((v) => (
              <li key={v.id}>
                <Serial className="text-ink">v{v.version}</Serial> · {t(`rest.vstatus.${v.status}`)} · {formatDateTime(v.publishedAt ?? v.createdAt, lang)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </RestaurantChrome>
  );
}
