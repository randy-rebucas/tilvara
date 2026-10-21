import { toDec } from '@1pos/money';
import { ArrowLeft, Minus, Plus, Printer, UserRound } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useT, type MessageKey } from '../i18n';
import { api } from '../lib/api';
import { partOfRest } from '../lib/fraction';
import { gte, isPositive, peso, sub } from '../lib/money';
import { BILL_NOTICE, billToPrintable } from '../lib/printing';
import { useTill } from '../lib/till';
import type { Bill, BillLine, CheckPreview, CounterCustomer, Order, Receipt as ReceiptData } from '../types';
import { CustomerPanel } from './CounterTools';
import { errorText, PaymentPanel, usePayment, type Notice } from './Payment';
import { Receipt } from './Receipt';
import type { Shift } from './Registers';
import type { FloorPlace } from './Tables';
import { Callout, Field, Money, Note } from './ui';

type Split = { kind: 'rest' } | { kind: 'even'; ways: number } | { kind: 'items'; picked: Record<string, string> };
type Allocation = { billLineId: string; quantity?: string; share?: { num: number; den: number } };

/** Units of a line still to pay (decimal string), when they are whole units (else null: the line is paid as "the rest"). */
const wholeLeft = (l: BillLine) => {
  const left = toDec(l.quantity).minus(l.paidQuantity);
  return left.isInteger() && left.gt(0) ? left.toString() : null;
};

/** Which shares of which lines this check pays; undefined = everything still unpaid. */
function allocationsFor(bill: Bill, split: Split): Allocation[] | undefined | 'TOO_FINE' | 'NOTHING' {
  const open = bill.lines.filter((l) => !l.parentLineId && !l.fullyPaid);
  if (split.kind === 'rest' || (split.kind === 'even' && split.ways <= 1)) return undefined;
  if (split.kind === 'even') {
    const out: Allocation[] = [];
    for (const l of open) {
      const share = partOfRest(l.paidShare, split.ways);
      if (!share) return 'TOO_FINE';
      out.push({ billLineId: l.id, share });
    }
    return out;
  }
  const out = Object.entries(split.picked).map(([billLineId, qty]) => {
    const line = open.find((l) => l.id === billLineId);
    const left = line ? wholeLeft(line) : null;
    return left !== null && toDec(qty).lt(left) ? { billLineId, quantity: qty } : { billLineId };
  });
  return out.length ? out : 'NOTHING';
}

/**
 * The bill as printed in a browser (off screen; @media print shows only `.printable`). A thermal
 * printer gets the same content from `billToPrintable`.
 */
const BillSlip = forwardRef<HTMLDivElement, { bill: Bill; branch: string; where: string; dateTime: string }>(function BillSlip({ bill, branch, where, dateTime }, ref) {
  const children = (id: string) => bill.lines.filter((l) => l.parentLineId === id);
  return (
    <div ref={ref} className="printable note pointer-events-none fixed -left-[9999px] top-0 w-[80mm] p-4 font-[family-name:var(--font-serial)] text-[0.8125rem]" aria-hidden>
      <p className="text-center font-semibold">{branch}</p>
      <p className="mt-1 text-center font-semibold">{BILL_NOTICE}</p>
      <p className="mt-2 flex justify-between border-y border-dashed border-hair py-1"><span>Bill {bill.billNumber} · {where}</span><span>{dateTime}</span></p>
      <ul className="mt-2 grid gap-0.5">
        {bill.lines.filter((l) => !l.parentLineId).map((l) => (
          <li key={l.id}>
            <p className="flex justify-between gap-2"><span>{l.quantity} x {l.name}{l.seat ? ` (seat ${l.seat})` : ''}</span><span>{l.amountDue}</span></p>
            {children(l.id).map((c) => <p key={c.id} className="flex justify-between gap-2 pl-3"><span>+ {c.name}</span><span>{c.amountDue}</span></p>)}
          </li>
        ))}
        {bill.charges.map((c) => <li key={c.id} className="flex justify-between gap-2"><span>Service charge {toDec(c.rate).times(100).toString()}%</span><span>{c.amountDue}</span></li>)}
      </ul>
      <dl className="mt-2 grid gap-0.5 border-t border-dashed border-hair pt-2">
        <div className="flex justify-between font-semibold"><dt>TOTAL DUE</dt><dd><Money value={bill.amountDue} /></dd></div>
        <div className="flex justify-between"><dt>VAT</dt><dd><Money value={bill.vatAmount} /></dd></div>
        {bill.checks.some((c) => !c.voided) && (
          <>
            <div className="flex justify-between"><dt>Paid</dt><dd><Money value={bill.amountPaid} /></dd></div>
            <div className="flex justify-between"><dt>Left to pay</dt><dd><Money value={bill.amountRemaining} /></dd></div>
          </>
        )}
      </dl>
      <p className="mt-3 text-center">Please check your bill before paying.</p>
    </div>
  );
});

/**
 * A frozen bill (ADR-0014 §8) paid in one or more checks: the rest, an even split, or by item. The
 * server prices each check (preview) and records it as a sale; the till never prorates money itself.
 */
export function BillScreen({ place, billId, onBack, onDone, lodging = false, permissions = [] }: { place: FloorPlace; billId: string; onBack: () => void; onDone: () => void; lodging?: boolean; permissions?: string[] }) {
  // Without a drawer (server mode) the bill is shown and printed, but money is taken at a till.
  const shift = place.shift ?? ({ sessionId: '', branch: place.branch } as Shift);
  const { t } = useT();
  const [bill, setBill] = useState<Bill | null>(null);
  const [split, setSplit] = useState<Split>({ kind: 'rest' });
  const [preview, setPreview] = useState<CheckPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [reopening, setReopening] = useState(false);
  const [where, setWhere] = useState('');
  const [printError, setPrintError] = useState<string | null>(null);
  const slip = useRef<HTMLDivElement>(null);
  const till = useTill();
  // The customer the check is for (ADR-0018): purchase history, and their store credit pays first, up to what is due.
  const [customer, setCustomer] = useState<CounterCustomer | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [usingCredit, setUsingCredit] = useState(false);
  const creditHere = customer?.storeCredit.find((c) => c.legalEntityId === shift.branch.legalEntityId)?.balance ?? '0.00';
  const due = preview?.amountDue ?? '0.00';
  const credit = usingCredit && isPositive(creditHere) ? (gte(creditHere, due) ? due : toDec(creditHere).toFixed(2)) : '0.00';
  // A resort's restaurant charges checks to a guest's room too (ADR-0023 §5.1).
  const pay = usePayment({ shift, due: sub(due, credit), setNotice, allowTip: true, allowRoomCharge: lodging });

  const load = useCallback(async () => {
    try {
      setBill(await api<Bill>('GET', `/v1/restaurant/bills/${billId}`));
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
  }, [billId]);
  useEffect(() => {
    void load();
  }, [load]);
  // Where the bill goes (table or takeaway name), for the printed bill.
  const orderId = bill?.orderId;
  useEffect(() => {
    if (!orderId) return;
    api<Order>('GET', `/v1/restaurant/orders/${orderId}`)
      .then((o) => setWhere(o.table?.code ?? o.customerName ?? t('floor.takeaway')))
      .catch(() => setWhere(''));
  }, [orderId]);

  const dateTime = () => new Intl.DateTimeFormat('en-PH', { timeZone: shift.branch.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  /** Print (or print again) the bill for the guests; a printer failure never touches the bill. */
  async function printBill() {
    if (!bill || !slip.current) return;
    setPrintError(null);
    try {
      await till.printer.print(slip.current, billToPrintable(bill, { branch: shift.branch.name, where, dateTime: dateTime() }));
    } catch (e) {
      setPrintError((e as Error).message);
    }
  }

  const allocations = bill ? allocationsFor(bill, split) : 'NOTHING';
  const allocKey = JSON.stringify(allocations);

  // The server's price for this check, whenever the split or what is already paid changes.
  useEffect(() => {
    if (!bill || bill.status !== 'ACTIVE' || allocations === 'TOO_FINE' || allocations === 'NOTHING') {
      setPreview(null);
      return;
    }
    let live = true;
    setPreviewing(true);
    api<CheckPreview>('POST', `/v1/restaurant/bills/${billId}/checks/preview`, allocations ? { allocations } : {})
      .then((p) => live && setPreview(p))
      .catch((err) => {
        if (!live) return;
        setPreview(null);
        setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
      })
      .finally(() => live && setPreviewing(false));
    return () => {
      live = false;
    };
  }, [allocKey, bill?.amountPaid, bill?.status, billId]);

  async function takePayment() {
    if (!preview || allocations === 'TOO_FINE' || allocations === 'NOTHING') return;
    const expected = preview.amountDue;
    const saleId = await pay.submit(
      (body, key) =>
        api<{ id: string }>(
          'POST',
          `/v1/restaurant/bills/${billId}/checks`,
          {
            cashierSessionId: shift.sessionId, ...body, ...(allocations && { allocations }), expectedAmountDue: expected,
            ...(customer && { customerId: customer.id }),
            ...(isPositive(credit) && { tenders: [{ method: 'STORE_CREDIT' as const, amount: credit }, ...body.tenders] }),
          },
          { 'idempotency-key': key },
        ),
      () => void load(),
    );
    if (!saleId) return;
    try {
      setReceipt(await api<ReceiptData>('GET', `/v1/sales/${saleId}/receipt`));
    } catch (err) {
      setNotice({ kind: 'warn', text: errorText(err, t('common.error'), t('pay.unconfirmed')) });
    }
    await load();
  }

  function nextCheck() {
    pay.reset();
    // The next diner pays for themselves: no customer carried over.
    setCustomer(null);
    setUsingCredit(false);
    setPickingCustomer(false);
    setReceipt(null);
    setNotice(null);
    setSplit((s) => (s.kind === 'even' ? { kind: 'even', ways: Math.max(1, s.ways - 1) } : s.kind === 'items' ? { kind: 'items', picked: {} } : s));
  }

  async function reopen(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    if (!reason) return;
    try {
      await api('POST', `/v1/restaurant/bills/${billId}/void`, { reason });
      onBack();
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
  }

  if (receipt) {
    const settled = bill?.status === 'SETTLED';
    return (
      <div className="mx-auto grid max-w-[1100px] gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[1fr_360px]">
        <Receipt data={receipt} />
        <div className="no-print grid content-start gap-3">
          {settled ? (
            <>
              <Callout kind="info">{t('bill.settled')}</Callout>
              <button className="btn btn-primary w-full" autoFocus onClick={onDone}>{t('bill.backToFloor')}</button>
            </>
          ) : (
            <>
              {bill && <p className="flex justify-between"><span className="text-muted">{t('bill.left')}</span><Money value={bill.amountRemaining} className="font-semibold" /></p>}
              <button className="btn btn-primary w-full" autoFocus onClick={nextCheck}>{t('bill.nextCheck')}</button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!bill) {
    return <div className="px-6 py-8">{notice ? <Callout kind={notice.kind}>{notice.text}</Callout> : <p className="text-muted">{t('floor.loading')}</p>}</div>;
  }

  const open = bill.lines.filter((l) => !l.parentLineId && !l.fullyPaid);
  // A voided check paid nothing (its share is owed again); the others are what was paid.
  const paidChecks = bill.checks.filter((c) => !c.voided);
  const voidedChecks = bill.checks.filter((c) => c.voided);
  const childrenOf = (id: string) => bill.lines.filter((l) => l.parentLineId === id);
  const locked = pay.intents.length > 0; // a card/QR payment was taken for this amount: keep the split
  const picked = split.kind === 'items' ? split.picked : {};
  // Seats with something still to pay: one tap picks that seat's lines (each person pays their own).
  const seats = [...new Set(open.map((l) => l.seat).filter((s): s is number => typeof s === 'number'))].sort((a, b) => a - b);

  return (
    <div className="mx-auto grid max-w-[1440px] gap-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-sm" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden /> {t('bill.backToOrder')}
        </button>
        <h1 className="text-[1.25rem] font-semibold">{t('bill.title', { n: String(bill.billNumber) })}{where && <span className="serial ml-2 text-muted">{where}</span>}</h1>
        <span className={`tag ${bill.status === 'ACTIVE' ? 'tag-warn' : ''}`}>{t(`bill.status.${bill.status}` as MessageKey)}</span>
        {bill.status === 'ACTIVE' && (
          <button type="button" className="btn btn-sm ml-auto" onClick={() => void printBill()}>
            <Printer className="size-4" aria-hidden /> {printError ? t('bill.printAgain') : t('bill.printCopy')}
          </button>
        )}
      </div>
      {printError && <Callout kind="error">{t('bill.printFailed')} ({printError})</Callout>}
      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}
      <BillSlip ref={slip} bill={bill} branch={shift.branch.name} where={where} dateTime={dateTime()} />
      {bill.requiresProfessionalReview && <Callout kind="warn">{t('sell.pendingReview')}</Callout>}

      <div className="grid gap-5 lg:grid-cols-[1fr_400px]">
        <div className="grid content-start gap-4">
          <Note className="p-2">
            <ul aria-label={t('bill.lines')}>
              {bill.lines.filter((l) => !l.parentLineId).map((l) => (
                <li key={l.id} className="row-rule px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={`font-semibold ${l.fullyPaid ? 'text-muted' : ''}`}><span className="money">{l.quantity}×</span> {l.name}</p>
                      {childrenOf(l.id).map((c) => (
                        <p key={c.id} className="flex justify-between gap-3 text-[0.875rem] text-muted"><span>+ {c.name}</span><Money value={c.amountDue} /></p>
                      ))}
                      {isPositive(l.statutoryDiscount) && <p className="text-[0.8125rem] text-muted">{t('totals.statutory')} −<Money value={l.statutoryDiscount} /></p>}
                      {isPositive(l.discount) && <p className="text-[0.8125rem] text-muted">{t('bill.lineDiscount')} −<Money value={l.discount} /></p>}
                      {l.paidShare !== '0/1' && <span className={`tag mt-1 ${l.fullyPaid ? '' : 'tag-warn'}`}>{l.fullyPaid ? t('bill.paid') : t('bill.paidPart', { qty: toDec(l.paidQuantity).toString() })}</span>}
                    </div>
                    <Money value={l.amountDue} className={`text-[1.0625rem] font-semibold ${l.fullyPaid ? 'text-muted' : ''}`} />
                  </div>
                </li>
              ))}
              {bill.charges.map((c) => (
                <li key={c.id} className="row-rule flex justify-between gap-3 px-3 py-3">
                  <span>{t('bill.serviceCharge', { rate: toDec(c.rate).times(100).toString() })}</span>
                  <Money value={c.amountDue} className="font-semibold" />
                </li>
              ))}
            </ul>
          </Note>
          <Note className="grid gap-1 p-5">
            <p className="flex items-baseline justify-between"><span className="text-muted">{t('bill.total')}</span><Money value={bill.amountDue} className="text-[1.5rem] font-semibold" /></p>
            <p className="flex justify-between text-[0.9375rem]"><span className="text-muted">{t('totals.vat')}</span><Money value={bill.vatAmount} /></p>
            {paidChecks.length > 0 && (
              <>
                <p className="flex justify-between text-[0.9375rem]"><span className="text-muted">{t('bill.paidSoFar', { n: String(paidChecks.length) })}</span><Money value={bill.amountPaid} /></p>
                <p className="flex justify-between font-semibold"><span>{t('bill.left')}</span><Money value={bill.amountRemaining} /></p>
              </>
            )}
          </Note>
          {bill.status === 'ACTIVE' && voidedChecks.length > 0 && (
            <Callout kind="info">{t('bill.voidedChecks', { n: voidedChecks.map((c) => `#${c.saleNumber}`).join(', ') })}</Callout>
          )}
          {bill.status === 'ACTIVE' && paidChecks.length === 0 && (
            reopening ? (
              <Note className="p-4">
                <form className="grid gap-3" onSubmit={reopen}>
                  <p className="font-semibold">{t('bill.reopenTitle')}</p>
                  <Field id="reopenReason" name="reason" required maxLength={200} label={t('history.reason')} autoFocus />
                  <div className="flex gap-2">
                    <button className="btn btn-danger">{t('bill.reopen')}</button>
                    <button type="button" className="btn" onClick={() => setReopening(false)}>{t('common.cancel')}</button>
                  </div>
                </form>
              </Note>
            ) : (
              <button type="button" className="btn btn-sm justify-self-start" onClick={() => setReopening(true)}>{t('bill.reopen')}</button>
            )
          )}
        </div>

        {bill.status === 'ACTIVE' && !place.shift ? (
          <aside className="grid content-start gap-4" aria-label={t('bill.payTitle')}>
            <Callout kind="info">{t('floor.payAtTill')}</Callout>
          </aside>
        ) : bill.status === 'ACTIVE' ? (
          <aside className="grid content-start gap-4" aria-label={t('bill.payTitle')}>
            {customer ? (
              <div className="flex flex-wrap items-center gap-2 rounded-[5px] border border-hair bg-white px-3 py-2" data-testid="check-customer">
                <UserRound className="size-4 text-muted" aria-hidden />
                <span className="font-semibold">{customer.displayName}</span>
                {customer.phone && <span className="serial text-[0.8125rem] text-muted">{customer.phone}</span>}
                {isPositive(creditHere) && <span className="chip bg-green">{t('custc.credit', { amount: peso(creditHere) })}</span>}
                <span className="ml-auto flex gap-2">
                  {isPositive(creditHere) && (
                    <button type="button" className="btn btn-sm" disabled={locked} aria-pressed={usingCredit} onClick={() => setUsingCredit(!usingCredit)}>
                      {usingCredit ? t('custc.dropCredit') : t('custc.useCredit')}
                    </button>
                  )}
                  <button type="button" className="btn btn-sm" disabled={locked} onClick={() => { setCustomer(null); setUsingCredit(false); }}>{t('custc.remove')}</button>
                </span>
                {isPositive(credit) && <p className="flex w-full justify-between text-[0.875rem]"><span className="text-muted">{t('custc.creditApplied')}</span><Money value={credit} /></p>}
              </div>
            ) : pickingCustomer ? (
              <CustomerPanel canAdd={permissions.includes('customers.manage')} onPick={(c) => { setCustomer(c); setPickingCustomer(false); }} onCancel={() => setPickingCustomer(false)} />
            ) : (permissions.includes('customers.read') || permissions.includes('customers.manage')) && (
              <button type="button" className="btn btn-sm justify-self-start" onClick={() => setPickingCustomer(true)}>
                <UserRound className="size-4" aria-hidden /> {t('custc.button')}
              </button>
            )}
            <Note className="grid gap-3 p-5">
              <div className="flex flex-wrap gap-1" role="group" aria-label={t('bill.splitHow')}>
                <button type="button" className="btn btn-sm" disabled={locked} aria-pressed={split.kind === 'rest'} onClick={() => setSplit({ kind: 'rest' })}>{t('bill.payRest')}</button>
                <button type="button" className="btn btn-sm" disabled={locked} aria-pressed={split.kind === 'even'} onClick={() => setSplit({ kind: 'even', ways: 2 })}>{t('bill.splitEven')}</button>
                <button type="button" className="btn btn-sm" disabled={locked} aria-pressed={split.kind === 'items'} onClick={() => setSplit({ kind: 'items', picked: {} })}>{t('bill.byItem')}</button>
              </div>
              {split.kind === 'even' && (
                <div className="grid gap-2">
                  <span className="text-[0.8125rem] font-semibold">{t('bill.ways')}</span>
                  <div className="flex flex-wrap gap-1">
                    {[2, 3, 4, 5, 6].map((n) => (
                      <button key={n} type="button" className="btn btn-sm" disabled={locked} aria-pressed={split.ways === n} onClick={() => setSplit({ kind: 'even', ways: n })}>{n}</button>
                    ))}
                  </div>
                  <p className="text-[0.875rem] text-muted">{split.ways > 1 ? t('bill.evenHint', { n: String(split.ways) }) : t('bill.lastShare')}</p>
                </div>
              )}
              {split.kind === 'items' && seats.length > 0 && (
                <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('bill.bySeat')}>
                  <span className="text-[0.8125rem] font-semibold">{t('bill.bySeat')}</span>
                  {seats.map((n) => {
                    const mine = open.filter((l) => l.seat === n);
                    const on = mine.length > 0 && mine.every((l) => picked[l.id] !== undefined) && Object.keys(picked).length === mine.length;
                    return (
                      <button key={n} type="button" className="btn btn-sm" disabled={locked} aria-pressed={on}
                        onClick={() => setSplit({ kind: 'items', picked: Object.fromEntries(mine.map((l) => [l.id, wholeLeft(l) ?? '1'])) })}>
                        {t('kds.seat', { n: String(n) })}
                      </button>
                    );
                  })}
                </div>
              )}
              {split.kind === 'items' && (
                <ul className="grid gap-1" aria-label={t('bill.byItem')}>
                  {open.map((l) => {
                    const left = wholeLeft(l);
                    const qty = picked[l.id];
                    const on = qty !== undefined;
                    const setQty = (q: string | undefined) =>
                      setSplit((s) => {
                        if (s.kind !== 'items') return s;
                        const next = { ...s.picked };
                        if (q === undefined) delete next[l.id];
                        else next[l.id] = q;
                        return { kind: 'items', picked: next };
                      });
                    return (
                      <li key={l.id} className="flex min-h-12 flex-wrap items-center gap-2">
                        <label className="flex flex-1 items-center gap-3">
                          <input type="checkbox" className="size-5" disabled={locked} checked={on} onChange={(e) => setQty(e.target.checked ? (left ?? '1') : undefined)} />
                          <span>{l.name}</span>
                        </label>
                        {on && left !== null && toDec(left).gt(1) && (
                          <span className="flex items-center gap-1">
                            <button type="button" className="btn btn-sm" aria-label={`${t('sell.qty')} −`} disabled={locked || toDec(qty!).lte(1)} onClick={() => setQty(toDec(qty!).minus(1).toString())}><Minus className="size-4" aria-hidden /></button>
                            <span className="money w-12 text-center">{qty}/{left}</span>
                            <button type="button" className="btn btn-sm" aria-label={`${t('sell.qty')} +`} disabled={locked || toDec(qty!).gte(left)} onClick={() => setQty(toDec(qty!).plus(1).toString())}><Plus className="size-4" aria-hidden /></button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {allocations === 'TOO_FINE' && <Callout kind="warn">{t('bill.tooFine')}</Callout>}
              {allocations === 'NOTHING' && split.kind === 'items' && <p className="text-[0.875rem] text-muted">{t('bill.pickItems')}</p>}
              <p className="flex items-baseline justify-between gap-3 border-t border-hair-soft pt-3">
                <span className="text-muted">{t('bill.thisCheck')}</span>
                <Money value={preview?.amountDue ?? null} className="text-[2.25rem] font-semibold leading-tight" />
              </p>
              {previewing && <p className="text-[0.8125rem] text-muted">{t('totals.updating')}</p>}
              {preview && preview.charges.length > 0 && (
                <p className="flex justify-between text-[0.875rem] text-muted"><span>{t('bill.includesCharge')}</span><Money value={preview.charges.reduce((a, c) => toDec(a).plus(c.amountDue).toFixed(2), '0.00')} /></p>
              )}
            </Note>
            <PaymentPanel pay={pay} priced={!!preview && !previewing} submitLabel={t('bill.takePayment')} onSubmit={() => void takePayment()} canSubmit={!!preview} />
          </aside>
        ) : (
          <aside className="grid content-start gap-3">
            <Callout kind="info">{t('bill.settled')}</Callout>
            <button className="btn btn-primary" onClick={onDone}>{t('bill.backToFloor')}</button>
          </aside>
        )}
      </div>
    </div>
  );
}
