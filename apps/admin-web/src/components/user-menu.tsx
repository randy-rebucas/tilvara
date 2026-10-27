'use client';

import { ArrowLeftRight, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';
import { send } from '@/lib/client-api';
import { HelpLink } from './help-link';

export function UserMenu({ tenantName, userName, multiple }: { tenantName: string; userName: string; multiple: boolean }) {
  const { t } = useT();
  const router = useRouter();
  async function signOut() {
    await send('POST', '/api/auth/logout');
    // A full load: nothing of the signed-out session stays in the router cache.
    window.location.replace('/sign-in');
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <HelpLink />
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
      {/* The person's own account (name, email, two-step sign-in, closing it); the names are the link, no extra icon.
          Last on the band, after the icons. From lg the tabs share this row, so a long business name is cut shorter
          there (full name in the tooltip); 96px since the help button joined the icons (all twelve tabs must still
          fit at 1440px). */}
      <a href="/account" title={`${tenantName} · ${userName} — ${t('account.title')}`} className="group flex min-w-0 flex-col items-end leading-tight">
        <span className="max-w-[min(44vw,100%)] truncate text-[0.875rem] font-semibold text-white sm:max-w-[240px] lg:max-w-[96px]">{tenantName}</span>
        <span className="max-w-[min(44vw,100%)] truncate text-[0.75rem] text-blue-ink underline-offset-2 group-hover:underline sm:max-w-[240px] lg:max-w-[96px]">{userName}</span>
      </a>
    </div>
  );
}
