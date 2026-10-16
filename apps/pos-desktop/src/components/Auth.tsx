import { ChevronRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { ApiFailure, signIn, switchTenant } from '../lib/api';
import type { Me } from '../types';
import { Callout, Field, Note } from './ui';

export function SignIn({ onDone }: { onDone: (activeTenantId: string | null) => void }) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const r = await signIn(String(form.get('email')), String(form.get('password')));
      onDone(r.activeTenantId);
    } catch (err) {
      setError(err instanceof ApiFailure && err.error.status !== 0 ? err.error.message : t('common.network'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-[960px] gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1fr_400px] md:items-center">
      <section>
        <h1 className="text-[2.25rem] font-bold leading-[1.1] tracking-[-0.015em]">{t('signin.title')}</h1>
        <p className="mt-3 max-w-[46ch] text-muted">{t('signin.lede')}</p>
      </section>
      <Note denom="blue" className="p-6">
        <form onSubmit={submit} className="grid gap-4">
          <Field id="email" name="email" type="email" autoComplete="username" required autoFocus label={t('signin.email')} />
          <Field id="password" name="password" type="password" autoComplete="current-password" required label={t('signin.password')} />
          {error && <Callout kind="error">{error}</Callout>}
          <button className="btn btn-primary w-full" disabled={pending}>
            {t('signin.submit')}
          </button>
        </form>
      </Note>
    </div>
  );
}

export function BusinessPicker({ me, onDone }: { me: Me; onDone: () => void }) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-[640px] px-4 py-12 sm:px-6">
      <h1 className="text-[1.75rem] font-bold">{t('business.title')}</h1>
      <div className="mt-6 grid gap-3">
        {me.memberships.map((m) => (
          <button
            key={m.tenantId}
            type="button"
            className="note flex items-center justify-between p-5 text-left hover:border-[#b6ae98]"
            onClick={async () => {
              try {
                await switchTenant(m.tenantId);
                onDone();
              } catch (err) {
                setError(err instanceof ApiFailure ? err.error.message : t('common.error'));
              }
            }}
          >
            <span>
              <span className="block text-[1.0625rem] font-semibold">{m.tenantName}</span>
              <span className="serial block text-[0.8125rem] text-muted">{m.tenantSlug}</span>
            </span>
            <ChevronRight className="size-5 text-muted" aria-hidden />
          </button>
        ))}
        {error && <Callout kind="error">{error}</Callout>}
      </div>
    </div>
  );
}
