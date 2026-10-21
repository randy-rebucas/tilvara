import { toDec } from '@1pos/money';
import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure, uuid, withReference } from '../lib/api';
import { parseAmount } from '../lib/money';
import type { PaymentIntent } from '../types';
import { errorText } from './Payment';
import type { Shift } from './Registers';
import { Callout, Field, methodLabel, Money, Note, PaymentTag } from './ui';

interface SessionView {
  status: string;
  expectedCash: string;
  reconciliation: { expectedCash: string; countedCash: string; variance: string } | null;
  payInOut?: { id: string; type: 'PAY_IN' | 'PAY_OUT' | 'TIP_PAYOUT'; amount: string; reason: string | null }[];
}

/**
 * Cash put into or taken out of the drawer during the shift (change fund top-up, a supplier paid
 * from the till). Each is a document with its own journal entry; the expected cash moves with it.
 * One Idempotency-Key per entry: a lost answer resubmitted with it never records twice.
 */
function PayInOut({ sessionId, items, onRecorded }: { sessionId: string; items: NonNullable<SessionView['payInOut']>; onRecorded: () => void }) {
  const { t } = useT();
  const [key, setKey] = useState(uuid);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const amount = parseAmount(String(f.get('pioAmount') ?? ''));
    if (!amount || toDec(amount).isZero()) return setFieldError(t('register.floatInvalid'));
    setFieldError(undefined);
    try {
      await api('POST', `/v1/cashier-sessions/${sessionId}/movements`, { type: f.get('pioType'), amount, reason: String(f.get('pioReason') ?? '').trim() }, { 'idempotency-key': key });
      setKey(uuid());
      setError(null);
      form.reset();
      onRecorded();
    } catch (err) {
      if (err instanceof ApiFailure && (err.error.status === 0 || err.error.status >= 500)) return setError(withReference(t('payio.unconfirmed'), err));
      setKey(uuid());
      setError(errorText(err, t('common.error'), t('common.network')));
    }
  }
  return (
    <Note denom="orange" className="mt-5 grid gap-3 p-6">
      <h2 className="text-[1.125rem] font-semibold">{t('payio.title')}</h2>
      {items.length > 0 && (
        <ul className="grid gap-1 text-[0.9375rem]">
          {items.map((m) => (
            <li key={m.id} className="flex items-baseline justify-between gap-3">
              <span>{t(m.type === 'PAY_IN' ? 'payio.in' : m.type === 'TIP_PAYOUT' ? 'payio.tips' : 'payio.out')} · <span className="text-muted">{m.reason}</span></span>
              <Money value={m.amount} />
            </li>
          ))}
        </ul>
      )}
      <form className="grid gap-3 sm:grid-cols-[auto_1fr]" onSubmit={submit}>
        <div className="field">
          <label htmlFor="pioType">{t('payio.kind')}</label>
          <select id="pioType" name="pioType" className="input">
            <option value="PAY_IN">{t('payio.in')}</option>
            <option value="PAY_OUT">{t('payio.out')}</option>
            <option value="TIP_PAYOUT">{t('payio.tips')}</option>
          </select>
        </div>
        <Field id="pioAmount" name="pioAmount" inputMode="decimal" className="input-money" label={t('payio.amount')} error={fieldError} placeholder="0.00" />
        <div className="sm:col-span-2">
          <Field id="pioReason" name="pioReason" required label={t('history.reason')} />
        </div>
        <div className="sm:col-span-2">
          <button className="btn">{t('payio.record')}</button>
        </div>
      </form>
      {error && <Callout kind="error">{error}</Callout>}
    </Note>
  );
}

type Outstanding = Pick<PaymentIntent, 'id' | 'method' | 'amount' | 'status'>;
/** A live restaurant order that holds the close (OPEN_BILLS): the last shift at the branch, or part-paid here. */
interface OpenBill { orderId: string; orderNumber: number; orderType: string; tableCode: string | null; customerName: string | null; status: string; amountDue: string | null; paid: string; paidOnThisShift: boolean }

/**
 * Count the drawer and close. The expected amount comes from the drawer ledger on the server.
 * Tables still to be paid stop the close; a manager (`canOverride`) may close anyway with a reason.
 */
export function CloseShift({ shift, canOverride = false, onClosed }: { shift: Shift; canOverride?: boolean; onClosed: () => void }) {
  const { t } = useT();
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  // Card/QR charges that belong to no sale: the server refuses to close until each is settled.
  const [outstanding, setOutstanding] = useState<Outstanding[]>([]);
  const [openBills, setOpenBills] = useState<OpenBill[]>([]);
  // Carts parked at this register stay for the next shift; the cashier is told, not stopped.
  const [heldCount, setHeldCount] = useState(0);
  useEffect(() => {
    void api<{ data: unknown[] }>('GET', `/v1/held-carts?registerId=${shift.register.id}`).then((r) => setHeldCount(r.data.length)).catch(() => undefined);
  }, [shift.register.id]);

  const reload = () => api<SessionView>('GET', `/v1/cashier-sessions/${shift.sessionId}`).then(setView).catch(() => setError(t('common.error')));
  useEffect(() => {
    void reload();
  }, [shift.sessionId]);

  const failure = (err: unknown) => errorText(err, t('common.error'), t('common.network'));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const counted = parseAmount(String(form.get('counted') ?? ''));
    if (!counted) return setFieldError(t('register.floatInvalid'));
    setFieldError(undefined);
    const reason = String(form.get('openBillsReason') ?? '').trim();
    try {
      setView(await api<SessionView>('POST', `/v1/cashier-sessions/${shift.sessionId}/close`, { countedCash: counted, ...(reason && { openBillsReason: reason }) }));
      setError(null);
    } catch (err) {
      if (err instanceof ApiFailure && err.error.code === 'PAYMENTS_OUTSTANDING') {
        const payments = (err.error.details?.payments ?? []) as Outstanding[];
        setOutstanding(payments);
        return setError(t('close.paymentsOutstanding', { count: String(payments.length) }));
      }
      if (err instanceof ApiFailure && err.error.code === 'OPEN_BILLS') {
        const orders = (err.error.details?.orders ?? []) as OpenBill[];
        setOpenBills(orders);
        return setError(t(canOverride ? 'close.openBillsManager' : 'close.openBills', { count: String(orders.length) }));
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
        {!closed && heldCount > 0 && <Callout kind="info">{t('close.heldCarts', { n: String(heldCount) })}</Callout>}
        {error && <Callout kind={outstanding.length || openBills.length ? 'warn' : 'error'}>{error}</Callout>}
        {!closed && openBills.length > 0 && (
          <ul className="grid gap-2" aria-label={t('close.openBillsLabel')}>
            {openBills.map((o) => (
              <li key={o.orderId} className="flex flex-wrap items-center justify-between gap-2 rounded-[5px] border border-hair bg-white px-3 py-2">
                <span>
                  {o.tableCode ? t('close.orderTable', { code: o.tableCode }) : t('close.orderTakeaway', { n: String(o.orderNumber) })}
                  {o.customerName && <span className="text-muted"> · {o.customerName}</span>}
                </span>
                <span className="text-[0.875rem] text-muted">
                  {o.amountDue === null ? t('close.notBilled') : <>{t('close.paidSoFar')} <Money value={o.paid} /> / <Money value={o.amountDue} /></>}
                </span>
              </li>
            ))}
          </ul>
        )}
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
            {openBills.length > 0 && canOverride && <Field id="openBillsReason" name="openBillsReason" required label={t('close.anywayReason')} />}
            <button className="btn btn-primary" disabled={unsettled.length > 0}>
              {openBills.length > 0 && canOverride ? t('close.anyway') : t('close.submit')}
            </button>
          </form>
        )}
        {closed && view.status === 'RECONCILED' && <Callout kind="info">{t('close.balanced')}</Callout>}
        {closed && view.status === 'CLOSED' && <Callout kind="warn">{t('close.approval')}</Callout>}
        {closed && <button className="btn" onClick={onClosed}>{t('common.back')}</button>}
      </Note>
      {view && !closed && <PayInOut sessionId={shift.sessionId} items={view.payInOut ?? []} onRecorded={() => void reload()} />}
    </div>
  );
}
