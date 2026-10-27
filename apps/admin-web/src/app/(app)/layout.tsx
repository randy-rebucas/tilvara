import { redirect } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { LangSwitch } from '@/components/lang-switch';
import { UserMenu } from '@/components/user-menu';
import { api, apiOrNull, type Me, type Subscription } from '@/lib/api';
import { getT } from '@/i18n/server';
import { Callout } from '@/components/note';
import { formatDateTime } from '@/lib/format';
import { LeaveSupportButton } from '../(auth)/support/open-grant';
import { brandImageUrl, brandVars } from '@/lib/brand';
import { SUPPORT_EMAIL } from '@/lib/config';
import { trialEndingSoon } from '@/lib/subscription';

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
  // Only people who may see the plan (subscription.manage / tenant.manage) get it: they are the ones who can renew.
  const sub = await apiOrNull<Subscription>('/subscription');
  const suspended = me.activeTenant.status === 'SUSPENDED';
  const readOnly = !suspended && (me.activeTenant.access ?? sub?.access) === 'READ_ONLY';
  const trialEnds = sub && !suspended ? trialEndingSoon(sub) : null;
  // Until online billing (D6) an owner renews by writing to support (`ONEPOS_SUPPORT_EMAIL`).
  const contact = SUPPORT_EMAIL ? (
    <>
      {' '}
      {t('sub.contact')}{' '}
      <a href={`mailto:${SUPPORT_EMAIL}`} className="font-semibold underline">{SUPPORT_EMAIL}</a>.
    </>
  ) : null;
  const branding = me.activeTenant.branding;
  const brandName = branding?.displayName || tenantName || 'Tilvara';

  return (
    <div className="min-h-dvh">
      {/* The business's colour and logo (session 39) on the band only; the pages keep their denomination colours. */}
      <header className="band sticky top-0 z-20 text-white print:hidden" style={brandVars(branding?.brandColor)}>
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 px-4 sm:px-7 lg:h-16 lg:flex-nowrap lg:gap-x-4">
          {/* The business's logo and its own name (its Branding name, else its name; session 41). From lg the tabs
              share this line: the logo gets 64px and the name 104px, whole on hover. */}
          <a href="/" className="flex h-14 min-w-0 shrink items-center gap-2.5 text-[1.375rem] font-bold tracking-[0.02em] lg:h-auto lg:shrink-0">
            {branding?.logoSha256 && (
              <img src={brandImageUrl('logo', branding.logoSha256)} alt="" className="brand-logo h-10 w-auto max-w-[104px] object-contain lg:h-9 lg:max-w-[64px]" />
            )}
            <span data-testid="band-name" className="block min-w-0 max-w-[14rem] truncate lg:max-w-[104px] lg:text-[1.125rem]" title={brandName}>
              {brandName}
            </span>
          </a>
          {/* Below lg the tabs move to their own scrollable row under the band's first line. */}
          <div className="nav-fade order-last -mx-4 w-[calc(100%+2rem)] border-t border-white/15 px-3 py-1.5 sm:-mx-7 sm:w-[calc(100%+3.5rem)] sm:px-6 lg:order-none lg:mx-0 lg:w-auto lg:min-w-0 lg:border-0 lg:p-0">
            <AppNav permissions={me.activeTenant.permissions} extensions={me.activeTenant.extensions ?? []} />
          </div>
          {/* Below lg it shares the wordmark's line and shrinks (the names truncate) rather than wrapping. Sized by its
              content (flex-auto, not basis 0), so the business's name shrinks too and the icons stay on screen. */}
          <div className="ml-auto flex min-w-0 flex-auto items-center justify-end gap-3 sm:gap-4 lg:flex-none">
            <LangSwitch onBand />
            <UserMenu tenantName={tenantName} userName={me.user.displayName} multiple={me.memberships.length > 1} />
          </div>
        </div>
      </header>
      {me.support && (
        <div className="mx-auto max-w-[1440px] px-4 pt-4 sm:px-7 print:hidden">
          <Callout tone="warn">
            {t('staff.banner', { business: me.support.tenantName, date: formatDateTime(me.support.expiresAt, lang) })} <LeaveSupportButton />
          </Callout>
        </div>
      )}
      {mfaDue && (
        <div className="mx-auto max-w-[1440px] px-4 pt-4 sm:px-7 print:hidden">
          <Callout tone="warn">
            {t('mfa.banner', { date: formatDateTime(mfaDue, lang) })}{' '}
            <a href="/security" className="font-semibold underline">
              {t('mfa.bannerLink')}
            </a>
          </Callout>
        </div>
      )}
      {(suspended || readOnly || trialEnds) && (
        <div className="mx-auto max-w-[1440px] px-4 pt-4 sm:px-7 print:hidden" data-testid="subscription-notice">
          {suspended ? (
            <Callout tone="warn">{sub ? <>{t('sub.suspendedOwner')}{contact}</> : t('sub.suspended')}</Callout>
          ) : readOnly ? (
            <Callout tone="warn">{sub ? <>{t('sub.readOnly')}{contact}</> : t('sub.readOnlyMember')}</Callout>
          ) : (
            <Callout tone="info">{t('sub.trialEnding', { date: formatDateTime(trialEnds, lang) })}{contact}</Callout>
          )}
        </div>
      )}
      <main className="reveal mx-auto max-w-[1440px] px-4 py-7 sm:px-7">{children}</main>
    </div>
  );
}
