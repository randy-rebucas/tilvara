import { Callout, Note, PageHeader, Serial } from '@/components/note';
import { getT } from '@/i18n/server';
import { api, type Business, type Me } from '@/lib/api';
import { SubscriptionTabs } from '../tabs';
import { BusinessTypeForm } from './business-form';

export const metadata = { title: 'Business' };

export default async function BusinessPage() {
  const { t } = await getT();
  const [me, business] = await Promise.all([api<Me>('/me'), api<Business>('/business')]);
  const canEdit = (me.activeTenant?.permissions.includes('tenant.manage') ?? false) && !me.support;
  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageHeader title={t('biz.title')} lede={t('biz.lede')} />
      <SubscriptionTabs active="business" />
      <Note className="px-5 py-4" as="div">
        <p className="font-semibold">{business.name}</p>
        <Serial className="mt-1 block">{business.slug}</Serial>
      </Note>
      <Note className="px-5 py-5" as="div">
        <BusinessTypeForm businessType={business.businessType} canEdit={canEdit} />
      </Note>
      <Callout tone="info">{t('biz.keepsRecords')}</Callout>
    </div>
  );
}
