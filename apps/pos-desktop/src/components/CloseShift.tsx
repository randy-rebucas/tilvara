import { toDec } from '@1pos/money';
import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure } from '../lib/api';
import { parseAmount } from '../lib/money';
import type { PaymentIntent } from '../types';
import { errorText } from './Payment';
import type { Shift } from './Registers';
import { Callout, Field, methodLabel, Money, Note, PaymentTag } from './ui';

interface SessionView {
  status: string;
  expectedCash: string;
  reconciliation: { expectedCash: string; countedCash: string; variance: string } | null;
}

type Outstanding = Pick<PaymentIntent, 'id' | 'method' | 'amount' | 'status'>;

/** Count the drawer and close. The expected amount comes from the drawer ledger on the server. */
export function CloseShift({ shift, onClosed }: { shift: Shift; onClosed: () => void }) {
  const { t } = useT();
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  // Card/QR charges that belong to no sale: the server refuses to close until each is settled.
  const [outstanding, setOutstanding] = useState<Outstanding[]>([]);

  useEffect(() => {
    api<SessionView>('GET', `/v1/cashier-sessions/${shift.sessionId}`).then(setView).catch(() => setError(t('common.error')));
  }, [shift.sessionId]);

  const failure = (err: unknown) => errorText(err, t('common.error'), t('common.network'));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const counted = parseAmount(String(new FormData(e.currentTarget).get('counted') ?? ''));
    if (!counted) return setFieldError(t('register.floatInvalid'));
    setFieldError(undefined);
    try {
      setView(await api<SessionView>('POST', `/v1/cashier-sessions/${shift.sessionId}/close`, { countedCash: counted }));
      setError(null);
    } catch (err) {
      if (err instanceof ApiFailure && err.error.code === 'PAYMENTS_OUTSTANDING') {
        const payments = (err.error.details?.payments ?? []) as Outstanding[];
        setOutstanding(payments);
        return setError(t('close.paymentsOutstanding', { count: String(payments.length) }));
      }
      setError(failure(err));
    }
  }

  async function settle(id: string, action: 'reconcile' | 'cancel') {
    try {
      const updated = await api<PaymentIntent>('POST', `/v1/payment-intents/${id}/${action}`);
      setOutstanding((xs) => xs.map((x) => (x.id === id ? { ...x, status: updated.status } : x)));
    } catch (err) {
      setError(failure(err));
    }
  }

  const closed = view && view.status !== 'OPEN';
  const unsettled = outstanding.filter((p) => p.status !== 'FAILED' && p.status !== 'CANCELED');
  const rec = view?.reconciliation;
  const variance = rec ? toDec(rec.variance) : null;
  return (
    <div className="mx-auto max-w-[560px] px-4 py-8 sm:px-6">
      <h1 className="text-[1.75rem] font-bold">{t('close.title')}</h1>
      <Note denom="orange" className="mt-5 grid gap-4 p-6">
        <p className="flex items-baseline justify-between">
          <span className="text-muted">{t('close.expected')}</span>
          <Money value={rec?.expectedCash ?? view?.expectedCash} className="text-[1.75rem] font-semibold" />
        </p>
        {rec && variance && (
          <>
            <p className="flex items-baseline justify-between">
              <span className="text-muted">{t('close.counted')}</span>
              <Money value={rec.countedCash} className="text-[1.75rem] font-semibold" />
            </p>
            <p className="flex items-baseline justify-between border-t border-hair-soft pt-3">
              <span className={variance.isZero() ? 'text-muted' : 'font-semibold text-red'}>
                {variance.isZero() ? t('close.varianceLabel') : t(variance.isNegative() ? 'close.short' : 'close.over')}
              </span>
              <Money value={variance.abs().toFixed(2)} className={`text-[1.75rem] font-semibold ${variance.isZero() ? '' : 'text-red'}`} />
            </p>
          </>
        )}
        {error && <Callout kind={outstanding.length ? 'warn' : 'error'}>{error}</Callout>}
        {!closed && unsettled.length > 0 && (
          <ul className="grid gap-2" aria-label={t('close.unsettledPayments')}>
            {unsettled.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[5px] border border-hair bg-white px-3 py-2">
                <span>
                  {t(methodLabel(p.method))} · <Money value={p.amount} /> <PaymentTag status={p.status} />
                </span>
                {p.status === 'SUCCEEDED' ? (
                  <button className="btn btn-danger" onClick={() => settle(p.id, 'cancel')}>{t('pay.cancelPayment')}</button>
                ) : (
                  <button className="btn" onClick={() => settle(p.id, 'reconcile')}>{t('pay.check')}</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!closed && (
          <form className="grid gap-3" onSubmit={submit}>
            <Field id="counted" name="counted" inputMode="decimal" autoFocus className="input-money" label={t('close.counted')} error={fieldError} placeholder="0.00" />
            <button className="btn btn-primary" disabled={unsettled.length > 0}>{t('close.submit')}</button>
          </form>
        )}
        {closed && view.status === 'RECONCILED' && <Callout kind="info">{t('close.balanced')}</Callout>}
        {closed && view.status === 'CLOSED' && <Callout kind="warn">{t('close.approval')}</Callout>}
        {closed && <button className="btn" onClick={onClosed}>{t('common.back')}</button>}
      </Note>
    </div>
  );
}
