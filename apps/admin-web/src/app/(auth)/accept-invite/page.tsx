import { Note } from '@/components/note';
import { getT } from '@/i18n/server';
import { AcceptInviteForm } from './accept-invite-form';

export const metadata = { title: 'Accept invitation' };

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { t } = await getT();
  const { token } = await searchParams;
  return (
    <>
      <section className="self-center">
        <h1 className="text-[2.25rem] font-bold leading-[1.1] tracking-[-0.015em]">{t('invite.title')}</h1>
        <p className="mt-3 max-w-[46ch] text-muted">{t('invite.lede')}</p>
      </section>
      <Note denom="green" className="p-6 sm:p-7">
        {token ? <AcceptInviteForm token={token} /> : <p role="alert" className="text-red">{t('invite.invalid')}</p>}
      </Note>
    </>
  );
}
