import { SubNav } from '@/components/sub-nav';
import { getT } from '@/i18n/server';
import { apiOrNull, type Me } from '@/lib/api';

type Tab = 'plan' | 'business' | 'branding' | 'extensions' | 'export' | 'support' | 'integrations';

/** What the API asks to read each tab (any one); a tab the person cannot read is left out. Business is read by every member. */
const NEEDS: Record<Tab, readonly string[] | null> = {
  plan: ['subscription.manage', 'tenant.manage'],
  business: null,
  branding: ['tenant.manage'],
  extensions: ['tenant.manage'],
  export: ['tenant.manage'],
  support: ['tenant.manage'],
  integrations: ['integrations.manage'],
};

/** The business's details and branding, subscription, its copy of its records, and support access sit together: they are about the account. */
export async function SubscriptionTabs({ active }: { active: Tab }) {
  const { t } = await getT();
  const permissions = (await apiOrNull<Me>('/me'))?.activeTenant?.permissions;
  // Without /me every tab shows; each page still says when the API refuses it.
  const shown = (key: Tab) => key === active || !permissions || !NEEDS[key] || NEEDS[key].some((p) => permissions.includes(p));
  const items: { key: Tab; href: string; label: string }[] = [
    { key: 'plan', href: '/subscription', label: t('sub.tab.plan') },
    { key: 'business', href: '/subscription/business', label: t('sub.tab.business') },
    { key: 'branding', href: '/subscription/branding', label: t('sub.tab.branding') },
    { key: 'extensions', href: '/subscription/extensions', label: t('sub.tab.extensions') },
    { key: 'export', href: '/subscription/export', label: t('sub.tab.export') },
    { key: 'support', href: '/subscription/support', label: t('sub.tab.support') },
    { key: 'integrations', href: '/subscription/integrations', label: t('sub.tab.integrations') },
  ];
  return <SubNav label={t('sub.tabs')} active={active} items={items.filter((i) => shown(i.key))} />;
}
