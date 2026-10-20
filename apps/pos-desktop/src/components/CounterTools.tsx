import { toDec } from '@1pos/money';
import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api } from '../lib/api';
import { parseAmount } from '../lib/money';
import type { CounterCustomer } from '../types';
import { errorText } from './Payment';
import { Callout, Field, Money, Note } from './ui';

/** An ordinary discount on one cart line: a percentage (sent as a rate) or an amount off. */
export type LineDiscount = { kind: 'RATE'; percent: string } | { kind: 'AMOUNT'; amount: string };

/** "10" → "0.1": the API takes a rate in (0, 1]; never via JS numbers. */
export const rateOf = (percent: string) => toDec(percent).dividedBy(100).toString();

/** A price approved for one line (session 20): the approval is used once, by the cashier who asked. */
export interface LineOverride {
  id: string;
  unitPrice: string;
  approvedByName: string | null;
}

/** An exchange started from "This shift": what comes back and the refund it gives towards new items. */
export interface ExchangeStart {
  saleId: string;
  saleNumber: number;
  reason: string;
  returnLines: { saleLineId: string; quantity: string; disposition: 'RESTOCK' | 'DAMAGED' }[];
  refund: string;
  items: { name: string; quantity: string }[];
}

export interface HeldCart {
  id: string;
  label: string;
  heldByName: string | null;
  lineCount: number;
  amountDue: string | null;
  createdAt: string;
  items: { name: string; quantity: string }[];
}

/** Percent or amount off one line; the server computes the line and refuses it without `sales.discount`. */
export function DiscountPanel({ lineId, current, onApply, onRemove, onCancel }: {
  lineId: string;
  current?: LineDiscount | undefined;
  onApply: (d: LineDiscount) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [kind, setKind] = useState<LineDiscount['kind']>(current?.kind ?? 'RATE');
  const [error, setError] = useState<string | undefined>();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = String(new FormData(e.currentTarget).get('value') ?? '').trim();
    if (kind === 'RATE') {
      if (!/^\d{1,3}(\.\d{1,4})?$/.test(raw) || toDec(raw).lte(0) || toDec(raw).gt(100)) return setError(t('disc.percentInvalid'));
      return onApply({ kind, percent: toDec(raw).toString() });
    }
    const amount = parseAmount(raw);
    if (!amount || toDec(amount).isZero()) return setError(t('register.floatInvalid'));
    onApply({ kind, amount });
  }
  return (
    <form className="mt-3 grid gap-3 rounded-[5px] border border-hair bg-white p-4" onSubmit={submit}>
      <p className="font-semibold">{t('disc.title')}</p>
      <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
        <div className="field">
          <label htmlFor={`dk-${lineId}`}>{t('disc.kind')}</label>
          <select id={`dk-${lineId}`} name="discKind" className="input" value={kind} onChange={(e) => setKind(e.target.value as LineDiscount['kind'])}>
            <option value="RATE">{t('disc.percent')}</option>
            <option value="AMOUNT">{t('disc.amount')}</option>
          </select>
        </div>
        <Field
          id={`dv-${lineId}`}
          name="value"
          inputMode="decimal"
          required
          autoFocus
          label={kind === 'RATE' ? t('disc.percentLabel') : t('disc.amountLabel')}
          defaultValue={current ? (current.kind === 'RATE' ? current.percent : current.amount) : ''}
          error={error}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary">{t('sell.apply')}</button>
        {current && <button type="button" className="btn btn-danger" onClick={onRemove}>{t('disc.remove')}</button>}
        <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

/**
 * A new price for one line. A cashier who may change prices approves it themself; anyone else asks a
 * manager to type their own email and password here (and their code if they use two-step sign-in).
 * The password goes to the server once and is never kept.
 */
export function PricePanel({ lineId, branchId, variantId, listPrice, canApprove, onApproved, onCancel }: {
  lineId: string;
  branchId: string;
  variantId: string;
  listPrice: string | undefined;
  canApprove: boolean;
  onApproved: (o: LineOverride) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const [priceError, setPriceError] = useState<string | undefined>();
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const unitPrice = parseAmount(String(f.get('price') ?? ''));
    if (!unitPrice) return setPriceError(t('register.floatInvalid'));
    setPriceError(undefined);
    const email = String(f.get('approverEmail') ?? '').trim();
    const code = String(f.get('approverCode') ?? '').trim();
    setBusy(true);
    try {
      const o = await api<{ id: string; unitPrice: string; approvedByName: string | null }>('POST', '/v1/price-overrides', {
        branchId, variantId, unitPrice, reason: String(f.get('priceReason') ?? '').trim(),
        ...(!canApprove && { email, password: String(f.get('approverPassword') ?? ''), ...(code && { code }) }),
      });
      onApproved({ id: o.id, unitPrice: o.unitPrice, approvedByName: o.approvedByName });
    } catch (err) {
      const code = (err as { error?: { code?: string } }).error?.code;
      if (code === 'APPROVER_CODE_REQUIRED') setNeedsCode(true);
      setError(code === 'APPROVER_CODE_REQUIRED' ? t('price.needCode') : errorText(err, t('common.error'), t('common.network')));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="mt-3 grid gap-3 rounded-[5px] border border-hair bg-white p-4" onSubmit={submit} autoComplete="off">
      <p className="font-semibold">{t('price.title')}</p>
      {listPrice && <p className="text-[0.8125rem] text-muted">{t('price.list')} <Money value={listPrice} /></p>}
      <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
        <Field id={`np-${lineId}`} name="price" inputMode="decimal" required autoFocus label={t('price.new')} error={priceError} />
        <Field id={`nr-${lineId}`} name="priceReason" required label={t('price.reason')} />
      </div>
      {!canApprove && (
        <div className="grid gap-3 rounded-[5px] border border-dashed border-hair p-3">
          <p className="text-[0.8125rem] text-muted">{t('price.managerHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={`ae-${lineId}`} name="approverEmail" type="email" required label={t('price.managerEmail')} autoComplete="off" />
            <Field id={`ap-${lineId}`} name="approverPassword" type="password" required label={t('price.managerPassword')} autoComplete="new-password" />
          </div>
          {needsCode && <Field id={`ac-${lineId}`} name="approverCode" inputMode="numeric" required label={t('price.managerCode')} autoComplete="one-time-code" />}
        </div>
      )}
      {error && <Callout kind="error">{error}</Callout>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy}>{canApprove ? t('price.apply') : t('price.approve')}</button>
        <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

/** Carts parked at this register: resume one into an empty cart, or discard it. */
export function HeldCartsPanel({ carts, cartEmpty, timezone, onResume, onDiscard }: {
  carts: HeldCart[];
  cartEmpty: boolean;
  timezone: string;
  onResume: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  const { t } = useT();
  const at = (iso: string) => new Intl.DateTimeFormat('en-PH', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  return (
    <Note className="p-4" aria-label={t('hold.listTitle')}>
      <h2 className="section-title mb-2">{t('hold.listTitle')}</h2>
      {!cartEmpty && <p className="mb-2 text-[0.8125rem] text-muted">{t('hold.finishFirst')}</p>}
      <ul className="grid gap-2">
        {carts.map((c) => (
          <li key={c.id} className="row-rule grid gap-2 pb-2 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="min-w-0">
              <p className="font-semibold">{c.label}</p>
              <p className="text-[0.8125rem] text-muted">
                {c.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}
                {c.lineCount > c.items.length ? ` · ${t('hold.more', { n: String(c.lineCount - c.items.length) })}` : ''}
              </p>
              <p className="serial text-[0.75rem] text-muted">
                {at(c.createdAt)}{c.heldByName ? ` · ${c.heldByName}` : ''}{c.amountDue ? <> · <Money value={c.amountDue} /></> : null}
              </p>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary btn-sm" disabled={!cartEmpty} onClick={() => onResume(c.id)}>{t('hold.resume')}</button>
              <button className="btn btn-sm btn-danger" onClick={() => onDiscard(c.id)}>{t('hold.discard')}</button>
            </div>
          </li>
        ))}
      </ul>
    </Note>
  );
}

/** Above the cart while an exchange is under way: what comes back and its credit. */
export function ExchangeBanner({ exchange, total, onCancel }: { exchange: ExchangeStart; total: string | undefined; onCancel: () => void }) {
  const { t } = useT();
  const credit = toDec(exchange.refund);
  const due = total ? toDec(total) : null;
  return (
    <Note denom="orange" className="grid gap-2 p-4" data-testid="exchange-banner">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">{t('exch.title', { n: String(exchange.saleNumber).padStart(6, '0') })}</p>
        <button type="button" className="btn btn-sm" onClick={onCancel}>{t('exch.cancel')}</button>
      </div>
      <p className="text-[0.875rem]">{t('exch.coming')} {exchange.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</p>
      <p className="flex justify-between text-[0.9375rem]"><span>{t('exch.credit')}</span><Money value={exchange.refund} /></p>
      {due && (credit.gte(due) ? (
        <p className="flex justify-between font-semibold"><span>{t('exch.giveBack')}</span><Money value={credit.minus(due).toFixed(2)} /></p>
      ) : (
        <p className="flex justify-between font-semibold"><span>{t('exch.toPay')}</span><Money value={due.minus(credit).toFixed(2)} /></p>
      ))}
      <p className="text-[0.8125rem] text-muted">{t('exch.hint')}</p>
    </Note>
  );
}

/**
 * Put a customer on the sale (ADR-0018): search by name, phone or number, or add one when the person
 * may (customers.manage). Offers are their own yes/no, asked apart from the sale.
 */
export function CustomerPanel({ canAdd, onPick, onCancel }: { canAdd: boolean; onPick: (c: CounterCustomer) => void; onCancel: () => void }) {
  const { t } = useT();
  const [hits, setHits] = useState<{ id: string; displayName: string; phone: string | null; code: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const pick = async (id: string) => {
    try {
      onPick(await api<CounterCustomer>('GET', `/v1/customers/${id}`));
    } catch (err) {
      setError(errorText(err, t('common.error'), t('common.network')));
    }
  };
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('custSearch') ?? '').trim();
    if (!q) return;
    try {
      setHits((await api<{ data: NonNullable<typeof hits> }>('GET', `/v1/customers?q=${encodeURIComponent(q)}&limit=8`)).data);
      setError(null);
    } catch (err) {
      setError(errorText(err, t('common.error'), t('common.network')));
    }
  }
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const c = await api<CounterCustomer>('POST', '/v1/customers', {
        displayName: String(f.get('custName') ?? '').trim(),
        phone: String(f.get('custPhone') ?? '').trim(),
        marketingConsent: f.get('custConsent') === 'on',
        consentSource: 'COUNTER',
      });
      onPick(c);
    } catch (err) {
      setError(errorText(err, t('common.error'), t('common.network')));
    }
  }
  return (
    <Note className="grid gap-3 p-4" aria-label={t('custc.title')}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="section-title">{t('custc.title')}</h2>
        <button type="button" className="btn btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      <form className="flex items-end gap-2" onSubmit={search}>
        <div className="flex-1">
          <Field id="custSearch" name="custSearch" autoFocus autoComplete="off" label={t('custc.search')} />
        </div>
        <button className="btn mb-[2px]">{t('custc.find')}</button>
      </form>
      {hits && (hits.length ? (
        <ul className="grid gap-1">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" className="flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left hover:bg-paper" onClick={() => void pick(h.id)}>
                <span>{h.displayName}</span>
                <span className="serial text-[0.8125rem] text-muted">{[h.code, h.phone].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="text-[0.875rem] text-muted">{t('custc.none')}</p>)}
      {canAdd && !adding && <button type="button" className="btn btn-sm justify-self-start" onClick={() => setAdding(true)}>{t('custc.add')}</button>}
      {adding && (
        <form className="grid gap-3 rounded-[5px] border border-hair bg-white p-3" onSubmit={add} autoComplete="off">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="custName" name="custName" required autoFocus maxLength={200} label={t('custc.name')} />
            <Field id="custPhone" name="custPhone" type="tel" label={t('custc.phone')} />
          </div>
          <label className="flex items-start gap-2 text-[0.875rem]">
            <input type="checkbox" name="custConsent" className="mt-1" /> <span>{t('custc.consent')}</span>
          </label>
          <div className="flex gap-2">
            <button className="btn btn-primary">{t('custc.save')}</button>
            <button type="button" className="btn" onClick={() => setAdding(false)}>{t('common.cancel')}</button>
          </div>
        </form>
      )}
      {error && <Callout kind="error">{error}</Callout>}
    </Note>
  );
}
