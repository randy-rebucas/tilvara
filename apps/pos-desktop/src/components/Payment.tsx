import { BedDouble, CreditCard, QrCode } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useT, type MessageKey } from '../i18n';
import { api, ApiFailure, uuid, withReference } from '../lib/api';
import { dateLabel } from '../lib/calendar';
import { add, gte, isPositive, isZero, parseAmount, peso, quickTenders, splitEqually, sub, sumAmounts } from '../lib/money';
import type { InHouseGuest, PaymentIntent } from '../types';
import type { Shift } from './Registers';
import { Callout, methodLabel, Money, Note, PaymentTag } from './ui';

export type Notice = { kind: 'error' | 'warn' | 'info'; text: string } | null;
/** ROOM_CHARGE (ADR-0023 §5.1): what is left after card/QR goes on an in-house guest's folio (no amount = the rest). */
export type Tender = { method: 'INTENT'; paymentIntentId: string } | { method: 'CASH'; tendered: string } | { method: 'ROOM_CHARGE'; stayId: string };
/** A tip (session 25): cash on top of what is due, or its own card payment. Never part of the sale's total. */
export type TipBody = { amount: string; paymentIntentId?: string; shares?: { staffId: string; amount: string }[] };
/** Someone a tip can be shared with (ADR-0022 §7): a staff member named on the cart's lines. */
export type TipStaff = { id: string; name: string };

/** No answer, or the server/database failed: the request may or may not have taken effect. */
export const unanswered = (err: unknown) => err instanceof ApiFailure && (err.error.status === 0 || err.error.status >= 500);

export const errorText = (err: unknown, fallback: string, network: string) =>
  err instanceof ApiFailure ? (unanswered(err) ? withReference(network, err) : err.error.message) : fallback;

/** The server's refusals of a charge to a room (ADR-0023 §5.1), in the cashier's words. */
const ROOM_CHARGE_ERRORS: Record<string, MessageKey> = {
  ROOM_CHARGE_LIMIT: 'room.err.limit',
  GUEST_NOT_IN_HOUSE: 'room.err.notInHouse',
  ROOM_CHARGES_NOT_ALLOWED: 'room.err.notAllowed',
  ROOM_CHARGE_WRONG_ENTITY: 'room.err.wrongEntity',
  ROOM_CHARGE_OFFLINE: 'room.err.offline',
  FOLIO_SETTLED: 'room.err.notInHouse',
};

/** Whether a guest's room may take this amount (charges allowed, and no limit or enough left under it). */
export const roomTakes = (g: InHouseGuest, amount: string) => g.allowCharges && (g.available === null || gte(g.available, amount));

/**
 * Taking payment for one sale or check (ADR-0009/0010): card/QR intents first, cash for the rest.
 * One payment = one terminal transaction id; its sale key is kept when an answer is lost, so a retry
 * can never record twice. Shared by the counter and table checks, which both end in `record()`.
 * `allowTip` (session 25): the cashier may add a tip, in cash (added to the cash due, outside the
 * sale) or by its own card payment of the same checkout.
 */
export function usePayment({ shift, due, setNotice, allowTip = false, tipStaff = [], allowRoomCharge = false }: {
  shift: Shift;
  due: string;
  setNotice: (n: Notice | ((n: Notice) => Notice)) => void;
  allowTip?: boolean;
  tipStaff?: TipStaff[];
  /** Charge to room (ADR-0023 §5.1): a lodging business, online, not an exchange. */
  allowRoomCharge?: boolean;
}) {
  const { t } = useT();
  const [txId, setTxId] = useState(uuid);
  const [saleKey, setSaleKey] = useState(uuid);
  const [intents, setIntents] = useState<PaymentIntent[]>([]);
  const [cash, setCash] = useState('');
  const [tipText, setTip] = useState('');
  const [tipMethod, setTipMethod] = useState<'CASH' | 'CARD'>('CASH');
  const [tipIntent, setTipIntent] = useState<PaymentIntent | null>(null);
  // A tip split by hand between the staff on the cart (ADR-0022 §7); left alone, the server splits it equally.
  const [splitting, setSplitting] = useState(false);
  const [shareText, setShareText] = useState<Record<string, string>>({});
  // The in-house guest whose room takes what is left (the cashier checked the name with the guest).
  const [roomGuest, setRoomGuest] = useState<InHouseGuest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous guards: a double click lands before React re-renders the disabled button.
  const busy = useRef(false);
  // Card/QR request whose answer never arrived: retried with the same key, so it cannot charge twice.
  const unansweredIntent = useRef<{ key: string; method: PaymentIntent['method']; amount: string } | null>(null);
  const unansweredTip = useRef<{ key: string; amount: string } | null>(null);

  const tip = allowTip ? parseAmount(tipText) : null;
  const tipValid = tipText.trim() === '' || (tip !== null && isPositive(tip));
  const cashTip = tip && isPositive(tip) && tipMethod === 'CASH' ? tip : '0.00';
  const paidElectronic = intents.filter((i) => i.status === 'SUCCEEDED').reduce((a, i) => add(a, i.amount), '0.00');
  const remaining = gte(paidElectronic, due) ? '0.00' : sub(due, paidElectronic);
  // Offline (or an exchange) the room charge drops out by itself: the server would refuse it.
  const room = allowRoomCharge ? roomGuest : null;
  const roomAmount = room && isPositive(remaining) ? remaining : '0.00';
  const roomOverLimit = room !== null && isPositive(roomAmount) && !roomTakes(room, roomAmount);
  // What the cash must cover: the rest of the sale (unless it goes on the room), plus a cash tip.
  const cashDue = add(room ? '0.00' : remaining, cashTip);
  const cashAmount = parseAmount(cash);
  const covered = isZero(cashDue) || (cashAmount !== null && gte(cashAmount, cashDue));
  const pendingIntent = intents.some((i) => i.status === 'UNKNOWN' || i.status === 'PROCESSING') || tipIntent?.status === 'UNKNOWN' || tipIntent?.status === 'PROCESSING';
  const cardTipNeeded = Boolean(tip && isPositive(tip) && tipMethod === 'CARD' && !(tipIntent?.status === 'SUCCEEDED' && tipIntent.amount === tip));
  const canSplit = allowTip && tipStaff.length >= 2;
  const split = canSplit && splitting && tip !== null && isPositive(tip);
  const shareAmounts = tipStaff.map((s) => ({ staffId: s.id, amount: (shareText[s.id] ?? '').trim() === '' ? '0.00' : parseAmount(shareText[s.id]!) }));
  const sharesValid = !split || (shareAmounts.every((x) => x.amount !== null) && sumAmounts(shareAmounts.map((x) => x.amount!)) === tip);
  // Why the submit button is disabled, in words (only for things the cashier can act on).
  const blocker: MessageKey | null = pendingIntent ? 'pay.needCheck' : roomOverLimit ? 'room.overLimit' : !tipValid ? 'tip.invalid' : !sharesValid ? 'tip.sharesMismatch' : cardTipNeeded ? 'tip.needCard' : !covered ? 'pay.needCash' : null;

  /** Turn the split on (equal shares to start from) or off (the server splits equally). */
  function setSplit(on: boolean) {
    setSplitting(on);
    if (on && tip && isPositive(tip)) {
      const parts = splitEqually(tip, tipStaff.length);
      setShareText(Object.fromEntries(tipStaff.map((s, i) => [s.id, parts[i]!])));
    }
  }

  /** The server's record of this payment's card/QR intents (finds one whose answer was lost). */
  async function syncIntents() {
    const { data } = await api<{ data: PaymentIntent[] }>('GET', `/v1/payment-intents?cashierSessionId=${shift.sessionId}`);
    const mine = data.filter((i) => i.clientTransactionId === txId);
    setIntents(mine.filter((i) => i.purpose !== 'TIP').reverse());
    // A tip charge whose answer was lost comes back here too, as the tip's (never as a tender).
    const tipCharge = mine.find((i) => i.purpose === 'TIP' && i.status !== 'FAILED' && i.status !== 'CANCELED');
    if (tipCharge) setTipIntent(tipCharge);
  }

  /** Charge the tip by card, as its own payment of this checkout (retried with the same key after a lost answer). */
  async function takeTipByCard() {
    if (!tip || !isPositive(tip) || busy.current) return;
    busy.current = true;
    try {
      const key = unansweredTip.current?.amount === tip ? unansweredTip.current.key : uuid();
      unansweredTip.current = { key, amount: tip };
      const intent = await api<PaymentIntent>('POST', '/v1/payment-intents', { cashierSessionId: shift.sessionId, clientTransactionId: txId, method: 'CARD', amount: tip, purpose: 'TIP' }, { 'idempotency-key': key });
      unansweredTip.current = null;
      setTipIntent(intent);
      setNotice(intent.status === 'FAILED' ? { kind: 'warn', text: t('pay.declined') } : null);
    } catch (err) {
      if (unanswered(err)) setNotice({ kind: 'warn', text: t('pay.intentUnconfirmed') });
      else {
        unansweredTip.current = null;
        setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
      }
    } finally {
      busy.current = false;
    }
  }

  async function cancelTipIntent() {
    if (!tipIntent) return;
    try {
      const updated = await api<PaymentIntent>('POST', `/v1/payment-intents/${tipIntent.id}/cancel`);
      setTipIntent(updated.status === 'CANCELED' ? null : updated);
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
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
      if (id === tipIntent?.id) setTipIntent(updated);
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
    send: (body: { clientTransactionId: string; tenders: Tender[]; tip?: TipBody }, key: string) => Promise<{ id: string }>,
    onTotalChanged?: () => void,
    onUnanswered?: () => void,
    /** The server refused it (a final answer): the caller may word the refusal itself (ADR-0025). */
    onRefused?: (err: unknown) => void,
  ): Promise<string | null> {
    if (busy.current) return null;
    busy.current = true;
    setSubmitting(true);
    const tenders: Tender[] = [
      ...intents.filter((i) => i.status === 'SUCCEEDED').map((i) => ({ method: 'INTENT' as const, paymentIntentId: i.id })),
      ...(room && isPositive(roomAmount) ? [{ method: 'ROOM_CHARGE' as const, stayId: room.stayId }] : []),
      ...(isPositive(cashDue) && cashAmount ? [{ method: 'CASH' as const, tendered: cashAmount }] : []),
    ];
    // Shares of nothing are left out (each share is positive); they still add up to the tip.
    const shares = split ? shareAmounts.filter((x) => x.amount && isPositive(x.amount)).map((x) => ({ staffId: x.staffId, amount: x.amount! })) : [];
    const tipBody: TipBody | undefined = tip && isPositive(tip)
      ? { amount: tip, ...(tipMethod === 'CARD' && tipIntent && { paymentIntentId: tipIntent.id }), ...(shares.length > 0 && { shares }) }
      : undefined;
    try {
      const sale = await send({ clientTransactionId: txId, tenders, ...(tipBody && { tip: tipBody }) }, saleKey);
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
        const roomError = err instanceof ApiFailure ? ROOM_CHARGE_ERRORS[err.error.code] : undefined;
        if (err instanceof ApiFailure && err.error.code === 'TOTAL_CHANGED') {
          setNotice({ kind: 'warn', text: t('pay.totalChanged', { amount: String(err.error.details?.amountDue ?? '') }) });
          onTotalChanged?.();
        } else if (roomError) {
          // The guest's room cannot take it: the cashier picks another way to pay.
          setNotice({ kind: 'error', text: t(roomError, { available: peso(String((err as ApiFailure).error.details?.available ?? '0')) }) });
          setRoomGuest(null);
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
    setTip('');
    setTipMethod('CASH');
    setTipIntent(null);
    setSplitting(false);
    setShareText({});
    setRoomGuest(null);
    unansweredTip.current = null;
    setTxId(uuid());
    setSaleKey(uuid());
    unansweredIntent.current = null;
  }

  return {
    txId, intents, cash, setCash, remaining, cashDue, cashAmount, covered, pendingIntent, blocker, submitting, takeElectronic, settleIntent, submit, reset,
    allowTip, tipText, setTip, tipMethod, setTipMethod, tip, cashTip, tipIntent, takeTipByCard, cancelTipIntent,
    tipStaff, canSplit, splitting: split, setSplit, shareText, setShare: (staffId: string, v: string) => setShareText((x) => ({ ...x, [staffId]: v })),
    allowRoomCharge, room, roomAmount, setRoomGuest, branchId: shift.branch.id,
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
      {pay.allowRoomCharge && !cashOnly && (pay.room || isPositive(remaining)) && <RoomChargeField pay={pay} />}
      {isPositive(cashDue) && (
        <>
          {isPositive(pay.cashTip) && (
            <p className="flex justify-between text-[0.9375rem]" data-testid="cash-due">
              <span className="text-muted">{t('tip.cashDue')}</span>
              <Money value={cashDue} />
            </p>
          )}
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
      {pay.allowTip && <TipField pay={pay} priced={priced} cashOnly={cashOnly} />}
      {priced && pay.blocker && <p className="text-[0.875rem] text-muted">{t(cashOnly && pay.blocker === 'pay.needCash' ? 'till.needCash' : pay.blocker)}</p>}
      <button id="pay-submit" className="btn btn-primary min-h-14 w-full text-[1.0625rem]" disabled={!canSubmit || !priced || pay.blocker !== null || pay.submitting} onClick={onSubmit}>
        {submitLabel}
      </button>
    </Note>
  );
}

/**
 * The tip (session 25): an amount, and whether it comes in cash (added to the cash due) or by card
 * (its own charge, taken here before the sale). Tips are the staff's: never in the sale's total.
 */
function TipField({ pay, priced, cashOnly }: { pay: Payment; priced: boolean; cashOnly: boolean }) {
  const { t } = useT();
  const charged = pay.tipIntent && pay.tipIntent.status !== 'FAILED' && pay.tipIntent.status !== 'CANCELED';
  return (
    <div className="grid gap-2 border-t border-hair-soft pt-3" data-testid="tip">
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <div className="field">
          <label htmlFor="tip">{t('tip.label')}</label>
          <input id="tip" className="input input-money" inputMode="decimal" value={pay.tipText} disabled={Boolean(charged)} onChange={(e) => pay.setTip(e.target.value)} placeholder="0.00" />
        </div>
        <div className="flex gap-1" role="group" aria-label={t('tip.method')}>
          {/* Offline (the desktop till): cash tips only, like every offline payment. */}
          {(cashOnly ? (['CASH'] as const) : (['CASH', 'CARD'] as const)).map((m) => (
            <button key={m} type="button" className="btn btn-sm" aria-pressed={pay.tipMethod === m} disabled={Boolean(charged)} onClick={() => pay.setTipMethod(m)}>
              {m === 'CASH' ? t('tip.cash') : t('tip.card')}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[0.8125rem] text-muted">{t('tip.hint')}</p>
      {/* Offline the till sends the tip alone: the server splits it equally among the staff on the lines. */}
      {pay.canSplit && !cashOnly && pay.tip && isPositive(pay.tip) && <TipSplit pay={pay} />}
      {pay.tipMethod === 'CARD' && pay.tip && isPositive(pay.tip) && (
        charged ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-[0.9375rem]">
            <span>{t('tip.paidCard')} <PaymentTag status={pay.tipIntent!.status} /></span>
            <span className="flex items-center gap-2">
              <Money value={pay.tipIntent!.amount} />
              {pay.tipIntent!.status === 'SUCCEEDED' && <button type="button" className="btn btn-sm btn-danger" onClick={() => void pay.cancelTipIntent()}>{t('pay.cancelPayment')}</button>}
              {(pay.tipIntent!.status === 'UNKNOWN' || pay.tipIntent!.status === 'PROCESSING') && <button type="button" className="btn btn-sm" onClick={() => void pay.settleIntent(pay.tipIntent!.id, 'reconcile')}>{t('pay.check')}</button>}
            </span>
          </div>
        ) : (
          <button type="button" className="btn" disabled={!priced || pay.pendingIntent} onClick={() => void pay.takeTipByCard()}>
            <CreditCard className="size-4" aria-hidden /> {t('tip.chargeCard', { amount: pay.tip })}
          </button>
        )
      )}
    </div>
  );
}

/**
 * Who gets the tip (ADR-0022 §7), when two or more staff are named on the cart: left alone the server
 * shares it equally; "Split" lets the cashier give each their part (starting from equal shares).
 */
function TipSplit({ pay }: { pay: Payment }) {
  const { t } = useT();
  const total = sumAmounts(pay.tipStaff.map((s) => parseAmount(pay.shareText[s.id] ?? '') ?? '0.00'));
  return (
    <div className="grid gap-2" data-testid="tip-split">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[0.875rem]">{pay.splitting ? t('tip.splitBy') : t('tip.splitEqual', { n: String(pay.tipStaff.length) })}</span>
        <button type="button" className="btn btn-sm" aria-pressed={pay.splitting} onClick={() => pay.setSplit(!pay.splitting)}>
          {pay.splitting ? t('tip.splitEqualButton') : t('tip.split')}
        </button>
      </div>
      {pay.splitting && (
        <>
          <ul className="grid gap-2">
            {pay.tipStaff.map((s) => (
              <li key={s.id} className="grid grid-cols-[1fr_120px] items-center gap-2">
                <label htmlFor={`share-${s.id}`} className="truncate text-[0.9375rem]">{s.name}</label>
                <input id={`share-${s.id}`} className="input input-money h-9" inputMode="decimal" value={pay.shareText[s.id] ?? ''} placeholder="0.00" onChange={(e) => pay.setShare(s.id, e.target.value)} />
              </li>
            ))}
          </ul>
          <p className="flex justify-between text-[0.8125rem] text-muted">
            <span>{t('tip.sharesTotal')}</span>
            <span><Money value={total} /> / <Money value={pay.tip} /></span>
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Charge to room (ADR-0023 §5.1): find the in-house guest by room number or name, read the name back
 * to the guest, and put what is left of the sale on their folio. Shows what the stay may still charge.
 * Not offered offline: the till cannot check the stay.
 */
function RoomChargeField({ pay }: { pay: Payment }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<InHouseGuest[] | null>(null);
  const [picked, setPicked] = useState<InHouseGuest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const branchId = pay.branchId;

  async function find(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ data: InHouseGuest[] }>('GET', `/v1/stays/in-house?branchId=${branchId}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`);
      setHits(r.data);
      setError(null);
    } catch (err) {
      setError(errorText(err, t('common.error'), t('common.network')));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setOpen(false);
    setPicked(null);
    setHits(null);
    setQ('');
    setError(null);
  }

  if (pay.room) {
    const g = pay.room;
    return (
      <div className="grid gap-2 rounded-[5px] border border-hair bg-white p-3" data-testid="room-charge">
        <p className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-semibold">{t('room.chargedTo', { room: g.roomNumber, name: g.guestName ?? '' })}</span>
          <Money value={pay.roomAmount} />
        </p>
        <p className="text-[0.8125rem] text-muted">
          {g.available === null ? t('room.noLimit') : t('room.available', { amount: peso(g.available) })} · {t('room.signHint')}
        </p>
        <button type="button" className="btn btn-sm justify-self-start" onClick={() => { pay.setRoomGuest(null); close(); }}>{t('room.remove')}</button>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn" data-testid="room-charge-open" onClick={() => { setOpen(true); void find(); }}>
        <BedDouble className="size-4" aria-hidden /> {t('room.charge')}
      </button>
    );
  }

  return (
    <div className="grid gap-3 rounded-[5px] border border-hair bg-white p-3" data-testid="room-charge-find">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-semibold">{t('room.charge')}</p>
        <button type="button" className="btn btn-sm" onClick={close}>{t('common.cancel')}</button>
      </div>
      {picked ? (
        <div className="grid gap-2" data-testid="room-charge-confirm">
          <p>{t('room.askName')}</p>
          <p className="text-[1.125rem] font-semibold">{picked.guestName} · {t('room.roomN', { room: picked.roomNumber })}</p>
          <p className="text-[0.8125rem] text-muted">
            {picked.available === null ? t('room.noLimit') : t('room.available', { amount: peso(picked.available) })}
            {picked.branchId !== branchId && <> · {picked.branchName}</>}
          </p>
          {!roomTakes(picked, pay.remaining) && (
            <Callout kind="warn">{picked.allowCharges ? t('room.err.limit', { available: peso(picked.available) }) : t('room.err.notAllowed')}</Callout>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={!roomTakes(picked, pay.remaining)} onClick={() => { pay.setRoomGuest(picked); close(); }}>{t('room.confirm')}</button>
            <button type="button" className="btn" onClick={() => setPicked(null)}>{t('common.back')}</button>
          </div>
        </div>
      ) : (
        <>
          <form className="grid grid-cols-[1fr_auto] items-end gap-2" onSubmit={(e) => void find(e)}>
            <div className="field">
              <label htmlFor="roomSearch">{t('room.search')}</label>
              <input id="roomSearch" className="input" value={q} maxLength={60} autoComplete="off" onChange={(e) => setQ(e.target.value)} />
            </div>
            <button className="btn" disabled={busy}>{t('room.find')}</button>
          </form>
          {error && <Callout kind="error">{error}</Callout>}
          {hits && hits.length === 0 && <p className="text-[0.875rem] text-muted">{t('room.noneInHouse')}</p>}
          {hits && hits.length > 0 && (
            <ul className="grid gap-1" data-testid="room-hits">
              {hits.map((g) => (
                <li key={g.stayId}>
                  <button type="button" className="btn h-auto min-h-11 w-full justify-between gap-3 py-2 text-left" data-room={g.roomNumber} disabled={!g.allowCharges} onClick={() => setPicked(g)}>
                    <span className="min-w-0">
                      <span className="block font-semibold">{t('room.roomN', { room: g.roomNumber })} · {g.guestName}</span>
                      <span className="block text-[0.8125rem] text-muted">{t('room.departs', { date: dateLabel(g.departureDate) })}{g.branchId !== branchId ? ` · ${g.branchName}` : ''}</span>
                    </span>
                    <span className="shrink-0 text-[0.8125rem] text-muted">
                      {!g.allowCharges ? t('room.noCharges') : g.available === null ? t('room.noLimitShort') : <>{t('room.left')} <Money value={g.available} /></>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
