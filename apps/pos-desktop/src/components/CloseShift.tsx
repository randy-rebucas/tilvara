import { toDec } from '@1pos/money';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure, uuid } from '../lib/api';
import { openDrawerFor } from '../lib/drawer';
import { parseAmount } from '../lib/money';
import { useTill } from '../lib/till';
import type { PaymentIntent } from '../types';
import { errorText, unanswered } from './Payment';
import type { Shift } from './Registers';
import { Callout, Field, methodLabel, Money, Note, PaymentTag } from './ui';

interface SessionView {
  status: string;
  expectedCash: string;
  reconciliation: { expectedCash: string; countedCash: string; variance: string } | null;
  /** SUPPLIER_PAYMENT: a supplier paid from this drawer in the back office (or that cash put back on a void). */
  payInOut?: { id: string; type: 'PAY_IN' | 'PAY_OUT' | 'SUPPLIER_PAYMENT'; amount: string; reason: string | null }[];
}

type PayInOutBody = { type: 'PAY_IN' | 'PAY_OUT'; amount: string; reason: string };

/**
 * Cash put into or taken out of the drawer during the shift (change fund top-up, a supplier paid
 * from the till). Each is a document with its own journal entry; the expected cash moves with it.
 * One Idempotency-Key per entry: a lost answer resubmitted with it never records twice.
 */
function PayInOut({ sessionId, items, onRecorded }: { sessionId: string; items: NonNullable<SessionView['payInOut']>; onRecorded: () => void }) {
  const { t } = useT();
  const till = useTill();
  const [key, setKey] = useState(uuid);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  /**
   * The last entry got no answer, so it may be recorded (audit 2026-10-27 #34). Until a final answer
   * comes, the form is locked as it was sent and only "Record again" is offered: the same body under the
   * same key, which never records twice.
   */
  const [unknown, setUnknown] = useState<PayInOutBody | null>(null);
  const busy = useRef(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current) return;
    const form = e.currentTarget;
    let body: PayInOutBody;
    if (unknown) body = unknown;
    else {
      const f = new FormData(form);
      const amount = parseAmount(String(f.get('pioAmount') ?? ''));
      if (!amount || toDec(amount).isZero()) return setFieldError(t('register.floatInvalid'));
      setFieldError(undefined);
      body = { type: f.get('pioType') === 'PAY_OUT' ? 'PAY_OUT' : 'PAY_IN', amount, reason: String(f.get('pioReason') ?? '').trim() };
    }
    busy.current = true;
    try {
      await api('POST', `/v1/cashier-sessions/${sessionId}/movements`, body, { 'idempotency-key': key });
      setKey(uuid());
      setUnknown(null);
      setError(null);
      form.reset();
      // Cash goes in or out: open the drawer (best effort, after it is recorded).
      openDrawerFor(till.drawer, true);
      onRecorded();
    } catch (err) {
      if (unanswered(err)) {
        // Same key, same body next time: never rotate the key while the outcome is unknown.
        setUnknown(body);
        return setError(errorText(err, t('common.error'), t('payio.unconfirmed')));
      }
      setKey(uuid());
      setUnknown(null);
      setError(errorText(err, t('common.error'), t('common.network')));
    } finally {
      busy.current = false;
    }
  }
  return (
    <Note denom="orange" className="mt-5 grid gap-3 p-6">
      <h2 className="text-[1.125rem] font-semibold">{t('payio.title')}</h2>
      {items.length > 0 && (
        <ul className="grid gap-1 text-[0.9375rem]">
          {items.map((m) => (
            <li key={m.id} className="flex items-baseline justify-between gap-3">
              <span>{t(m.type === 'PAY_IN' ? 'payio.in' : m.type === 'SUPPLIER_PAYMENT' ? 'payio.supplier' : 'payio.out')} · <span className="text-muted">{m.reason}</span></span>
              <Money value={m.amount} />
            </li>
          ))}
        </ul>
      )}
      <form className="grid gap-3 sm:grid-cols-[auto_1fr]" onSubmit={submit}>
        {/* Locked as sent while the outcome is unknown: the values stay on screen, the body sent is the one kept. */}
        <fieldset disabled={!!unknown} className="m-0 grid min-w-0 gap-3 border-0 p-0 sm:col-span-2 sm:grid-cols-[auto_1fr]">
          <div className="field">
            <label htmlFor="pioType">{t('payio.kind')}</label>
            <select id="pioType" name="pioType" className="input">
              <option value="PAY_IN">{t('payio.in')}</option>
              <option value="PAY_OUT">{t('payio.out')}</option>
            </select>
          </div>
          <Field id="pioAmount" name="pioAmount" inputMode="decimal" className="input-money" label={t('payio.amount')} error={fieldError} placeholder="0.00" />
          <div className="sm:col-span-2">
            <Field id="pioReason" name="pioReason" required label={t('history.reason')} />
          </div>
        </fieldset>
        <div className="sm:col-span-2">
          <button className="btn">{t(unknown ? 'payio.again' : 'payio.record')}</button>
        </div>
      </form>
      {error && <Callout kind="error">{error}</Callout>}
    </Note>
  );
}

type Outstanding = Pick<PaymentIntent, 'id' | 'method' | 'amount' | 'status'>;

/** Count the drawer and close. The expected amount comes from the drawer ledger on the server. */
export function CloseShift({ shift, onClosed }: { shift: Shift; onClosed: () => void }) {
  const { t } = useT();
  const till = useTill();
  const [view, setView] = useState<SessionView | null>(null);
  // One Idempotency-Key per count: a close whose answer was lost, sent again, replays that close.
  const [closeKey, setCloseKey] = useState(uuid);
  const [lastCount, setLastCount] = useState<string | null>(null);
  /**
   * Desktop till: sales of this shift still kept on the till. Delivered after the close they could not go
   * on the shift any more (SESSION_NOT_OPEN, quarantined) and the count would miss their cash, so the
   * close waits until they are sent.
   */
  const [waiting, setWaiting] = useState(0);
  const [sending, setSending] = useState(false);
  const engine = till.mode === 'ready' ? till.engine : null;
  useEffect(() => {
    if (!engine) return;
    let live = true;
    const check = () => engine.pendingFor(shift.sessionId).then((n) => live && setWaiting(n), () => undefined);
    void check();
    const timer = setInterval(() => void check(), 3_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [engine, shift.sessionId, till.status?.pending]);
  async function sendNow() {
    if (!engine) return;
    setSending(true);
    try {
      await engine.sendNow();
    } finally {
      setWaiting(await engine.pendingFor(shift.sessionId).catch(() => waiting));
      void till.refresh();
      setSending(false);
    }
  }
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  // Card/QR charges that belong to no sale: the server refuses to close until each is settled.
  const [outstanding, setOutstanding] = useState<Outstanding[]>([]);
  // Carts parked at this register stay for the next shift; the cashier is told, not stopped.
  const [heldCount, setHeldCount] = useState(0);
  useEffect(() => {
    void api<{ data: unknown[] }>('GET', `/v1/held-carts?registerId=${shift.register.id}`).then((r) => setHeldCount(r.data.length)).catch(() => undefined);
  }, [shift.register.id]);

  const reload = () => api<SessionView>('GET', `/v1/cashier-sessions/${shift.sessionId}`).then(setView).catch((err) => setError(errorText(err, t('common.error'), t('common.network'))));
  useEffect(() => {
    void reload();
  }, [shift.sessionId]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const counted = parseAmount(String(form.get('counted') ?? ''));
    if (!counted) return setFieldError(t('register.floatInvalid'));
    if (waiting > 0) return;
    setFieldError(undefined);
    // Another count is another close: it gets its own key (a lost answer is replayed only for the same count).
    const key = lastCount === null || lastCount === counted ? closeKey : uuid();
    if (key !== closeKey) setCloseKey(key);
    setLastCount(counted);
    try {
      setView(await api<SessionView>('POST', `/v1/cashier-sessions/${shift.sessionId}/close`, { countedCash: counted }, { 'idempotency-key': key }));
      setError(null);
    } catch (err) {
      if (!(err instanceof ApiFailure && (err.error.status === 0 || err.error.status >= 500))) {
        // A final answer: the next count is a new request.
        setCloseKey(uuid());
        setLastCount(null);
      }
      if (err instanceof ApiFailure && err.error.code === 'PAYMENTS_OUTSTANDING') {
        const payments = (err.error.details?.payments ?? []) as Outstanding[];
        setOutstanding(payments);
        return setError(t('close.paymentsOutstanding', { count: String(payments.length) }));
      }
      if (err instanceof ApiFailure && err.error.code === 'OFFLINE_SALES_UNRESOLVED') {
        const n = Array.isArray(err.error.details?.offlineSales) ? err.error.details.offlineSales.length : 0;
        return setError(t('close.offlineUnresolved', { n: String(n) }));
      }
      if (err instanceof ApiFailure && err.error.code === 'SESSION_NOT_OPEN') {
        // Closed already (e.g. by an earlier try whose answer was lost): show the shift as it stands.
        void reload();
        return setError(t('close.alreadyClosed'));
      }
      setError(errorText(err, t('common.error'), t('close.unconfirmed')));
    }
  }

  async function settle(id: string, action: 'reconcile' | 'cancel') {
    try {
      const updated = await api<PaymentIntent>('POST', `/v1/payment-intents/${id}/${action}`);
      setOutstanding((xs) => xs.map((x) => (x.id === id ? { ...x, status: updated.status } : x)));
    } catch (err) {
      setError(errorText(err, t('common.error'), t('common.unconfirmed')));
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
        {!closed && waiting > 0 && (
          <div className="grid gap-2" data-testid="close-offline-waiting">
            <Callout kind="warn">{t('close.offlineWaiting', { n: String(waiting) })}</Callout>
            <button type="button" className="btn justify-self-start" disabled={sending} onClick={() => void sendNow()}>{t('till.syncNow')}</button>
          </div>
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
            <button className="btn btn-primary" disabled={unsettled.length > 0 || waiting > 0}>
              {t('close.submit')}
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
