import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type Branch, type Menu } from '@/lib/api';
import { branchLabel } from '@/lib/options';
import { getT } from '@/i18n/server';
import { RestaurantChrome } from '../chrome';
import { MenuForm } from '../forms';

export const metadata = { title: 'Menus' };

/** Menus and their versions (ADR-0014 §2): edit a draft, publish it, and branches serve the published one. */
export default async function MenusPage() {
  const { t } = await getT();
  const [menus, branches] = await Promise.all([apiOrNull<{ data: Menu[] }>('/menus'), apiOrNull<{ data: Branch[] }>('/branches')]);
  const served = (m: Menu) => m.servedBy.map((s) => branchLabel(branches?.data, s.branchId)).join(', ') || '—';
  const version = (m: Menu) => (m.published ? t('rest.versionN', { n: m.published.version }) : t('rest.notPublished'));

  return (
    <RestaurantChrome tab="menus">
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title pt-2">{t('rest.tab.menus')}</h2>
            <p className="mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('rest.menusLede')}</p>
          </div>
          {menus && <MenuForm />}
        </div>
        <Note denom="blue" className="pr-2">
          {menus && menus.data.length > 0 ? (
            <RecordTable
              rows={menus.data}
              rowKey={(m) => m.id}
              columns={[
                { header: t('rest.menuName'), cell: (m) => <Link className="font-semibold text-blue underline-offset-2 hover:underline" href={`/restaurant/menus/${m.id}`}>{m.name}</Link> },
                { header: t('rest.published'), cell: (m) => <Serial className={m.published ? 'text-ink' : ''}>{version(m)}</Serial> },
                { header: t('rest.draft'), cell: (m) => (m.draft ? <span className="tag tag-warn">{t('rest.draftN', { n: m.draft.version })}</span> : '—') },
                { header: t('rest.servedBy'), cell: (m) => <Serial className="text-violet">{served(m)}</Serial> },
              ]}
              stacked={{
                title: (m) => <Link className="text-blue" href={`/restaurant/menus/${m.id}`}>{m.name}</Link>,
                meta: (m) => <Serial>{version(m)}{m.draft ? ` · ${t('rest.draftN', { n: m.draft.version })}` : ''} · {served(m)}</Serial>,
              }}
            />
          ) : (
            <Empty>{menus ? t('rest.noMenus') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </RestaurantChrome>
  );
}
