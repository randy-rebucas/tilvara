'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { compact, LineItems, readLines, type VariantOption } from '@/components/line-items';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { AccountType } from '@/lib/api';
import { peso, signOf, sumDecimal, todayManila } from '@/lib/format';

const DECIMAL = /^\d{1,14}(\.\d{1,4})?$/;

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

function Actions({ pending, general, submitLabel, close }: { pending: boolean; general: string | null | undefined; submitLabel: string; close: () => void }) {
  const { t } = useT();
  return (
    <div className="col-span-full flex flex-wrap items-center gap-2">
      <button className="btn btn-primary" disabled={pending}>{submitLabel}</button>
      <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
      <FormError message={general} />
    </div>
  );
}

// ---------------------------------------------------------------- manual entry
function EntryFields({ close, legalEntityId, accounts }: { close: () => void; legalEntityId: string; accounts: VariantOption[] }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit<{ id: string }>('POST', '/api/v1/journal-entries', {
      legalEntityId,
      entryDate: text(f, 'entryDate'),
      memo: text(f, 'memo'),
      lines: readLines(f, ['accountId', 'debit', 'credit', 'memo']).map((l) => ({ accountId: l.accountId, ...compact({ debit: l.debit, credit: l.credit, memo: l.memo }) })),
    }, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      close();
      router.push(`/books/entries/${r.data.id}?entity=${legalEntityId}`);
    }
  }
  // A line-level refinement ("either a debit or a credit") is reported on `lines.<i>` itself.
  const lineIssue = (path: string) => fieldError(path) ?? (path.endsWith('.debit') ? fieldError(path.slice(0, -'.debit'.length)) : undefined);
  // Running totals while typing (exact decimals), so an unbalanced entry is visible before posting.
  const [totals, setTotals] = useState({ debit: '0', credit: '0' });
  function onInput(e: React.FormEvent<HTMLFormElement>) {
    const lines = readLines(new FormData(e.currentTarget), ['debit', 'credit']);
    const valid = (v: string | undefined) => (v && DECIMAL.test(v) ? v : '0');
    setTotals({ debit: sumDecimal(lines.map((l) => valid(l.debit))), credit: sumDecimal(lines.map((l) => valid(l.credit))) });
  }
  const difference = sumDecimal([totals.debit, `-${totals.credit}`.replace('--', '')]);
  const balanced = signOf(difference) === 0 && signOf(totals.debit) > 0;
  return (
    <form onSubmit={onSubmit} onInput={onInput} className="grid gap-3 @lg:grid-cols-[12rem_minmax(0,1fr)]" noValidate>
      <TextField label={t('common.date')} name="entryDate" type="date" defaultValue={todayManila()} error={fieldError('entryDate')} />
      <TextField label={t('books.memo')} name="memo" required error={fieldError('memo')} />
      <LineItems
        min={2}
        fields={[
          { name: 'accountId', label: t('books.account'), kind: 'select' },
          { name: 'debit', label: t('books.debit'), kind: 'decimal', placeholder: '0.00' },
          { name: 'credit', label: t('books.credit'), kind: 'decimal', placeholder: '0.00' },
          { name: 'memo', label: `${t('books.lineMemo')} (${t('common.optional')})`, kind: 'text' },
        ]}
        options={accounts}
        fieldError={lineIssue}
        addLabel={t('common.addLine')}
        removeLabel={t('common.removeLine')}
      />
      <p className="col-span-full flex flex-wrap gap-x-5 gap-y-1 text-[0.875rem] text-muted" aria-live="polite">
        <span>{t('books.debit')} <b className="money text-ink">{peso(totals.debit)}</b></span>
        <span>{t('books.credit')} <b className="money text-ink">{peso(totals.credit)}</b></span>
        <span>{t('books.difference')} <b className={`money ${signOf(difference) === 0 ? 'text-ink' : 'text-red'}`}>{peso(difference)}</b></span>
      </p>
      <Actions pending={pending || !balanced} general={general(error) ?? fieldError('lines')} submitLabel={t('books.post')} close={close} />
    </form>
  );
}

export function ManualEntryForm(props: { legalEntityId: string; accounts: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure wide label={t('books.newEntry')}>{(close) => <EntryFields close={close} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- account
function AccountFields({ close, legalEntityId }: { close: () => void; legalEntityId: string }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/v1/accounts', { legalEntityId, code: text(f, 'code').toUpperCase(), name: text(f, 'name'), type: f.get('type') }, { idempotent: true });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 @lg:grid-cols-3" noValidate>
      <TextField label={t('books.code')} name="code" required placeholder="6100" error={fieldError('code')} />
      <TextField label={t('books.accountName')} name="name" required error={fieldError('name')} />
      <SelectField label={t('books.type')} name="type" defaultValue="EXPENSE">
        {TYPES.map((x) => <option key={x} value={x}>{t(`acct.${x}`)}</option>)}
      </SelectField>
      <Actions pending={pending} general={general(error)} submitLabel={t('common.create')} close={close} />
    </form>
  );
}

export function AddAccountForm({ legalEntityId }: { legalEntityId: string }) {
  const { t } = useT();
  return <Disclosure label={t('books.addAccount')}>{(close) => <AccountFields close={close} legalEntityId={legalEntityId} />}</Disclosure>;
}

// ---------------------------------------------------------------- period close
function CloseFields({ close, legalEntityId, defaultMonth }: { close: () => void; legalEntityId: string; defaultMonth: string }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await submit('POST', '/api/v1/accounting/periods/close', { legalEntityId, month: text(new FormData(e.currentTarget), 'month') });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 @lg:grid-cols-3" noValidate>
      <TextField label={t('books.month')} name="month" type="month" defaultValue={defaultMonth} error={fieldError('month')} />
      <Actions pending={pending} general={general(error)} submitLabel={t('books.closeMonth')} close={close} />
    </form>
  );
}

export function ClosePeriodForm(props: { legalEntityId: string; defaultMonth: string }) {
  const { t } = useT();
  return <Disclosure label={t('books.closeMonth')}>{(close) => <CloseFields close={close} {...props} />}</Disclosure>;
}
