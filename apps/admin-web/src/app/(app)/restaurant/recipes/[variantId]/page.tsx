import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Empty, Note, Serial } from '@/components/note';
import { allProducts, apiOrNull, type RecipeVersion, type Uom } from '@/lib/api';
import { isUuid, variantOptions } from '@/lib/options';
import { getT } from '@/i18n/server';
import { RestaurantChrome } from '../../chrome';
import { RecipeForm } from '../../forms';
import { RecipeHistory } from '../recipe-history';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('restaurant.recipes.item');

/** A dish's recipe versions: the one in force, scheduled ones, and the history (append-only, never backdated). */
export default async function RecipePage({ params }: { params: Promise<{ variantId: string }> }) {
  const { variantId } = await params;
  if (!isUuid(variantId)) notFound();
  const { t } = await getT();
  const [history, products, uoms] = await Promise.all([
    apiOrNull<{ data: RecipeVersion[] }>(`/variants/${variantId}/recipe`),
    allProducts(),
    apiOrNull<{ data: Uom[] }>('/uoms'),
  ]);
  const units = new Map(uoms?.data.map((u) => [u.id, u.code]));
  if (!history) notFound();
  const product = products?.data.find((p) => p.variants.some((v) => v.id === variantId));
  const variant = product?.variants.find((v) => v.id === variantId);
  const title = product ? (variant?.name ? `${product.name} — ${variant.name}` : product.name) : variantId;

  return (
    <RestaurantChrome tab="recipes">
      <div>
        <Link href="/restaurant/recipes" className="text-[0.875rem] text-blue">← {t('rest.tab.recipes')}</Link>
        <h2 className="text-[1.375rem] font-semibold">{title}</h2>
        {variant && <Serial className="text-gold">{variant.sku}</Serial>}
      </div>
      {product?.trackInventory ? (
        <Note><Empty>{t('rest.tracksStock')}</Empty></Note>
      ) : (
        <div><RecipeForm variantId={variantId} ingredients={variantOptions(products?.data, { stocked: true, units })} /></div>
      )}
      <RecipeHistory history={history.data} emptyText={t('rest.noRecipe')} />
    </RestaurantChrome>
  );
}
