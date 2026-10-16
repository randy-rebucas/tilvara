import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Empty, Note, Serial } from '@/components/note';
import { apiOrNull, type Product, type RecipeVersion } from '@/lib/api';
import { formatDateTime, qty } from '@/lib/format';
import { isUuid, variantOptions } from '@/lib/options';
import { getT } from '@/i18n/server';
import { RestaurantChrome } from '../../chrome';
import { RecipeForm } from '../../forms';

export const metadata = { title: 'Recipe' };

const STATE_TONE = { IN_FORCE: 'chip bg-gold', SCHEDULED: 'tag tag-warn', SUPERSEDED: 'tag' } as const;

/** A dish's recipe versions: the one in force, scheduled ones, and the history (append-only, never backdated). */
export default async function RecipePage({ params }: { params: Promise<{ variantId: string }> }) {
  const { variantId } = await params;
  if (!isUuid(variantId)) notFound();
  const { t, lang } = await getT();
  const [history, products] = await Promise.all([
    apiOrNull<{ data: RecipeVersion[] }>(`/variants/${variantId}/recipe`),
    apiOrNull<{ data: Product[] }>('/products?limit=200'),
  ]);
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
        <div><RecipeForm variantId={variantId} ingredients={variantOptions(products?.data, { stocked: true })} /></div>
      )}
      {history.data.length === 0 ? (
        <Note><Empty>{t('rest.noRecipe')}</Empty></Note>
      ) : (
        <div className="flex flex-col gap-3">
          {history.data.map((v) => (
            <Note key={v.id} denom={v.state === 'IN_FORCE' ? 'gold' : 'none'} className="p-4 pr-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">
                  <Serial className="text-ink">v{v.version}</Serial> <span className={`ml-2 ${STATE_TONE[v.state]}`}>{t(`rest.state.${v.state}`)}</span>
                </p>
                <Serial>{t('rest.from', { date: formatDateTime(v.effectiveFrom, lang) })}</Serial>
              </div>
              {v.note && <p className="mt-1 text-[0.875rem] text-muted">{v.note}</p>}
              {v.ingredients.length === 0 ? (
                <p className="mt-2 text-[0.875rem] text-muted">{t('rest.noIngredients')}</p>
              ) : (
                <ul className="mt-2">
                  {v.ingredients.map((i) => (
                    <li key={i.variantId} className="flex justify-between gap-3 border-t border-hair-soft py-1.5 text-[0.9375rem]">
                      <span><Serial className="text-gold">{i.sku}</Serial> {i.name}</span>
                      <span className="money">{qty(i.quantity)} {i.unit}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Note>
          ))}
        </div>
      )}
    </RestaurantChrome>
  );
}
