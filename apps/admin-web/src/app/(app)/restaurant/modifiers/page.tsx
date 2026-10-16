import { Empty, Note, Serial } from '@/components/note';
import { apiOrNull, type ModifierGroup, type Product } from '@/lib/api';
import { variantNames, variantOptions } from '@/lib/options';
import { getT } from '@/i18n/server';
import { RestaurantChrome } from '../chrome';
import { ModifierGroupForm, OptionForm, RowAction } from '../forms';

export const metadata = { title: 'Modifiers' };

/** Choices offered with menu items (ADR-0014 §3): free instructions, or priced options that sell an item. */
export default async function ModifiersPage() {
  const { t } = await getT();
  const [groups, products] = await Promise.all([
    apiOrNull<{ data: ModifierGroup[] }>('/modifier-groups'),
    apiOrNull<{ data: Product[] }>('/products?limit=200'),
  ]);
  const variants = variantOptions(products?.data);
  const names = variantNames(products?.data);
  const rule = (g: ModifierGroup) =>
    g.minSelect === 0 ? t('rest.ruleOptional', { max: g.maxSelect }) : g.minSelect === g.maxSelect ? t('rest.ruleExactly', { n: g.minSelect }) : t('rest.ruleRange', { min: g.minSelect, max: g.maxSelect });

  return (
    <RestaurantChrome tab="modifiers">
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title pt-2">{t('rest.tab.modifiers')}</h2>
            <p className="mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('rest.modifiersLede')}</p>
          </div>
          {groups && <ModifierGroupForm variants={variants} />}
        </div>
        {groups && groups.data.length > 0 ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {groups.data.map((g) => (
              <Note key={g.id} denom="blue" className="flex flex-col gap-3 p-4 pr-6">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-[1.0625rem] font-semibold">{g.name}</h3>
                    <Serial>{rule(g)}</Serial>
                  </div>
                  <RowAction url={`/api/v1/modifier-groups/${g.id}/archive`} label={t('common.archive')} danger confirmText={t('rest.archiveConfirm', { name: g.name })} />
                </div>
                <ul className="flex flex-col">
                  {g.options.map((o) => {
                    const item = o.variantId ? names.get(o.variantId) : null;
                    return (
                      <li key={o.id} className="flex items-center justify-between gap-3 border-t border-hair-soft py-2">
                        <span className="min-w-0">
                          <span className="font-semibold">{o.name}</span>
                          <span className="block text-[0.8125rem] text-muted">
                            {item ? <>{t('rest.pricedAs')}: <Serial className="text-ink">{item.sku}</Serial> {item.name}</> : t('rest.free')}
                          </span>
                        </span>
                        {g.options.length > Math.max(g.minSelect, 1) && (
                          <RowAction url={`/api/v1/modifier-options/${o.id}/archive`} label={t('common.archive')} danger confirmText={t('rest.archiveConfirm', { name: o.name })} />
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div><OptionForm groupId={g.id} variants={variants} /></div>
              </Note>
            ))}
          </div>
        ) : (
          <Note><Empty>{groups ? t('rest.noGroups') : t('common.noAccess')}</Empty></Note>
        )}
      </section>
    </RestaurantChrome>
  );
}
