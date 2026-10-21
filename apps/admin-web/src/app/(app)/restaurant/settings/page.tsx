import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type LegalEntity, type Menu, type MenuVersion, type RestaurantSettings, type SoldOutRow } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { getT } from '@/i18n/server';
import { RestaurantChrome, restaurantBranch } from '../chrome';
import { RowAction, SettingsForm, SoldOutForm } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('restaurant.settings');

/** Per branch: the menus served, the service charge (ADR-0014 §9) and what is sold out today ("86"). */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const { t, lang } = await getT();
  const { branches, branch } = await restaurantBranch((await searchParams).branch);
  const [settings, menus, soldOut, entities] = branch
    ? await Promise.all([
        apiOrNull<RestaurantSettings>(`/branches/${branch.id}/restaurant-settings`),
        apiOrNull<{ data: Menu[] }>('/menus'),
        apiOrNull<{ data: SoldOutRow[] }>(`/branches/${branch.id}/sold-out`),
        apiOrNull<{ data: LegalEntity[] }>('/legal-entities'),
      ])
    : [null, null, null, null];
  const vatSeller = entities?.data.find((e) => e.id === branch?.legalEntityId)?.vatStatus !== 'NON_VAT';
  // Items that can be marked sold out: what this branch's menus offer.
  const served = (menus?.data ?? []).filter((m) => m.published && (m.id === settings?.dineInMenuId || m.id === settings?.takeawayMenuId));
  const versions = await Promise.all(served.map((m) => apiOrNull<MenuVersion>(`/menu-versions/${m.published!.id}`)));
  const offered = new Map(versions.flatMap((v) => v?.sections.flatMap((s) => s.items.map((i) => [i.variantId, `${i.sku ?? ''} · ${i.name ?? ''}`] as const)) ?? []));
  const already = new Set(soldOut?.data.map((s) => s.variantId));
  const variants = [...offered].filter(([id]) => !already.has(id)).map(([id, label]) => ({ id, label }));

  return (
    <RestaurantChrome tab="settings" branches={branches} branch={branch}>
      <section>
        <h2 className="section-title mb-3">{t('rest.settings')}</h2>
        <Note className="p-4">
          {branch && settings && menus ? (
            <SettingsForm key={branch.id} branchId={branch.id} settings={settings} menus={menus.data} vatSeller={vatSeller} />
          ) : (
            <Empty>{t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title pt-2">{t('rest.soldOut')}</h2>
            <p className="mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('rest.soldOutLede')}</p>
          </div>
          {branch && soldOut && variants.length > 0 && <SoldOutForm branchId={branch.id} variants={variants} />}
        </div>
        <Note className="pr-2">
          {soldOut && soldOut.data.length > 0 ? (
            <RecordTable
              rows={soldOut.data}
              rowKey={(s) => s.variantId}
              columns={[
                { header: t('prod.sku'), cell: (s) => <Serial className="text-ink">{s.sku}</Serial> },
                { header: t('common.item'), cell: (s) => <>{s.name}{s.note && <span className="block text-[0.8125rem] text-muted">{s.note}</span>}</> },
                { header: t('rest.since'), cell: (s) => formatDateTime(s.markedAt, lang) },
                { header: <span className="sr-only">{t('common.actions')}</span>, num: true, cell: (s) => <RowAction method="PUT" url={`/api/v1/branches/${branch!.id}/sold-out`} body={{ variantId: s.variantId, soldOut: false }} label={t('rest.backOn')} /> },
              ]}
              stacked={{
                title: (s) => s.name,
                meta: (s) => <Serial>{s.sku} · {formatDateTime(s.markedAt, lang)}</Serial>,
                figure: (s) => <RowAction method="PUT" url={`/api/v1/branches/${branch!.id}/sold-out`} body={{ variantId: s.variantId, soldOut: false }} label={t('rest.backOn')} />,
              }}
            />
          ) : (
            <Empty>{soldOut ? t('rest.nothingSoldOut') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </RestaurantChrome>
  );
}
