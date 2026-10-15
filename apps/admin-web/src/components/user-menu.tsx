'use client';

import { ArrowLeftRight, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';
import { send } from '@/lib/client-api';

export function UserMenu({ tenantName, userName, multiple }: { tenantName: string; userName: string; multiple: boolean }) {
  const { t } = useT();
  const router = useRouter();
  async function signOut() {
    await send('POST', '/api/auth/logout');
    router.replace('/sign-in');
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex min-w-0 flex-col items-end leading-tight">
        <span className="max-w-[44vw] truncate text-[0.875rem] font-semibold text-white sm:max-w-[240px]">{tenantName}</span>
        <span className="max-w-[44vw] truncate text-[0.75rem] text-blue-ink sm:max-w-[240px]">{userName}</span>
      </span>
      {multiple && (
        <button type="button" onClick={() => router.push('/select-business')} title={t('nav.switchBusiness')}
          className="grid size-8 shrink-0 place-items-center rounded-[4px] text-blue-ink hover:bg-white/10 hover:text-white">
          <ArrowLeftRight aria-hidden className="size-4" />
          <span className="sr-only">{t('nav.switchBusiness')}</span>
        </button>
      )}
      <button type="button" onClick={signOut} title={t('nav.signOut')}
        className="grid size-8 shrink-0 place-items-center rounded-[4px] text-blue-ink hover:bg-white/10 hover:text-white">
        <LogOut aria-hidden className="size-4" />
        <span className="sr-only">{t('nav.signOut')}</span>
      </button>
    </div>
  );
}
