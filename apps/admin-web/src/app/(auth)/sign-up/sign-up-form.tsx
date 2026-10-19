'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BusinessTypeField } from '@/components/business-type-field';
import { FormError, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

export function SignUpForm() {
  const { t } = useT();
  const router = useRouter();
  const { pending, error, submit, fieldError } = useSubmit();
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit(
      'POST',
      '/api/auth/signup',
      {
        email: f.get('email'),
        password: f.get('password'),
        displayName: f.get('displayName'),
        businessName: f.get('businessName'),
        tenantSlug: f.get('tenantSlug'),
        businessType: f.get('businessType'),
      },
      { refresh: false },
    );
    if (r.ok) router.replace('/');
  }

  const general = error && error.code !== 'VALIDATION_FAILED' ? error.message : null;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <TextField label={t('auth.businessName')} name="businessName" required autoFocus error={fieldError('businessName')}
        onChange={(e) => !slugTouched && setSlug(slugify(e.target.value))} />
      <TextField label={t('auth.slug')} name="tenantSlug" required value={slug} hint={t('auth.slugHint')}
        error={fieldError('tenantSlug') ?? (error?.code === 'SLUG_UNAVAILABLE' ? error.message : undefined)}
        onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
      <BusinessTypeField error={fieldError('businessType')} />
      <TextField label={t('auth.displayName')} name="displayName" autoComplete="name" required error={fieldError('displayName')} />
      <TextField label={t('auth.email')} name="email" type="email" autoComplete="email" required
        error={fieldError('email') ?? (error?.code === 'EMAIL_UNAVAILABLE' ? error.message : undefined)} />
      <TextField label={t('auth.password')} name="password" type="password" autoComplete="new-password" required minLength={12}
        hint={t('auth.passwordHint')} error={fieldError('password')} />
      <FormError message={general && !['SLUG_UNAVAILABLE', 'EMAIL_UNAVAILABLE'].includes(error!.code) ? general : null} />
      <button className="btn btn-primary mt-1 h-10" disabled={pending}>
        {pending ? t('auth.working') : t('auth.signUp')}
      </button>
    </form>
  );
}
