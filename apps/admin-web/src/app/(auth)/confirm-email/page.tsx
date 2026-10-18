import { Note } from '@/components/note';
import { getT } from '@/i18n/server';
import { ConfirmEmailForm } from './confirm-email-form';

export const metadata = { title: 'Confirm your new email' };

/** The link mailed to a new sign-in address. A button, not an automatic change: mail scanners open links. */
export default async function ConfirmEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { t } = await getT();
  const { token } = await searchParams;
  return (
    <>
      <section className="self-center">
        <h1 className="text-[2.25rem] font-bold leading-[1.1] tracking-[-0.015em]">{t('confirmEmail.title')}</h1>
        <p className="mt-3 max-w-[46ch] text-muted">{t('confirmEmail.lede')}</p>
      </section>
      <Note denom="blue" className="p-6 sm:p-7">
        {token ? <ConfirmEmailForm token={token} /> : <p className="text-[0.9375rem]">{t('confirmEmail.missing')}</p>}
      </Note>
    </>
  );
}
