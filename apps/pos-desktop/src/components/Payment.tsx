import { CreditCard, QrCode } from 'lucide-react';
import { useRef, useState } from 'react';
import { useT, type MessageKey } from '../i18n';
import { api, ApiFailure, uuid, withReference } from '../lib/api';
import { add, gte, isPositive, isZero, parseAmount, quickTenders, sub } from '../lib/money';
import type { PaymentIntent } from '../types';
import type { Shift } from './Registers';
import { Callout, methodLabel, Money, Note, PaymentTag } from './ui';

export type Notice = { kind: 'error' | 'warn' | 'info'; text: string } | null;
export type Tender = { method: 'INTENT'; paymentIntentId: string } | { method: 'CASH'; tendered: string };

/** No answer, or the server/database failed: the request may or may not have taken effect. */
export const unanswered = (err: unknown) => err instanceof ApiFailure && (err.error.status === 0 || err.error.status >= 500);

export const errorText = (err: unknown, fallback: string, network: string) =>
  err instanceof ApiFailure ? (unanswered(err) ? withReference(network, err) : err.error.message) : fallback;

/**
 * Taking payment for one sale (ADR-0009/0010): card/QR intents first, cash for the rest.
 * One payment = one terminal transaction id; its sale key is kept when an answer is lost, so a retry
 * can never record twice.
 */
export function usePayment({ shift, due, setNotice }: {
  shift: Shift;
  due: string;
  setNotice: (n: Notice | ((n: Notice) => Notice)) => void;
}) {
  const { t } = useT();
  const [txId, setTxId] = useState(uuid);
  const [saleKey, setSaleKey] = useState(uuid);
  const [intents, setIntents] = useState<PaymentIntent[]>([]);
  const [cash, setCash] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Synchronous guards: a double click lands before React re-renders the disabled button.
  const busy = useRef(false);
  // Card/QR request whose answer never arrived: retried with the same key, so it cannot charge twice.
  const unansweredIntent = useRef<{ key: string; method: PaymentIntent['method']; amount: string } | null>(null);

  const paidElectronic = intents.filter((i) => i.status === 'SUCCEEDED').reduce((a, i) => add(a, i.amount), '0.00');
  const remaining = gte(paidElectronic, due) ? '0.00' : sub(due, paidElectronic);
  // What the cash must cover: the rest of the sale.
  const cashDue = remaining;
  const cashAmount = parseAmount(cash);
  const covered = isZero(cashDue) || (cashAmount !== null && gte(cashAmount, cashDue));
  const pendingIntent = intents.some((i) => i.status === 'UNKNOWN' || i.status === 'PROCESSING');
  // Why the submit button is disabled, in words (only for things the cashier can act on).
  const blocker: MessageKey | null = pendingIntent ? 'pay.needCheck' : !covered ? 'pay.needCash' : null;

  /** The server's record of this payment's card/QR intents (finds one whose answer was lost). */
  async function syncIntents() {
    const { data } = await api<{ data: PaymentIntent[] }>('GET', `/v1/payment-intents?cashierSessionId=${shift.sessionId}`);
    setIntents(data.filter((i) => i.clientTransactionId === txId).reverse());
  }

  async function takeElectronic(method: PaymentIntent['method']) {
    if (!isPositive(remaining) || busy.current) return;
    busy.current = true;
    try {
      const pending = unansweredIntent.current;
      if (pending && (pending.method !== method || pending.amount !== remaining)) {
        // A different payment after a lost answer: first learn whether the earlier one went through.
        await syncIntents();
        unansweredIntent.current = null;
        setNotice({ kind: 'info', text: t('pay.synced') });
        return;
      }
      const key = pending?.key ?? uuid();
      unansweredIntent.current = { key, method, amount: remaining };
      const intent = await api<PaymentIntent>('POST', '/v1/payment-intents', { cashierSessionId: shift.sessionId, clientTransactionId: txId, method, amount: remaining }, { 'idempotency-key': key });
      unansweredIntent.current = null;
      setIntents((xs) => [...xs.filter((i) => i.id !== intent.id), intent]);
      setNotice(null);
      // An unanswered payment is explained next to it, in the payment panel.
      if (intent.status === 'FAILED') setNotice({ kind: 'warn', text: t('pay.declined') });
    } catch (err) {
      if (unanswered(err)) setNotice({ kind: 'warn', text: t('pay.intentUnconfirmed') });
      else {
        unansweredIntent.current = null;
        setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
      }
    } finally {
      busy.current = false;
    }
  }

  async function settleIntent(id: string, action: 'reconcile' | 'cancel') {
    try {
      const updated = await api<PaymentIntent>('POST', `/v1/payment-intents/${id}/${action}`);
      setIntents((xs) => xs.map((i) => (i.id === id ? updated : i)));
      setNotice(updated.status === 'FAILED' ? { kind: 'warn', text: t('pay.declined') } : null);
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
  }

  /**
   * Record the sale with this payment's tenders. Resolves to the recorded sale id, or null when it was
   * not recorded (the notice says why). An unanswered request keeps its key; a duplicate transaction
   * resolves to the sale already recorded; TOTAL_CHANGED calls `onTotalChanged` to re-price.
   */
  async function submit(
    send: (body: { clientTransactionId: string; tenders: Tender[] }, key: string) => Promise<{ id: string }>,
    onTotalChanged?: () => void,
    onUnanswered?: () => void,
    /** The server refused it (a final answer): the caller may word the refusal itself. */
    onRefused?: (err: unknown) => void,
  ): Promise<string | null> {
    if (busy.current) return null;
    busy.current = true;
    setSubmitting(true);
    const tenders: Tender[] = [
      ...intents.filter((i) => i.status === 'SUCCEEDED').map((i) => ({ method: 'INTENT' as const, paymentIntentId: i.id })),
      ...(isPositive(cashDue) && cashAmount ? [{ method: 'CASH' as const, tendered: cashAmount }] : []),
    ];
    try {
      const sale = await send({ clientTransactionId: txId, tenders }, saleKey);
      setNotice(null);
      return sale.id;
    } catch (err) {
      const recorded = err instanceof ApiFailure && err.error.code === 'DUPLICATE_TRANSACTION' ? err.error.details?.saleId : undefined;
      if (unanswered(err)) {
        // Unknown outcome: keep the same key (and transaction id) so retrying cannot create a second sale.
        setNotice({ kind: 'warn', text: t('pay.unconfirmed') });
        onUnanswered?.();
      } else if (typeof recorded === 'string') {
        // Already recorded (an earlier answer was lost): that sale is the result.
        setNotice(null);
        return recorded;
      } else {
        setSaleKey(uuid());
        if (err instanceof ApiFailure && err.error.code === 'TOTAL_CHANGED') {
          setNotice({ kind: 'warn', text: t('pay.totalChanged', { amount: String(err.error.details?.amountDue ?? '') }) });
          onTotalChanged?.();
        } else setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
        onRefused?.(err);
      }
      return null;
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }

  function reset() {
    setIntents([]);
    setCash('');
    setTxId(uuid());
    setSaleKey(uuid());
    unansweredIntent.current = null;
  }

  return {
    txId, intents, cash, setCash, remaining, cashDue, cashAmount, covered, pendingIntent, blocker, submitting, takeElectronic, settleIntent, submit, reset,
  };
}

export type Payment = ReturnType<typeof usePayment>;

/**
 * Card/QR payments taken so far, cash with quick tenders and change, and the submit button.
 * `cashOnly`: the desktop till is offline, so card and QR are not offered (ADR-0015 §1).
 */
export function PaymentPanel({ pay, priced, submitLabel, onSubmit, canSubmit, cashOnly = false }: { pay: Payment; priced: boolean; submitLabel: string; onSubmit: () => void; canSubmit: boolean; cashOnly?: boolean }) {
  const { t } = useT();
  const { intents, remaining, cashAmount, cashDue } = pay;
  return (
    <Note className="grid scroll-mt-4 gap-3 p-5" id="payment">
      {intents.map((i) => {
        const charged = i.status !== 'FAILED' && i.status !== 'CANCELED';
        const waiting = i.status === 'UNKNOWN' || i.status === 'PROCESSING';
        return (
          <div key={i.id} className="grid gap-2 text-[0.9375rem]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={charged ? '' : 'text-muted'}>
                {t(waiting ? 'pay.notConfirmed' : charged ? 'pay.paidElectronic' : 'pay.notCharged', { method: t(methodLabel(i.method)) })} <PaymentTag status={i.status} />
              </span>
              <Money value={i.amount} className={charged ? '' : 'text-muted line-through'} />
            </div>
            {waiting && (
              <>
                <Callout kind="warn">{t('pay.unknown')}</Callout>
                <button className="btn w-full" onClick={() => pay.settleIntent(i.id, 'reconcile')}>{t('pay.check')}</button>
              </>
            )}
            {i.status === 'SUCCEEDED' && <button className="btn btn-sm btn-danger justify-self-end" onClick={() => pay.settleIntent(i.id, 'cancel')}>{t('pay.cancelPayment')}</button>}
          </div>
        );
      })}
      {intents.length > 0 && (
        <p className="flex justify-between font-semibold">
          <span>{t('pay.remaining')}</span>
          <Money value={remaining} />
        </p>
      )}
      {isPositive(cashDue) && (
        <>
          <div className="field">
            <label htmlFor="cash">{t('pay.tendered')}</label>
            <input id="cash" className="input input-money" inputMode="decimal" value={pay.cash} onChange={(e) => pay.setCash(e.target.value)} placeholder="0.00" />
          </div>
          <div className="flex flex-wrap gap-2">
            {quickTenders(cashDue).map((v) => (
              <button key={v} type="button" className="btn btn-sm money" onClick={() => pay.setCash(v)}>
                <Money value={v} />
              </button>
            ))}
          </div>
          {cashAmount && (
            // After the total, the change is the number the cashier acts on: figure size.
            <p className="flex items-baseline justify-between gap-3" aria-live="polite">
              {gte(cashAmount, cashDue) ? (
                <>
                  <span className="text-[1.0625rem]">{t('pay.change')}</span>
                  <Money value={sub(cashAmount, cashDue)} className="text-[1.875rem] font-semibold leading-tight" />
                </>
              ) : (
                <>
                  <span className="text-[1.0625rem] text-red">{t('pay.shortLabel')}</span>
                  <Money value={sub(cashDue, cashAmount)} className="text-[1.875rem] font-semibold leading-tight text-red" />
                </>
              )}
            </p>
          )}
          {cashOnly ? (
            <p className="text-[0.875rem] text-muted">{t('till.offlineCard')}</p>
          ) : !isPositive(remaining) ? null : (
          <div className="grid grid-cols-2 gap-2">
            {/* No second charge while an earlier one has no answer: check it first. */}
            <button type="button" className="btn" disabled={!priced || pay.pendingIntent} onClick={() => pay.takeElectronic('CARD')}>
              <CreditCard className="size-4" aria-hidden /> {t('pay.card')}
            </button>
            <button type="button" className="btn" disabled={!priced || pay.pendingIntent} onClick={() => pay.takeElectronic('QR')}>
              <QrCode className="size-4" aria-hidden /> {t('pay.qr')}
            </button>
          </div>
          )}
        </>
      )}
      {priced && pay.blocker && <p className="text-[0.875rem] text-muted">{t(cashOnly && pay.blocker === 'pay.needCash' ? 'till.needCash' : pay.blocker)}</p>}
      <button id="pay-submit" className="btn btn-primary min-h-14 w-full text-[1.0625rem]" disabled={!canSubmit || !priced || pay.blocker !== null || pay.submitting} onClick={onSubmit}>
        {submitLabel}
      </button>
    </Note>
  );
}
