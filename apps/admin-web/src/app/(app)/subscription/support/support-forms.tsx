'use client';

import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

const HOURS = [2, 4, 8, 24, 48, 72];

/** Read-only access for a stated purpose and a set number of hours (72 at most, held by the API and the database). */
export function GiveAccessForm() {
  const { t } = useT();
  return <Disclosure label={t('support.give')}>{(close) => <GrantFields close={close} />}</Disclosure>;
}

function GrantFields({ close }: { close: () => void }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit(
      'POST',
      '/api/v1/support-access',
      { purpose: String(f.get('purpose') ?? '').trim(), hours: Number(f.get('hours')), ticketRef: String(f.get('ticketRef') ?? '').trim() || undefined },
      { idempotent: true },
    );
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <TextField label={t('support.purpose')} name="purpose" required autoFocus maxLength={500} hint={t('support.purposeHint')} error={fieldError('purpose')} />
      <SelectField span="half" label={t('support.hours')} name="hours" defaultValue="24">
        {HOURS.map((h) => <option key={h} value={h}>{t('support.hoursN', { n: h })}</option>)}
      </SelectField>
      <TextField span="half" label={t('support.ticket')} name="ticketRef" maxLength={100} error={fieldError('ticketRef')} />
      <div className="form-actions">
        <button className="btn btn-primary" disabled={pending}>{t('support.grant')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      </div>
    </form>
  );
}
