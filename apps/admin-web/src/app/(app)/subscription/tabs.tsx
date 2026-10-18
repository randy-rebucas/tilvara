import { SubNav } from '@/components/sub-nav';
import { getT } from '@/i18n/server';

/** Subscription, the business's copy of its records, and support access sit together: they are about the account. */
export async function SubscriptionTabs({ active }: { active: 'plan' | 'export' | 'support' }) {
  const { t } = await getT();
  return (
    <SubNav
      label={t('sub.tabs')}
      active={active}
      items={[
        { key: 'plan', href: '/subscription', label: t('sub.tab.plan') },
        { key: 'export', href: '/subscription/export', label: t('sub.tab.export') },
        { key: 'support', href: '/subscription/support', label: t('sub.tab.support') },
      ]}
    />
  );
}
