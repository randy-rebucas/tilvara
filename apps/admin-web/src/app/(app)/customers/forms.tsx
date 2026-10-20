'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { Customer } from '@/lib/api';

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);

/**
 * The profile fields (ADR-0018): a name is enough; the rest only when the business needs it. On a new
 * customer, marketing consent is its own question with how it was given; corrections leave it alone.
 */
function CustomerFields({ customer, close }: { customer?: Customer; close: () => void }) {
  const { t } = useT();
  const router = useRouter();
  const { pending, submit, fieldError, error } = useSubmit();
  const [consent, setConsent] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const profile = {
      displayName: text(f, 'displayName'),
      code: text(f, 'code'),
      phone: text(f, 'phone'),
      email: text(f, 'email'),
      tin: text(f, 'tin'),
      address: text(f, 'address'),
      notes: text(f, 'notes'),
    };
    if (customer) {
      const r = await submit('PATCH', `/api/v1/customers/${customer.id}`, profile);
      if (r.ok) close();
      return;
    }
    const r = await submit<{ id: string }>('POST', '/api/v1/customers', { ...profile, marketingConsent: consent, consentSource: text(f, 'consentSource') || 'ADMIN' }, { refresh: false });
    if (r.ok) router.push(`/customers/${r.data.id}`);
  }
  const optional = (label: string) => `${label} (${t('common.optional')})`;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <TextField label={t('cust.name')} name="displayName" required autoFocus maxLength={200} defaultValue={customer?.displayName} error={fieldError('displayName')} />
      <TextField label={optional(t('cust.phone'))} name="phone" type="tel" defaultValue={customer?.phone ?? ''} error={fieldError('phone')} />
      <TextField label={optional(t('auth.email'))} name="email" type="email" defaultValue={customer?.email ?? ''} error={fieldError('email')} />
      <TextField label={optional(t('cust.code'))} name="code" maxLength={40} defaultValue={customer?.code ?? ''} hint={t('cust.codeHint')} error={fieldError('code')} />
      <TextField label={optional(t('loc.tin'))} name="tin" inputMode="numeric" defaultValue={customer?.tin ?? ''} hint={t('cust.tinHint')} error={fieldError('tin')} />
      <TextField label={optional(t('cust.address'))} name="address" maxLength={500} defaultValue={customer?.address ?? ''} error={fieldError('address')} />
      <div className="sm:col-span-2 lg:col-span-3">
        <TextField label={optional(t('cust.notes'))} name="notes" maxLength={1000} defaultValue={customer?.notes ?? ''} hint={t('cust.notesHint')} error={fieldError('notes')} />
      </div>
      {!customer && (
        <fieldset className="grid gap-2 rounded-[5px] border border-hair p-3 sm:col-span-2 lg:col-span-3">
          <legend className="px-1 text-[0.875rem] font-semibold">{t('cust.consentTitle')}</legend>
          <label className="flex items-start gap-2 text-[0.9375rem]">
            <input type="checkbox" name="marketingConsent" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{t('cust.consentLabel')}</span>
          </label>
          <p className="text-[0.8125rem] text-muted">{t('cust.consentHint')}</p>
          {consent && (
            <SelectField label={t('cust.consentSource')} name="consentSource" defaultValue="ADMIN">
              <option value="ADMIN">{t('cust.source.ADMIN')}</option>
              <option value="COUNTER">{t('cust.source.COUNTER')}</option>
              <option value="REQUEST">{t('cust.source.REQUEST')}</option>
            </SelectField>
          )}
        </fieldset>
      )}
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{customer ? t('common.save') : t('common.create')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

export function AddCustomerForm() {
  const { t } = useT();
  return <Disclosure label={t('cust.add')}>{(close) => <CustomerFields close={close} />}</Disclosure>;
}

export function EditCustomerForm({ customer }: { customer: Customer }) {
  const { t } = useT();
  return <Disclosure label={t('cust.edit')} kind="edit">{(close) => <CustomerFields customer={customer} close={close} />}</Disclosure>;
}

/** Give or withdraw marketing consent, saying how it was given (kept as history). */
export function ConsentForm({ customer }: { customer: Customer }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [source, setSource] = useState(customer.marketingConsent ? 'REQUEST' : 'ADMIN');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <SelectField label={t('cust.consentSource')} name="source" value={source} onChange={(e) => setSource(e.target.value)}>
        <option value="ADMIN">{t('cust.source.ADMIN')}</option>
        <option value="COUNTER">{t('cust.source.COUNTER')}</option>
        <option value="REQUEST">{t('cust.source.REQUEST')}</option>
      </SelectField>
      <button
        type="button"
        className="btn mb-[2px]"
        disabled={pending}
        onClick={() => void submit('POST', `/api/v1/customers/${customer.id}/consent`, { marketingConsent: !customer.marketingConsent, source })}
      >
        {customer.marketingConsent ? t('cust.withdraw') : t('cust.give')}
      </button>
      <FormError message={error?.message} />
    </div>
  );
}

/** Everything held about the customer, as a JSON file (a data subject's access request). */
export function ExportButton({ customer }: { customer: Customer }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  async function run() {
    const r = await submit<unknown>('POST', `/api/v1/customers/${customer.id}/export`, {}, { refresh: false });
    if (!r.ok) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `customer-${customer.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn" disabled={pending} onClick={() => void run()}>{t('cust.export')}</button>
      <FormError message={error?.message} />
    </span>
  );
}
