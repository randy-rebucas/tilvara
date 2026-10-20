import Link from 'next/link';
import { AuthFace, AuthSplit } from '@/components/auth-note';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { getT } from '@/i18n/server';
import { api, ApiError, type Me, type StaffGrant } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { OpenGrantButton } from './open-grant';

export const metadata = { title: 'Support requests' };

/**
 * Tilvara staff only (ADR-0016 slice 6). Outside the app shell: staff belong to no business. Each row
 * is a business that has given read-only access; opening it is recorded on both sides.
 */
export default async function StaffSupportPage() {
  const { t, lang } = await getT();
  const me = await api<Me>('/me');
  let grants: StaffGrant[] | null = null;
  let problem: 'notStaff' | 'mfa' | null = null;
  try {
    grants = (await api<{ data: StaffGrant[] }>('/support/grants')).data;
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 403) throw e;
    problem = e.code === 'MFA_REQUIRED' ? 'mfa' : 'notStaff';
  }
  const face = (
    <AuthFace denom="none" title={t('staff.title')} lede={t('staff.lede')}>
      <p className="mt-6 text-[0.9375rem] text-muted">
        {me.user.displayName} · {me.user.email}
      </p>
      {me.memberships.length > 0 && (
        <p className="mt-3">
          <Link className="font-semibold text-blue underline" href="/select-business">
            {t('nav.switchBusiness')}
          </Link>
        </p>
      )}
    </AuthFace>
  );
  return (
    <AuthSplit denom="none" face={face}>
      {problem === 'notStaff' && <Callout tone="warn">{t('staff.notStaff')}</Callout>}
      {problem === 'mfa' && (
        <Callout tone="warn">
          {t('staff.mfa')}{' '}
          <Link href="/sign-in" className="font-semibold underline">
            {t('auth.signIn')}
          </Link>
        </Callout>
      )}
      {grants && grants.length === 0 && (
        <Note>
          <Empty>{t('staff.empty')}</Empty>
        </Note>
      )}
      {grants?.map((g) => (
        <Note key={g.id} denom="orange" className="px-5 py-4" as="div">
          <p className="text-[1.0625rem] font-semibold">{g.tenant.name}</p>
          <p className="mt-1">{g.purpose}</p>
          <Serial className="mt-1 block">
            {t('staff.until', { date: formatDateTime(g.expiresAt, lang) })}
            {g.ticketRef && ` · ${g.ticketRef}`}
          </Serial>
          <div className="mt-3">
            <OpenGrantButton grantId={g.id} />
          </div>
        </Note>
      ))}
    </AuthSplit>
  );
}
