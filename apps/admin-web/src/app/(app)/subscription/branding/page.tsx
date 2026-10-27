import { Note, PageHeader } from '@/components/note';
import { getT } from '@/i18n/server';
import { api, type Branding, type Business, type Me } from '@/lib/api';
import { pageTitle } from '@/i18n/page-title';
import { SHOP_DOMAIN } from '@/lib/shop-host';
import { SubscriptionTabs } from '../tabs';
import { BrandImages, BrandingForm } from './branding-form';

export const generateMetadata = pageTitle('subscription.branding');

/** How the business presents itself on the till, the customer display, receipts, the band and its sign-in page (session 39). */
export default async function BrandingPage() {
  const { t } = await getT();
  const [me, business, branding] = await Promise.all([api<Me>('/me'), api<Business>('/business'), api<Branding>('/business/branding')]);
  const canEdit = (me.activeTenant?.permissions.includes('tenant.manage') ?? false) && !me.support;
  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageHeader title={t('brand.title')} lede={t('brand.lede')} />
      <SubscriptionTabs active="branding" />
      <Note className="px-5 py-5">
        <h2 id="brand-images" className="text-[1.0625rem] font-semibold">{t('brand.images')}</h2>
        <p className="mt-1 text-[0.875rem] text-muted">{t('brand.imagesLede')}</p>
        <BrandImages branding={branding} canEdit={canEdit} />
      </Note>
      <BrandingForm branding={branding} businessName={business.name} slug={business.slug} shopDomain={SHOP_DOMAIN} canEdit={canEdit} />
    </div>
  );
}
