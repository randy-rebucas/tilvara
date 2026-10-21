import Link from 'next/link';
import { api, type Me } from '@/lib/api';
import { getT } from '@/i18n/server';
import { BusinessPicker } from './picker';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('select-business');

export default async function SelectBusinessPage() {
  const { t } = await getT();
  const me = await api<Me>('/me');
  return (
    <div className="min-h-dvh">
      <header className="band flex h-16 items-center px-6 text-white sm:px-8">
        <span className="text-[1.5rem] font-bold tracking-[0.04em]">Tilvara</span>
      </header>
      <main className="mx-auto max-w-[640px] px-4 py-12 sm:px-6">
        <h1 className="text-[1.75rem] font-bold">{t('select.title')}</h1>
        <p className="mt-1 text-muted">{t('select.lede')}</p>
        <BusinessPicker memberships={me.memberships} activeTenantId={me.activeTenant?.tenantId ?? null} />
        {me.staff && (
          <p className="mt-6">
            <Link href="/support" className="font-semibold text-blue underline">{t('staff.link')}</Link>
          </p>
        )}
      </main>
    </div>
  );
}
