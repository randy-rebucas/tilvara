import { redirect } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { LangSwitch } from '@/components/lang-switch';
import { UserMenu } from '@/components/user-menu';
import { api, apiOrNull, type Me, type Subscription } from '@/lib/api';
import { getT } from '@/i18n/server';
import { Callout } from '@/components/note';
import { formatDateTime } from '@/lib/format';
import { LeaveSupportButton } from '../(auth)/support/open-grant';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await api<Me>('/me');
  if (!me.activeTenant) redirect('/select-business');
  // Two-step sign-in (ADR-0016): once it is due, or the session predates enrolment, the API closes
  // business routes, so send the person where they can fix it instead of rendering errors.
  const mfaBlocked =
    me.mfa.required && !me.mfa.sessionVerified && (me.mfa.enabled || (me.mfa.dueAt !== null && new Date(me.mfa.dueAt).getTime() <= Date.now()));
  if (mfaBlocked) redirect('/security');
  const mfaDue = me.mfa.required && !me.mfa.enabled ? me.mfa.dueAt : null;
  const { t, lang } = await getT();
  const current = me.memberships.find((m) => m.tenantId === me.activeTenant!.tenantId);
  // Tilvara staff in a business's support view (ADR-0016 slice 6): no membership, so the name comes from the grant.
  const tenantName = current?.tenantName ?? me.support?.tenantName ?? '';
  const sub = await apiOrNull<Subscription>('/subscription');

  return (
    <div className="min-h-dvh">
      <header className="band sticky top-0 z-20 text-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 px-4 sm:px-7 lg:h-16 lg:flex-nowrap">
          <a href="/" className="flex h-14 items-center text-[1.5rem] font-bold tracking-[0.04em] lg:h-auto">
            Tilvara
          </a>
          {/* Below lg the tabs move to their own scrollable row under the band's first line. */}
          <div className="nav-fade order-last -mx-4 w-[calc(100%+2rem)] border-t border-white/15 px-3 py-1.5 sm:-mx-7 sm:w-[calc(100%+3.5rem)] sm:px-6 lg:order-none lg:mx-0 lg:w-auto lg:min-w-0 lg:border-0 lg:p-0">
            <AppNav permissions={me.activeTenant.permissions} />
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-3 sm:gap-4">
            <LangSwitch onBand />
            <UserMenu tenantName={tenantName} userName={me.user.displayName} multiple={me.memberships.length > 1} />
          </div>
        </div>
      </header>
      {me.support && (
        <div className="mx-auto max-w-[1440px] px-4 pt-4 sm:px-7">
          <Callout tone="warn">
            {t('staff.banner', { business: me.support.tenantName, date: formatDateTime(me.support.expiresAt, lang) })} <LeaveSupportButton />
          </Callout>
        </div>
      )}
      {mfaDue && (
        <div className="mx-auto max-w-[1440px] px-4 pt-4 sm:px-7">
          <Callout tone="warn">
            {t('mfa.banner', { date: formatDateTime(mfaDue, lang) })}{' '}
            <a href="/security" className="font-semibold underline">
              {t('mfa.bannerLink')}
            </a>
          </Callout>
        </div>
      )}
      {sub?.access === 'READ_ONLY' && (
        <div className="mx-auto max-w-[1440px] px-4 pt-4 sm:px-7">
          <Callout tone="warn">{t('sub.readOnly')}</Callout>
        </div>
      )}
      <main className="reveal mx-auto max-w-[1440px] px-4 py-7 sm:px-7">{children}</main>
    </div>
  );
}
