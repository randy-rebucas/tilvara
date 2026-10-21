import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { allProducts } from '@/lib/api';
import { getT } from '@/i18n/server';
import { RestaurantChrome } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('restaurant.recipes');

/**
 * Dishes and their recipes (ADR-0014 §4): an item that does not track stock itself consumes its
 * ingredients at checkout. Only such items can have a recipe.
 */
export default async function RecipesPage() {
  const { t } = await getT();
  const products = await allProducts();
  const dishes = (products?.data ?? [])
    .filter((p) => !p.archivedAt && !p.trackInventory)
    .flatMap((p) => p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, sku: v.sku, name: v.name ? `${p.name} — ${v.name}` : p.name })));

  return (
    <RestaurantChrome tab="recipes">
      <section>
        <h2 className="section-title pt-2">{t('rest.tab.recipes')}</h2>
        <p className="mb-3 mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('rest.recipesLede')}</p>
        <Note denom="gold" className="pr-2">
          {dishes.length > 0 ? (
            <RecordTable
              rows={dishes}
              rowKey={(d) => d.id}
              columns={[
                { header: t('prod.sku'), cell: (d) => <Serial className="text-gold">{d.sku}</Serial> },
                { header: t('common.item'), cell: (d) => <Link className="font-semibold text-blue underline-offset-2 hover:underline" href={`/restaurant/recipes/${d.id}`}>{d.name}</Link> },
              ]}
              stacked={{ title: (d) => <Link className="text-blue" href={`/restaurant/recipes/${d.id}`}>{d.name}</Link>, meta: (d) => <Serial>{d.sku}</Serial> }}
            />
          ) : (
            <Empty>{products ? t('rest.noDishes') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </RestaurantChrome>
  );
}
