import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Callout, Serial } from '@/components/note';
import { allProducts, api, apiOrNull, type Me, type RecipeVersion, type Uom } from '@/lib/api';
import { usesRecipes } from '@/lib/business-type';
import { isUuid, variantOptions } from '@/lib/options';
import { getT } from '@/i18n/server';
import { RecipeForm } from '../../../../restaurant/forms';
import { RecipeHistory } from '../../../../restaurant/recipes/recipe-history';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('products.item.supplies');

/**
 * A salon service's supplies used (ADR-0022 §9): the recipe of the service, consumed from stock at
 * checkout (a package session too). Supplies are ordinary stock-counted items; their reorder points
 * give the low-supply alerts. Versions are append-only, like a dish's recipe.
 */
export default async function SuppliesPage({ params }: { params: Promise<{ id: string; variantId: string }> }) {
  const { id, variantId } = await params;
  if (!isUuid(id) || !isUuid(variantId)) notFound();
  const { t } = await getT();
  const [me, history, products, uoms] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: RecipeVersion[] }>(`/variants/${variantId}/recipe`),
    allProducts(),
    apiOrNull<{ data: Uom[] }>('/uoms'),
  ]);
  const product = products?.data.find((p) => p.id === id);
  const variant = product?.variants.find((v) => v.id === variantId);
  if (!product || !variant || !history) notFound();
  const units = new Map(uoms?.data.map((u) => [u.id, u.code]));
  const canManage = (me.activeTenant?.permissions.includes('catalog.manage') ?? false) && !product.archivedAt;
  const title = variant.name ? `${product.name} — ${variant.name}` : product.name;
  const supplies = variantOptions(products?.data, { stocked: true, units });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/products/${product.id}`} className="text-[0.875rem] text-muted underline">{product.name}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('prod.suppliesTitle', { name: title })}</h1>
        <Serial className="mt-1 block text-ink">{variant.sku}</Serial>
        <p className="mt-2 max-w-[68ch] text-muted">{t('prod.suppliesLede')}</p>
      </div>
      {!usesRecipes(me.activeTenant?.businessType) && <Callout>{t('prod.suppliesOff')}</Callout>}
      {canManage && usesRecipes(me.activeTenant?.businessType) && (
        supplies.length > 0 ? <div><RecipeForm variantId={variantId} ingredients={supplies} supplies /></div> : <Callout tone="warn">{t('prod.noSupplies')}</Callout>
      )}
      <RecipeHistory history={history.data} emptyText={t('prod.noSuppliesYet')} />
    </div>
  );
}
