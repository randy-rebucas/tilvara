'use client';

import { useEffect, useRef, useState } from 'react';
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

/** The steps in order, with the fields each one holds (a server error jumps back to its step). */
const STEPS = [
  { title: 'auth.stepBusiness', fields: ['businessName', 'tenantSlug'] },
  { title: 'auth.stepAccount', fields: ['displayName', 'email', 'password'] },
] as const;

/** Server refusals that belong to one field rather than the whole form, with their words. */
const FIELD_CODES: Record<string, string> = { SLUG_UNAVAILABLE: 'tenantSlug', SLUG_RESERVED: 'tenantSlug', EMAIL_UNAVAILABLE: 'email' };
const FIELD_WORDS = { SLUG_UNAVAILABLE: 'auth.slugTaken', SLUG_RESERVED: 'auth.slugReserved', EMAIL_UNAVAILABLE: 'auth.emailTaken' } as const;

/**
 * Sign-up in two steps: the business, then the owner's account (a retail business: the only type). Every step stays
 * mounted (hidden when not current) so one form submits all fields at the end.
 */
export function SignUpForm() {
  const { t } = useT();
  const { pending, error, submit, fieldError } = useSubmit();
  const [step, setStep] = useState(0);
  const [missing, setMissing] = useState<string[]>([]);
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);
  const moved = useRef(false);

  // Moving between steps puts the cursor on the step's first field (not on first render: autoFocus does that).
  useEffect(() => {
    if (!moved.current) return;
    stepRefs.current[step]?.querySelector<HTMLInputElement>('input')?.focus();
  }, [step]);

  function goTo(next: number) {
    moved.current = true;
    setStep(next);
  }

  const errorFor = (name: string) =>
    (missing.includes(name) ? t('validation.required') : undefined) ??
    fieldError(name) ??
    (error && FIELD_CODES[error.code] === name ? t(FIELD_WORDS[error.code as keyof typeof FIELD_WORDS]) : undefined);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const empty = STEPS[step]!.fields.filter((name) => !String(f.get(name) ?? '').trim());
    setMissing(empty);
    if (empty.length) return;
    if (step < STEPS.length - 1) return goTo(step + 1);

    const r = await submit(
      'POST',
      '/api/auth/signup',
      {
        email: f.get('email'),
        password: f.get('password'),
        displayName: f.get('displayName'),
        businessName: f.get('businessName'),
        tenantSlug: f.get('tenantSlug'),
      },
      { refresh: false },
    );
    // A full load into the new session (nothing cached from a previous one).
    if (r.ok) return window.location.assign('/');
    // Show the first refused field on its own step.
    const issues = (r.error.details?.issues as { path: string }[] | undefined) ?? [];
    const names = [FIELD_CODES[r.error.code], ...issues.map((i) => i.path)];
    const owner = STEPS.findIndex((s) => names.some((n) => n && (s.fields as readonly string[]).includes(n)));
    if (owner >= 0 && owner !== step) goTo(owner);
  }

  const general = error && error.code !== 'VALIDATION_FAILED' && !FIELD_CODES[error.code] ? error.message : null;
  const last = step === STEPS.length - 1;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <div>
        <ol className="flex gap-1.5" aria-hidden>
          {STEPS.map((s, i) => (
            <li key={s.title} className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-blue' : 'bg-hair-soft'}`} />
          ))}
        </ol>
        <p className="mt-3 text-[0.8125rem] text-muted">{t('auth.stepOf', { n: step + 1, total: STEPS.length })}</p>
        <h2 className="section-title mt-0.5" aria-live="polite">{t(STEPS[step]!.title)}</h2>
      </div>

      <div ref={(el) => { stepRefs.current[0] = el; }} hidden={step !== 0} className="flex flex-col gap-4">
        <TextField label={t('auth.businessName')} name="businessName" required autoFocus error={errorFor('businessName')}
          onChange={(e) => !slugTouched && setSlug(slugify(e.target.value))} />
        <TextField label={t('auth.slug')} name="tenantSlug" required value={slug} hint={t('auth.slugHint')}
          error={errorFor('tenantSlug')}
          onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
      </div>

      <div ref={(el) => { stepRefs.current[1] = el; }} hidden={step !== 1} className="flex flex-col gap-4">
        <TextField label={t('auth.displayName')} name="displayName" autoComplete="name" required error={errorFor('displayName')} />
        <TextField label={t('auth.email')} name="email" type="email" autoComplete="email" required error={errorFor('email')} />
        <TextField label={t('auth.password')} name="password" type="password" autoComplete="new-password" required minLength={12}
          hint={t('auth.passwordHint')} error={errorFor('password')} />
      </div>

      <FormError message={general} />
      <div className="mt-1 flex gap-2">
        {step > 0 && (
          <button type="button" className="btn h-10" disabled={pending} onClick={() => { setMissing([]); goTo(step - 1); }}>
            {t('auth.stepBack')}
          </button>
        )}
        <button className="btn btn-primary h-10 flex-1" disabled={pending}>
          {pending ? t('auth.working') : last ? t('auth.signUp') : t('auth.stepNext')}
        </button>
      </div>
    </form>
  );
}
