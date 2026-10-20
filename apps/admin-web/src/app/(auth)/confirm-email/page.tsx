import { AuthFace, AuthStub } from '@/components/auth-note';
import { getT } from '@/i18n/server';
import { ConfirmEmailForm } from './confirm-email-form';

export const metadata = { title: 'Confirm your new email' };

/** The link mailed to a new sign-in address. A button, not an automatic change: mail scanners open links. */
export default async function ConfirmEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { t } = await getT();
  const { token } = await searchParams;
  return (
    <AuthStub denom="blue" face={<AuthFace denom="blue" title={t('confirmEmail.title')} lede={t('confirmEmail.lede')} />}>
      {token ? <ConfirmEmailForm token={token} /> : <p className="text-[0.9375rem]">{t('confirmEmail.missing')}</p>}
    </AuthStub>
  );
}
