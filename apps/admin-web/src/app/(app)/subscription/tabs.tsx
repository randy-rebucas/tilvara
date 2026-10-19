import { SubNav } from '@/components/sub-nav';
import { getT } from '@/i18n/server';

/** The business's details, subscription, its copy of its records, and support access sit together: they are about the account. */
export async function SubscriptionTabs({ active }: { active: 'plan' | 'business' | 'export' | 'support' }) {
  const { t } = await getT();
  return (
    <SubNav
      label={t('sub.tabs')}
      active={active}
      items={[
        { key: 'plan', href: '/subscription', label: t('sub.tab.plan') },
        { key: 'business', href: '/subscription/business', label: t('sub.tab.business') },
        { key: 'export', href: '/subscription/export', label: t('sub.tab.export') },
        { key: 'support', href: '/subscription/support', label: t('sub.tab.support') },
      ]}
    />
  );
}
