import Link from 'next/link';
import { ActionButton } from '@/components/actions';
import { Empty, Note, PageHeader } from '@/components/note';
import { api, apiOrNull, type Category, type Me } from '@/lib/api';
import { categoryTree, subtreeIds } from '@/lib/categories';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';
import { ProductsTabs } from '../tabs';
import { AddCategory, AddSubCategory, EditCategory } from './forms';

export const generateMetadata = pageTitle('products.categories');

/**
 * Product categories as a tree: add, rename, move, reorder and archive. Products are given a category
 * on their own form; the "By category" report groups sales by it.
 */
export default async function CategoriesPage() {
  const { t } = await getT();
  const [me, list] = await Promise.all([api<Me>('/me'), apiOrNull<{ data: Category[] }>('/categories')]);
  const canManage = me.activeTenant?.permissions.includes('catalog.manage') ?? false;
  const all = list?.data ?? [];
  const rows = categoryTree(all);
  const archived = all.filter((c) => c.archivedAt);
  const options = rows.map((r) => ({ id: r.category.id, label: r.path }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('prod.title')} lede={t('prod.lede')} />
      <ProductsTabs active="categories" />
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title pt-2">{t('cat.title')}</h2>
            <p className="mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('cat.lede')}</p>
          </div>
          {canManage && list && <AddCategory parents={options} />}
        </div>
        {!list ? (
          <Note><Empty>{t('common.noAccess')}</Empty></Note>
        ) : rows.length === 0 ? (
          <Note><Empty>{t('cat.empty')}</Empty></Note>
        ) : (
          <Note denom="blue" className="pr-2">
            <ul data-testid="category-tree">
              {rows.map(({ category: c, depth }) => {
                const own = subtreeIds(all, c.id);
                return (
                  <li key={c.id} data-category={c.name} className="flex flex-wrap items-start justify-between gap-3 border-b border-hair-soft px-4 py-3 last:border-b-0">
                    <div className="min-w-0" style={{ paddingLeft: `${Math.min(depth, 6) * 1.25}rem` }}>
                      <p className="font-semibold">
                        {depth > 0 && <span aria-hidden className="mr-1.5 text-muted">└</span>}
                        {c.name}
                        {c.isSample && <span className="tag ml-2 border-blue/40 text-blue!">{t('sample.tag')}</span>}
                      </p>
                      <Link href={`/products?category=${c.id}`} className="text-[0.8125rem] text-muted underline">{t('cat.itsProducts')}</Link>
                    </div>
                    {canManage && (
                      <div className="flex flex-wrap items-start gap-2">
                        <EditCategory category={c} parents={options.filter((o) => !own.has(o.id))} />
                        <AddSubCategory parentId={c.id} parentName={c.name} />
                        <ActionButton url={`/api/v1/categories/${c.id}/archive`} label={t('common.archive')} confirmText={t('cat.archiveConfirm', { name: c.name })} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Note>
        )}
        {canManage && <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('cat.archiveHint')}</p>}
      </section>

      {archived.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="section-title">{t('cat.archivedTitle')}</h2>
          <p className="text-[0.875rem] text-muted">{archived.map((c) => c.name).sort((a, b) => a.localeCompare(b)).join(' · ')}</p>
        </section>
      )}
    </div>
  );
}
