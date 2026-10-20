'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { UninvoicedReceipt } from '@/lib/api';
import { formatDate, formatDateTime, peso, signOf, sumDecimal } from '@/lib/format';
import { docNo } from '@/lib/options';

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/**
 * Enter a supplier invoice against whole goods receipts of one branch and supplier (picked on the
 * page, which lists the receipts still waiting for an invoice). One Idempotency-Key per open form.
 */
function InvoiceFields({ close, supplierId, receipts, today }: { close: () => void; supplierId: string; receipts: UninvoicedReceipt[]; today: string }) {
  const { t, lang } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  const [picked, setPicked] = useState<string[]>(receipts.length === 1 ? [receipts[0]!.id] : []);
  const selectedValue = sumDecimal(receipts.filter((r) => picked.includes(r.id)).map((r) => r.uninvoicedAmount));

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const dueDate = text(f, 'dueDate');
    const notes = text(f, 'notes');
    const r = await submit<{ id: string }>('POST', '/api/v1/supplier-invoices', {
      supplierId,
      invoiceNumber: text(f, 'invoiceNumber'),
      invoiceDate: text(f, 'invoiceDate'),
      ...(dueDate ? { dueDate } : {}),
      goodsReceiptIds: picked,
      netAmount: text(f, 'netAmount'),
      vatAmount: text(f, 'vatAmount') || '0',
      ...(notes ? { notes } : {}),
    }, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      close();
      router.push(`/purchasing/invoices/${r.data.id}`);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[0.875rem] text-muted">{t('ap.pickReceipts')}</legend>
        {receipts.map((r) => (
          <label key={r.id} className="flex items-center gap-3 rounded-[5px] border border-hair-soft p-3">
            <input
              type="checkbox"
              className="size-4"
              checked={picked.includes(r.id)}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))}
            />
            <span className="min-w-0 flex-1">
              <span className="serial font-semibold">{docNo(r.receiptNumber)}</span>
              <span className="serial ml-2 text-[0.8125rem] text-muted">{formatDateTime(r.receivedAt, lang)}{r.supplierInvoiceRef ? ` · ${r.supplierInvoiceRef}` : ''}</span>
            </span>
            <span className="money font-semibold">{peso(r.uninvoicedAmount)}</span>
          </label>
        ))}
        <p className="text-[0.875rem]">{t('ap.selectedValue', { amount: peso(selectedValue) })}</p>
        <FormError message={fieldError('goodsReceiptIds')} />
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label={t('ap.invoiceNo')} name="invoiceNumber" required autoFocus error={fieldError('invoiceNumber')} />
        <TextField label={t('ap.invoiceDate')} name="invoiceDate" type="date" required defaultValue={today} max={today} error={fieldError('invoiceDate')} />
        <TextField label={`${t('ap.dueDate')} (${t('common.optional')})`} name="dueDate" type="date" hint={t('ap.dueDateHint')} error={fieldError('dueDate')} />
        <TextField label={t('ap.net')} name="netAmount" inputMode="decimal" required placeholder="0.00" error={fieldError('netAmount')} />
        <TextField label={t('ap.vat')} name="vatAmount" inputMode="decimal" placeholder="0.00" error={fieldError('vatAmount')} />
        <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="notes" error={fieldError('notes')} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending || picked.length === 0}>{t('ap.record')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

export function NewInvoiceForm(props: { supplierId: string; receipts: UninvoicedReceipt[]; today: string }) {
  const { t } = useT();
  return <Disclosure label={t('ap.new')}>{(close) => <InvoiceFields close={close} {...props} />}</Disclosure>;
}

const METHODS = ['BANK_TRANSFER', 'CHECK', 'OTHER'] as const;

/** Pay part or all of the open balance (never more: the API refuses an overpayment). */
function PaymentFields({ close, invoiceId, balance, today }: { close: () => void; invoiceId: string; balance: string; today: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const reference = text(f, 'reference');
    const r = await submit('POST', `/api/v1/supplier-invoices/${invoiceId}/payments`, {
      amount: text(f, 'amount'),
      paidOn: text(f, 'paidOn'),
      method: f.get('method'),
      ...(reference ? { reference } : {}),
    }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <TextField label={t('ap.amount')} name="amount" inputMode="decimal" required autoFocus defaultValue={balance} error={fieldError('amount')} />
      <TextField label={t('ap.paidOn')} name="paidOn" type="date" required defaultValue={today} max={today} error={fieldError('paidOn')} />
      <SelectField label={t('ap.method')} name="method">
        {METHODS.map((m) => <option key={m} value={m}>{t(`ap.method.${m}`)}</option>)}
      </SelectField>
      <TextField label={`${t('ap.reference')} (${t('common.optional')})`} name="reference" error={fieldError('reference')} />
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('ap.pay')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

export function PaymentForm(props: { invoiceId: string; balance: string; today: string }) {
  const { t } = useT();
  return <Disclosure label={t('ap.pay')}>{(close) => <PaymentFields close={close} {...props} />}</Disclosure>;
}

/**
 * A supplier's credit or debit note against this invoice (session 22): what is owed goes down or up.
 * A credit note never takes the invoice below what is already paid (the API refuses it).
 */
function NoteFields({ close, invoiceId, today }: { close: () => void; invoiceId: string; today: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', `/api/v1/supplier-invoices/${invoiceId}/notes`, {
      kind: f.get('kind'),
      noteNumber: text(f, 'noteNumber'),
      noteDate: text(f, 'noteDate'),
      netAmount: text(f, 'netAmount'),
      vatAmount: text(f, 'vatAmount') || '0',
      reason: text(f, 'reason'),
    }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <p className="col-span-full text-[0.875rem] text-muted">{t('ap.noteHint')}</p>
      <SelectField label={t('ap.noteKind')} name="kind" defaultValue="CREDIT">
        {(['CREDIT', 'DEBIT'] as const).map((k) => <option key={k} value={k}>{t(`ap.noteKind.${k}`)}</option>)}
      </SelectField>
      <TextField label={t('ap.noteNo')} name="noteNumber" required autoFocus error={fieldError('noteNumber')} />
      <TextField label={t('ap.noteDate')} name="noteDate" type="date" required defaultValue={today} max={today} error={fieldError('noteDate')} />
      <TextField label={t('ap.net')} name="netAmount" inputMode="decimal" required placeholder="0.00" error={fieldError('netAmount')} />
      <TextField label={t('ap.vat')} name="vatAmount" inputMode="decimal" placeholder="0.00" error={fieldError('vatAmount')} />
      <TextField label={t('ap.noteReason')} name="reason" required maxLength={500} error={fieldError('reason')} />
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('ap.recordNote')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

export function NoteForm(props: { invoiceId: string; today: string }) {
  const { t } = useT();
  return <Disclosure label={t('ap.newNote')}>{(close) => <NoteFields close={close} {...props} />}</Disclosure>;
}

/** One payment over several open invoices of a supplier (session 22): an amount per invoice, at most its balance. */
export function BatchPaymentForm({ supplierId, invoices, today }: { supplierId: string; invoices: { id: string; invoiceNumber: string; dueDate: string; balance: string }[]; today: string }) {
  const { t, lang } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(invoices.map((i) => [i.id, ''])));
  const chosen = invoices.filter((i) => /^\d+(\.\d{1,2})?$/.test((amounts[i.id] ?? '').trim()) && signOf(amounts[i.id]!.trim()) > 0);
  const total = sumDecimal(chosen.map((i) => amounts[i.id]!.trim()));

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const reference = text(f, 'reference');
    const r = await submit<{ id: string }>('POST', '/api/v1/supplier-payments', {
      supplierId,
      paidOn: text(f, 'paidOn'),
      method: f.get('method'),
      ...(reference ? { reference } : {}),
      allocations: chosen.map((i) => ({ supplierInvoiceId: i.id, amount: amounts[i.id]!.trim() })),
    }, { idempotencyKey: key, refresh: false });
    if (r.ok) router.push(`/purchasing/payments/${r.data.id}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <ul className="flex flex-col gap-2">
        {invoices.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 rounded-[5px] border border-hair-soft p-3">
            <span className="min-w-0 flex-1">
              <span className="serial font-semibold">{i.invoiceNumber}</span>
              <span className="serial ml-2 text-[0.8125rem] text-muted">{t('ap.dueDate')} {formatDate(i.dueDate, lang)} · {t('ap.balance')} {peso(i.balance)}</span>
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setAmounts((a) => ({ ...a, [i.id]: i.balance }))}>{t('ap.balance')}</button>
            <label className="sr-only" htmlFor={`pay-${i.id}`}>{`${t('ap.amount')} ${i.invoiceNumber}`}</label>
            <input id={`pay-${i.id}`} className="input w-36" inputMode="decimal" placeholder="0.00" value={amounts[i.id] ?? ''} onChange={(e) => setAmounts((a) => ({ ...a, [i.id]: e.target.value }))} />
          </li>
        ))}
      </ul>
      <p className="text-[0.9375rem] font-semibold">{t('ap.payManyTotal', { amount: peso(total) })}</p>
      <FormError message={fieldError('allocations')} />
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label={t('ap.paidOn')} name="paidOn" type="date" required defaultValue={today} max={today} error={fieldError('paidOn')} />
        <SelectField label={t('ap.method')} name="method">
          {METHODS.map((m) => <option key={m} value={m}>{t(`ap.method.${m}`)}</option>)}
        </SelectField>
        <TextField label={`${t('ap.reference')} (${t('common.optional')})`} name="reference" error={fieldError('reference')} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending || chosen.length === 0}>{t('ap.payManyRecord')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}
