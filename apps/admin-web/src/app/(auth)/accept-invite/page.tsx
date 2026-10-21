import { AuthFace, AuthStub } from '@/components/auth-note';
import { getT } from '@/i18n/server';
import { AcceptInviteForm } from './accept-invite-form';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('accept-invite');

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { t } = await getT();
  const { token } = await searchParams;
  return (
    <AuthStub denom="green" face={<AuthFace denom="green" title={t('invite.title')} lede={t('invite.lede')} />}>
      {token ? <AcceptInviteForm token={token} /> : <p role="alert" className="text-red">{t('invite.invalid')}</p>}
    </AuthStub>
  );
}
