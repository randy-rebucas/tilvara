import Link from 'next/link';
import { Note } from '@/components/note';
import { getT } from '@/i18n/server';
import { ResetPasswordForm } from './reset-password-form';

export const metadata = { title: 'New password' };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { t } = await getT();
  const { token } = await searchParams;
  return (
    <>
      <section className="self-center">
        <h1 className="text-[2.25rem] font-bold leading-[1.1] tracking-[-0.015em]">{t('reset.title')}</h1>
        <p className="mt-3 max-w-[46ch] text-muted">{t('reset.lede')}</p>
      </section>
      <Note denom="blue" className="p-6 sm:p-7">
        {token ? (
          <ResetPasswordForm token={token} />
        ) : (
          <p className="text-[0.9375rem]">
            {t('reset.missing')}{' '}
            <Link className="font-semibold text-blue underline" href="/forgot-password">
              {t('reset.send')}
            </Link>
          </p>
        )}
      </Note>
    </>
  );
}
