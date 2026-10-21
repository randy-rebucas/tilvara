import { SubNav } from '@/components/sub-nav';
import { getT } from '@/i18n/server';

/** Prices → Price lists | Promotions (ADR-0021 §1). */
export async function PricesTabs({ active }: { active: 'lists' | 'promotions' }) {
  const { t } = await getT();
  return (
    <SubNav
      label={t('common.sections')}
      active={active}
      items={[
        { key: 'lists', href: '/prices', label: t('price.lists') },
        { key: 'promotions', href: '/prices/promotions', label: t('promo.title') },
      ]}
    />
  );
}
