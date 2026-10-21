import { SubNav } from '@/components/sub-nav';
import { getT } from '@/i18n/server';

/** Products → Products | Quick keys | Labels (ADR-0021 §3, §4). */
export async function ProductsTabs({ active }: { active: 'products' | 'quickKeys' | 'labels' }) {
  const { t } = await getT();
  return (
    <SubNav
      label={t('common.sections')}
      active={active}
      items={[
        { key: 'products', href: '/products', label: t('prod.title') },
        { key: 'quickKeys', href: '/products/quick-keys', label: t('qk.title') },
        { key: 'labels', href: '/products/labels', label: t('lbl.title') },
      ]}
    />
  );
}
