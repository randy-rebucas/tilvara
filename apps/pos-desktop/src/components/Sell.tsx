import { MonitorUp, Minus, PauseCircle, Plus, ScanLine, Trash2, UserRound } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure, uuid } from '../lib/api';
import { toDec } from '@1pos/money';
import { gte, isPositive, isZero, peso, sub } from '../lib/money';
import { pressIfEnabled, useShortcuts } from '../lib/shortcuts';
import { useTill } from '../lib/till';
import { openCustomerDisplay, usePublishDisplay, type DisplayState } from '../lib/customer-display';
import type { CounterCustomer, LookupItem, Quote, Receipt as ReceiptData } from '../types';
import { OfflineSaleError, type OfflineEngine, type OfflineReceipt as OfflineReceiptData } from '@1pos/pos-offline';
import { errorText, PaymentPanel, unanswered, usePayment, type Notice } from './Payment';
import type { Shift } from './Registers';
import { Receipt } from './Receipt';
import { OfflineReceipt } from './Till';
import { Callout, Field, Money, Note } from './ui';
import { CustomerPanel, DiscountPanel, ExchangeBanner, HeldCartsPanel, PricePanel, rateOf, type ExchangeStart, type HeldCart, type LineDiscount, type LineOverride } from './CounterTools';

interface CartLine {
  id: string;
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  wholeUnits: boolean;
  statutory?: { scheme: 'SC' | 'PWD'; beneficiary: string };
  /** Session 20: an ordinary discount (needs `sales.discount`) and a manager-approved price. */
  discount?: LineDiscount;
  override?: LineOverride;
}

/** What the API takes for a cart line (quote, sale, held cart); the quote sends only the SC/PWD scheme. */
function lineBody(l: CartLine, forQuote = false) {
  return {
    id: l.id,
    variantId: l.variantId,
    quantity: l.quantity,
    ...(l.statutory && { statutory: forQuote ? { scheme: l.statutory.scheme } : l.statutory }),
    ...(l.discount?.kind === 'RATE' && { discountRate: rateOf(l.discount.percent) }),
    ...(l.discount?.kind === 'AMOUNT' && { discount: l.discount.amount }),
    ...(l.override && { priceOverrideId: l.override.id }),
  };
}
interface Beneficiary {
  ref: string;
  scheme: 'SC' | 'PWD';
  name: string;
  idNumber: string;
}
interface ProductHit {
  id: string;
  name: string;
  variants: { id: string; sku: string; name: string | null }[];
}

/**
 * The counter: scan → cart priced by the server (/v1/tax/quote) → tender → POST /v1/sales.
 * Online, the client never computes prices or taxes; it only shows what the server returns.
 *
 * Desktop till, offline (ADR-0015 §1): cash only, no discounts, on the shift the till last saw open.
 * Items and prices come from the till's snapshot, priced by the same tax engine the server re-runs
 * at sync; the sale is kept on the till under this checkout's transaction id.
 */
export function Sell({ shift, cashierUserId, active = true, permissions = [], exchange = null, onExchangeEnd }: {
  shift: Shift;
  cashierUserId: string;
  active?: boolean;
  /** From /me (any scope): hints for which controls to offer; the server decides. */
  permissions?: string[];
  /** An exchange started from This shift: the refund pays for the cart first (session 20). */
  exchange?: ExchangeStart | null;
  onExchangeEnd?: () => void;
}) {
  const { t } = useT();
  const till = useTill();
  const snap = till.status?.snapshot;
  const canSellOffline = till.mode === 'ready' && till.status?.authState !== 'REVOKED' && snap?.registerId === shift.register.id && snap.openSessionId === shift.sessionId;
  const offline = canSellOffline && !till.online;
  const [offlineReceipt, setOfflineReceipt] = useState<OfflineReceiptData | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [hits, setHits] = useState<ProductHit[] | null>(null);
  /** The line whose SC/PWD, discount or price form is open. */
  const [panel, setPanel] = useState<{ lineId: string; kind: 'sc' | 'discount' | 'price' } | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [held, setHeld] = useState<HeldCart[]>([]);
  const [showHeld, setShowHeld] = useState(false);
  const [holding, setHolding] = useState(false);
  const canDiscount = permissions.includes('sales.discount');
  const canApprovePrice = permissions.includes('sales.price_override');
  // The customer on the sale (ADR-0018) and the store credit they hold with this branch's company.
  const [customer, setCustomer] = useState<CounterCustomer | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [usingCredit, setUsingCredit] = useState(false);
  const creditHere = customer?.storeCredit.find((c) => c.legalEntityId === shift.branch.legalEntityId)?.balance ?? '0.00';
  const due = quote?.totals.amountDue ?? '0.00';
  // Store credit pays first, up to what is due; an exchange's refund likewise (the rest is paid, or comes back as change).
  const credit = usingCredit && !exchange && isPositive(creditHere) ? (gte(creditHere, due) ? due : toDec(creditHere).toFixed(2)) : '0.00';
  const payable = exchange ? (gte(exchange.refund, due) ? '0.00' : sub(due, exchange.refund)) : sub(due, credit);
  const pay = usePayment({ shift, due: payable, setNotice });

  const loadHeld = () =>
    api<{ data: HeldCart[] }>('GET', `/v1/held-carts?registerId=${shift.register.id}`)
      .then((r) => setHeld(r.data))
      .catch(() => undefined);
  useEffect(() => {
    if (!offline) void loadHeld();
  }, [shift.register.id, offline]);

  const focusScan = () => requestAnimationFrame(() => scanRef.current?.focus());
  useEffect(() => {
    if (active) focusScan();
  }, [active]);

  // The till can only sell offline on a shift its snapshot knows: refresh it when this shift starts.
  useEffect(() => {
    if (till.mode === 'ready') void till.refreshSnapshot();
  }, [till.mode, shift.sessionId]);

  // Server-authoritative pricing and tax for the current cart.
  useEffect(() => {
    if (cart.length === 0) {
      setQuote(null);
      return;
    }
    let live = true;
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        if (offline) {
          if (cart.some((l) => l.statutory)) throw new OfflineRefusal(t('till.offlineSc'));
          if (cart.some((l) => l.discount || l.override)) throw new OfflineRefusal(t('till.offlineDiscount'));
          const r = await till.engine!.quote(cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })));
          if (live) {
            setQuote(offlineQuote(r, cart));
            setNotice((n) => (n?.kind === 'error' ? null : n));
          }
          return;
        }
        const q = await api<Quote>('POST', '/v1/tax/quote', {
          branchId: shift.branch.id,
          lines: cart.map((l) => lineBody(l, true)),
        });
        if (live) {
          setQuote(q);
          setNotice((n) => (n?.kind === 'error' ? null : n));
        }
      } catch (err) {
        if (unanswered(err)) till.reportUnreachable();
        if (live) setNotice({ kind: 'error', text: offlineText(err) ?? errorText(err, t('common.error'), t('common.network')) });
      } finally {
        if (live) setQuoting(false);
      }
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cart, shift.branch.id, offline]);

  /** Why the till refused offline, in the cashier's words (null when it was not an offline refusal). */
  function offlineText(err: unknown): string | null {
    if (err instanceof OfflineRefusal) return err.message;
    if (err instanceof OfflineSaleError) return t('till.offlineRefused', { reason: err.message });
    return null;
  }

  /** Offline: the till's snapshot by barcode or SKU, shaped like the server's lookup. */
  async function lookupOffline(code: string): Promise<LookupItem | null> {
    const item = await till.engine!.lookup(code);
    if (!item) return null;
    return {
      variantId: item.variantId, sku: item.sku, name: item.name, price: { amount: item.unitPrice },
      soldBy: item.wholeUnits ? 'UNIT' : 'WEIGHT', uom: { code: '', allowsFraction: !item.wholeUnits },
      ...(item.quantity && { quantity: item.quantity }),
    };
  }

  function addItem(item: LookupItem) {
    if (!item.price) {
      setNotice({ kind: 'warn', text: t('sell.unpriced', { name: item.name }) });
      return;
    }
    setNotice(null);
    // A scale label is one weighed pack: its own line, at the printed weight, never merged with another.
    if (item.quantity) {
      setCart((c) => [...c, { id: uuid(), variantId: item.variantId, sku: item.sku, name: item.name, quantity: item.quantity!, wholeUnits: false }]);
      return;
    }
    setCart((c) => {
      const existing = c.find((l) => l.variantId === item.variantId && !l.statutory && l.wholeUnits);
      if (existing) return c.map((l) => (l === existing ? { ...l, quantity: toDec(l.quantity).plus(1).toString() } : l));
      const wholeUnits = item.soldBy === 'UNIT' && !item.uom.allowsFraction;
      return [...c, { id: uuid(), variantId: item.variantId, sku: item.sku, name: item.name, quantity: '1', wholeUnits }];
    });
  }

  async function scan(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = scanRef.current?.value.trim() ?? '';
    if (!q) return;
    setHits(null);
    const fromSnapshot = async () => {
      const item = await lookupOffline(q);
      if (item) {
        addItem(item);
        scanRef.current!.value = '';
      } else setNotice({ kind: 'warn', text: t('till.notFoundOffline', { q }) });
    };
    try {
      if (offline) await fromSnapshot();
      else {
        try {
          addItem(await api<LookupItem>('GET', `/v1/catalog/lookup?code=${encodeURIComponent(q)}&branchId=${shift.branch.id}`));
          scanRef.current!.value = '';
        } catch (err) {
          // No answer: the till carries on from its own price list instead of failing this scan.
          if (!unanswered(err) || !canSellOffline) throw err;
          till.reportUnreachable();
          await fromSnapshot();
        }
      }
    } catch (err) {
      if (unanswered(err)) till.reportUnreachable();
      if (offlineText(err)) setNotice({ kind: 'error', text: offlineText(err)! });
      else if (err instanceof ApiFailure && err.error.status === 404) {
        // A failed search is an error to show, not "no such item".
        try {
          const found = await api<{ data: ProductHit[] }>('GET', `/v1/products?q=${encodeURIComponent(q)}&limit=8`);
          if (found.data.length) setHits(found.data);
          else setNotice({ kind: 'warn', text: t('sell.notFound', { q }) });
        } catch (searchErr) {
          setNotice({ kind: 'error', text: errorText(searchErr, t('common.error'), t('common.network')) });
        }
      } else setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
    focusScan();
  }

  async function pick(sku: string) {
    try {
      addItem(await api<LookupItem>('GET', `/v1/catalog/lookup?code=${encodeURIComponent(sku)}&branchId=${shift.branch.id}`));
      setHits(null);
      if (scanRef.current) scanRef.current.value = '';
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
    focusScan();
  }

  const setQty = (id: string, quantity: string) => setCart((c) => c.map((l) => (l.id === id ? { ...l, quantity } : l)));
  const remove = (id: string) => setCart((c) => c.filter((l) => l.id !== id));

  function applyStatutory(lineId: string, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const scheme = f.get('scheme') === 'PWD' ? 'PWD' : 'SC';
    const name = String(f.get('name') ?? '').trim();
    const idNumber = String(f.get('idNumber') ?? '').trim();
    if (!name || !idNumber) return;
    const existing = beneficiaries.find((b) => b.scheme === scheme && b.idNumber === idNumber);
    const ref = existing?.ref ?? `b${beneficiaries.length + 1}`;
    if (!existing) setBeneficiaries((b) => [...b, { ref, scheme, name, idNumber }]);
    patchLine(lineId, (l) => {
      // SC/PWD and an ordinary discount never stack on one line (the tax engine refuses it).
      const { discount: _, ...rest } = l;
      return { ...rest, statutory: { scheme, beneficiary: ref } };
    });
    setPanel(null);
    focusScan();
  }

  function clearStatutory(lineId: string) {
    patchLine(lineId, (l) => {
      const { statutory: _, ...rest } = l;
      return rest;
    });
  }

  function patchLine(lineId: string, patch: (l: CartLine) => CartLine) {
    setCart((c) => c.map((l) => (l.id === lineId ? patch(l) : l)));
  }
  function setDiscount(lineId: string, d: LineDiscount | null) {
    patchLine(lineId, (l) => {
      const { discount: _, ...rest } = l;
      return d ? { ...rest, discount: d } : rest;
    });
    setPanel(null);
    focusScan();
  }
  function setOverride(lineId: string, o: LineOverride | null) {
    patchLine(lineId, (l) => {
      const { override: _, ...rest } = l;
      return o ? { ...rest, override: o } : rest;
    });
    setPanel(null);
    focusScan();
  }

  /** Park this cart at the register (online only) and start a new one. */
  async function hold(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const label = String(new FormData(e.currentTarget).get('holdLabel') ?? '').trim();
    if (!label) return;
    try {
      await api('POST', '/v1/held-carts', {
        cashierSessionId: shift.sessionId,
        label,
        lines: cart.map((l) => ({ ...lineBody(l), name: l.name, sku: l.sku, wholeUnits: l.wholeUnits })),
        beneficiaries: beneficiaries.filter((b) => cart.some((l) => l.statutory?.beneficiary === b.ref)),
        ...(quote && { amountDue: quote.totals.amountDue }),
      }, { 'idempotency-key': uuid() });
      setHolding(false);
      newSale();
      setNotice({ kind: 'info', text: t('hold.done', { label }) });
      void loadHeld();
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
  }

  async function resume(id: string) {
    try {
      const r = await api<{ lines: HeldLine[]; beneficiaries: Beneficiary[] }>('POST', `/v1/held-carts/${id}/resume`, { cashierSessionId: shift.sessionId });
      setCart(r.lines.map((l) => ({
        id: l.id ?? uuid(), variantId: l.variantId, sku: l.sku, name: l.name, quantity: l.quantity, wholeUnits: l.wholeUnits ?? false,
        ...(l.statutory && { statutory: l.statutory }),
        ...(l.discountRate && { discount: { kind: 'RATE' as const, percent: toDec(l.discountRate).times(100).toString() } }),
        ...(l.discount && { discount: { kind: 'AMOUNT' as const, amount: l.discount } }),
        // The approval travels with the line; once it has expired the quote says so and it can be removed.
        ...(l.priceOverrideId && { override: { id: l.priceOverrideId, unitPrice: '', approvedByName: null } }),
      })));
      setBeneficiaries(r.beneficiaries);
      setShowHeld(false);
      setNotice(null);
      void loadHeld();
      focusScan();
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
      void loadHeld();
    }
  }

  async function discard(id: string) {
    try {
      await api('POST', `/v1/held-carts/${id}/discard`);
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
    void loadHeld();
  }

  async function completeOffline() {
    if (!pay.cashAmount || pay.intents.length > 0) return;
    try {
      const { receipt: kept } = await till.engine!.ringUp({
        cashierUserId, terminalTxnId: pay.txId, tendered: pay.cashAmount,
        lines: cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      });
      setNotice(null);
      setOfflineReceipt(kept);
      void till.refresh();
    } catch (err) {
      setNotice({ kind: 'error', text: offlineText(err) ?? errorText(err, t('common.error'), t('common.network')) });
    }
  }

  async function complete() {
    if (!quote) return;
    if (offline) return completeOffline();
    const lines = cart.map((l) => lineBody(l));
    const used = beneficiaries.filter((b) => cart.some((l) => l.statutory?.beneficiary === b.ref));
    const withCustomer = { ...(customer && { customerId: customer.id }) };
    const creditTender = isPositive(credit) ? [{ method: 'STORE_CREDIT' as const, amount: credit }] : [];
    const saleId = await pay.submit(
      (body, key) =>
        exchange
          ? api<{ sale: { id: string } }>(
              'POST',
              '/v1/exchanges',
              {
                cashierSessionId: shift.sessionId, saleId: exchange.saleId, reason: exchange.reason, returnLines: exchange.returnLines, expectedRefund: exchange.refund,
                sale: { clientTransactionId: body.clientTransactionId, lines, beneficiaries: used, tenders: body.tenders, expectedAmountDue: due, ...withCustomer },
              },
              { 'idempotency-key': key },
            ).then((r) => r.sale)
          : api<{ id: string }>(
              'POST',
              '/v1/sales',
              { cashierSessionId: shift.sessionId, ...body, tenders: [...creditTender, ...body.tenders], lines, beneficiaries: used, expectedAmountDue: due, ...withCustomer },
              { 'idempotency-key': key },
            ),
      () => setCart((c) => [...c]),
      () => till.reportUnreachable(),
    );
    if (!saleId) return;
    try {
      setReceipt(await api<ReceiptData>('GET', `/v1/sales/${saleId}/receipt`));
    } catch (e) {
      setNotice({ kind: 'warn', text: errorText(e, t('common.error'), t('pay.unconfirmed')) });
    }
  }

  // What the customer display shows: the priced lines and total, then the change once paid.
  const shown: DisplayState = receipt
    ? { kind: 'paid', total: receipt.totals.amountDue ?? due, change: receipt.tenders.find((x) => x.change)?.change ?? null }
    : offlineReceipt
      ? { kind: 'paid', total: due, change: null }
      : cart.length && quote
        ? { kind: 'cart', lines: quote.lines.map((l) => ({ name: l.name, quantity: l.quantity, amount: l.amountDue })), total: quote.totals.amountDue }
        : { kind: 'idle' };
  usePublishDisplay(shown);

  function newSale() {
    if (exchange) onExchangeEnd?.();
    setCustomer(null);
    setUsingCredit(false);
    setPickingCustomer(false);
    setCart([]);
    setBeneficiaries([]);
    setPanel(null);
    pay.reset();
    setReceipt(null);
    setOfflineReceipt(null);
    setNotice(null);
    focusScan();
  }

  const goToPayment = () => {
    document.getElementById('payment')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    requestAnimationFrame(() => (document.getElementById('cash') as HTMLInputElement | null)?.focus());
  };
  const showingReceipt = Boolean(receipt || offlineReceipt);
  // Phones: the pay bar steps aside once the payment panel itself is on screen (it would cover it).
  const [panelInView, setPanelInView] = useState(false);
  const hasCart = cart.length > 0;
  useEffect(() => {
    const el = document.getElementById('payment');
    if (!el || !hasCart || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setPanelInView(Boolean(e?.isIntersecting)), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, [hasCart, showingReceipt]);
  // F2 scan (or a new sale from the receipt) · F4 cash · F8 exact cash · F9 complete.
  useShortcuts(active, showingReceipt ? { F2: newSale } : {
    F2: focusScan,
    F4: goToPayment,
    F8: () => { if (quote && isPositive(pay.remaining)) { pay.setCash(pay.remaining); goToPayment(); } },
    F9: () => { pressIfEnabled('pay-submit'); },
  });

  if (receipt || offlineReceipt) {
    return (
      <div className="mx-auto grid max-w-[1100px] gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[1fr_360px]">
        {receipt ? <Receipt data={receipt} /> : <OfflineReceipt data={offlineReceipt!} />}
        <div className="no-print grid content-start gap-3">
          <button className="btn btn-primary w-full" autoFocus onClick={newSale}>
            {t('sell.newSale')} <kbd className="kbd">F2</kbd>
          </button>
        </div>
      </div>
    );
  }

  const quoteLine = (id: string) => quote?.lines.find((l) => l.id === id);
  const isOpen = (lineId: string, kind: 'sc' | 'discount' | 'price') => panel?.lineId === lineId && panel.kind === kind;
  const toggle = (lineId: string, kind: 'sc' | 'discount' | 'price') => setPanel(isOpen(lineId, kind) ? null : { lineId, kind });

  return (
    <div className={`mx-auto grid max-w-[1440px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[1fr_400px] ${cart.length > 0 ? 'pb-28 lg:pb-5' : ''}`}>
      <div className="grid content-start gap-4">
        <form onSubmit={scan} className="flex gap-2">
          <label htmlFor="scan" className="sr-only">{t('sell.scan')}</label>
          <div className="relative flex-1">
            <ScanLine className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
            <input id="scan" ref={scanRef} autoFocus autoComplete="off" className="input pl-10 text-[1.0625rem]" placeholder={t('sell.scan')} />
          </div>
          <button className="btn btn-primary">{t('sell.add')}</button>
          {till.mode === 'browser' && (
            <button type="button" className="btn" title={t('display.open')} onClick={openCustomerDisplay}>
              <MonitorUp className="size-5" aria-hidden />
              <span className="sr-only">{t('display.open')}</span>
            </button>
          )}
        </form>
        <p className="-mt-2 hidden flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted lg:flex" aria-label={t('keys.title')}>
          <span><kbd className="kbd">F2</kbd> {t('keys.scan')}</span>
          <span><kbd className="kbd">F4</kbd> {t('keys.cash')}</span>
          <span><kbd className="kbd">F8</kbd> {t('keys.exact')}</span>
          <span><kbd className="kbd">F9</kbd> {t('keys.complete')}</span>
        </p>

        {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}

        {exchange && <ExchangeBanner exchange={exchange} total={quote?.totals.amountDue} onCancel={newSale} />}

        {/* A customer on the sale needs the server: not offered offline. */}
        {!offline && (customer ? (
          <div className="no-print flex flex-wrap items-center gap-2 rounded-[5px] border border-hair bg-white px-3 py-2" data-testid="sale-customer">
            <UserRound className="size-4 text-muted" aria-hidden />
            <span className="font-semibold">{customer.displayName}</span>
            {customer.phone && <span className="serial text-[0.8125rem] text-muted">{customer.phone}</span>}
            {isPositive(creditHere) && <span className="chip bg-green">{t('custc.credit', { amount: peso(creditHere) })}</span>}
            <span className="ml-auto flex gap-2">
              {isPositive(creditHere) && !exchange && (
                <button type="button" className="btn btn-sm" aria-pressed={usingCredit} onClick={() => setUsingCredit(!usingCredit)}>
                  {usingCredit ? t('custc.dropCredit') : t('custc.useCredit')}
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => { setCustomer(null); setUsingCredit(false); }}>{t('custc.remove')}</button>
            </span>
          </div>
        ) : pickingCustomer ? (
          <CustomerPanel canAdd={permissions.includes('customers.manage')} onPick={(c) => { setCustomer(c); setPickingCustomer(false); focusScan(); }} onCancel={() => setPickingCustomer(false)} />
        ) : (permissions.includes('customers.read') || permissions.includes('customers.manage')) && (
          <button type="button" className="no-print btn btn-sm justify-self-start" onClick={() => setPickingCustomer(true)}>
            <UserRound className="size-4" aria-hidden /> {t('custc.button')}
          </button>
        ))}

        {!offline && !exchange && (cart.length > 0 || held.length > 0) && (
          <div className="no-print flex flex-wrap items-center gap-2">
            {cart.length > 0 && pay.intents.length === 0 && !holding && (
              <button type="button" className="btn btn-sm" onClick={() => setHolding(true)}>
                <PauseCircle className="size-4" aria-hidden /> {t('hold.button')}
              </button>
            )}
            {held.length > 0 && (
              <button type="button" className="btn btn-sm" aria-pressed={showHeld} onClick={() => setShowHeld(!showHeld)}>
                {t('hold.listButton', { n: String(held.length) })}
              </button>
            )}
          </div>
        )}
        {holding && (
          <form className="no-print grid gap-3 rounded-[5px] border border-hair bg-white p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end" onSubmit={hold}>
            <Field id="holdLabel" name="holdLabel" required maxLength={60} autoFocus label={t('hold.label')} hint={t('hold.labelHint')} />
            <button className="btn btn-primary sm:mb-[2px]">{t('hold.confirm')}</button>
            <button type="button" className="btn sm:mb-[2px]" onClick={() => setHolding(false)}>{t('common.cancel')}</button>
          </form>
        )}
        {showHeld && held.length > 0 && <HeldCartsPanel carts={held} cartEmpty={cart.length === 0} timezone={shift.branch.timezone} onResume={resume} onDiscard={discard} />}

        {hits && (
          <Note className="p-4">
            <h2 className="section-title mb-2">{t('sell.results')}</h2>
            <ul className="grid gap-1">
              {hits.flatMap((p) =>
                p.variants.map((v) => (
                  <li key={v.id}>
                    <button className="flex w-full items-center justify-between rounded px-2 py-2 text-left hover:bg-paper" onClick={() => pick(v.sku)}>
                      <span>{v.name ? `${p.name} — ${v.name}` : p.name}</span>
                      <span className="serial text-[0.8125rem] text-muted">{v.sku}</span>
                    </button>
                  </li>
                )),
              )}
            </ul>
          </Note>
        )}

        <Note denom="blue" className="min-h-[240px] p-2">
          {cart.length === 0 ? (
            <p className="grid min-h-[220px] place-items-center text-muted">{t('sell.emptyCart')}</p>
          ) : (
            <ul aria-label="Cart">
              {cart.map((l) => {
                const q = quoteLine(l.id);
                const b = l.statutory && beneficiaries.find((x) => x.ref === l.statutory!.beneficiary);
                return (
                  <li key={l.id} className="row-rule px-3 py-3">
                    {/* Line controls sit beside the name only on wide screens; below that they wrap on their own row. */}
                    <div className="grid grid-cols-[1fr_auto] items-start gap-3 xl:grid-cols-[1fr_auto_auto]">
                      <div className="min-w-0">
                        <p className="font-semibold">{l.name}</p>
                        <p className="serial text-[0.75rem] text-muted">
                          {l.sku}
                          {q && <> · <Money value={q.unitPrice} /></>}
                        </p>
                        {(l.discount || l.override) && q && (
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-[0.8125rem]">
                            {l.override && (
                              <span className="chip bg-orange-soft">
                                {t('price.chip')} <Money value={q.unitPrice} />
                                {q.listUnitPrice && <>{' · '}<span className="line-through"><Money value={q.listUnitPrice} /></span></>}
                                {l.override.approvedByName && <>{' · '}{t('price.by', { name: l.override.approvedByName })}</>}
                              </span>
                            )}
                            {l.discount && q.discount && isPositive(q.discount) && (
                              <span className="chip bg-blue">
                                {l.discount.kind === 'RATE' ? `−${l.discount.percent}%` : t('disc.chipAmount')} · −<Money value={q.discount} />
                              </span>
                            )}
                          </p>
                        )}
                        {b && (
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-[0.8125rem]">
                            <span className="chip bg-blue">{b.scheme}</span>
                            <span>{b.name}</span>
                            <span className="serial text-muted">{b.idNumber}</span>
                            <button className="btn btn-sm btn-danger" onClick={() => clearStatutory(l.id)}>{t('sell.removeDiscount')}</button>
                          </p>
                        )}
                      </div>
                      <div className="col-span-2 row-start-2 flex flex-wrap items-center gap-1 xl:col-span-1 xl:row-start-auto">
                        {l.wholeUnits ? (
                          <>
                            <button className="btn btn-sm" aria-label={`${t('sell.qty')} −`} disabled={l.quantity === '1'} onClick={() => setQty(l.id, toDec(l.quantity).minus(1).toString())}>
                              <Minus className="size-4" aria-hidden />
                            </button>
                            <span className="money w-10 text-center text-[1.0625rem]" aria-label={t('sell.qty')}>{l.quantity}</span>
                            <button className="btn btn-sm" aria-label={`${t('sell.qty')} +`} onClick={() => setQty(l.id, toDec(l.quantity).plus(1).toString())}>
                              <Plus className="size-4" aria-hidden />
                            </button>
                          </>
                        ) : (
                          <input
                            aria-label={t('sell.qty')}
                            className="input money h-9 w-24 text-right"
                            inputMode="decimal"
                            defaultValue={l.quantity}
                            onBlur={(e) => /^\d{1,6}(\.\d{1,4})?$/.test(e.target.value) && toDec(e.target.value).gt(0) && setQty(l.id, e.target.value)}
                          />
                        )}
                        {/* Discounts and price changes need the server: not offered offline (ADR-0015 §1). */}
                        {!l.statutory && !offline && (
                          <button className="btn btn-sm" aria-pressed={isOpen(l.id, 'sc')} onClick={() => toggle(l.id, 'sc')}>
                            {t('sell.sc')}
                          </button>
                        )}
                        {canDiscount && !l.statutory && !offline && (
                          <button className="btn btn-sm" aria-pressed={isOpen(l.id, 'discount')} onClick={() => toggle(l.id, 'discount')}>
                            {t('disc.button')}
                          </button>
                        )}
                        {!offline && (
                          <button className="btn btn-sm" aria-pressed={isOpen(l.id, 'price')} onClick={() => (l.override ? setOverride(l.id, null) : toggle(l.id, 'price'))}>
                            {l.override ? t('price.undo') : t('price.button')}
                          </button>
                        )}
                        {/* Kept apart from the other row controls: one mis-tap must not drop a line. */}
                        <button className="btn btn-sm btn-danger ml-3" aria-label={t('sell.remove')} onClick={() => remove(l.id)}>
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </div>
                      <div className="text-right">
                        <Money value={q?.amountDue} className="text-[1.0625rem] font-semibold" />
                        {q && (isPositive(q.statutoryDiscount) || (q.discount !== undefined && isPositive(q.discount))) && (
                          <p className="money text-[0.75rem] text-muted line-through">
                            <Money value={q.gross} />
                          </p>
                        )}
                      </div>
                    </div>
                    {isOpen(l.id, 'discount') && (
                      <DiscountPanel lineId={l.id} current={l.discount} onApply={(d) => setDiscount(l.id, d)} onRemove={() => setDiscount(l.id, null)} onCancel={() => setPanel(null)} />
                    )}
                    {isOpen(l.id, 'price') && (
                      <PricePanel
                        lineId={l.id}
                        branchId={shift.branch.id}
                        variantId={l.variantId}
                        listPrice={q?.unitPrice}
                        canApprove={canApprovePrice}
                        onApproved={(o) => setOverride(l.id, o)}
                        onCancel={() => setPanel(null)}
                      />
                    )}
                    {isOpen(l.id, 'sc') && (
                      <form className="mt-3 grid gap-3 rounded-[5px] border border-hair bg-white p-4" onSubmit={(e) => applyStatutory(l.id, e)}>
                        <p className="font-semibold">{t('sell.scTitle')}</p>
                        <p className="text-[0.8125rem] text-muted">{t('sell.scHint')}</p>
                        <div className="grid gap-3 sm:grid-cols-[120px_1fr_1fr]">
                          <div className="field">
                            <label htmlFor={`scheme-${l.id}`}>{t('sell.scheme')}</label>
                            <select id={`scheme-${l.id}`} name="scheme" className="input">
                              <option value="SC">SC</option>
                              <option value="PWD">PWD</option>
                            </select>
                          </div>
                          <Field id={`bn-${l.id}`} name="name" required label={t('sell.beneficiaryName')} autoFocus />
                          <Field id={`bid-${l.id}`} name="idNumber" required label={t('sell.idNumber')} />
                        </div>
                        <div className="flex gap-2">
                          <button className="btn btn-primary">{t('sell.apply')}</button>
                          <button type="button" className="btn" onClick={() => setPanel(null)}>{t('common.cancel')}</button>
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Note>
      </div>

      <aside className="grid content-start gap-4" aria-label={t('totals.title')}>
        <Note className="p-5">
          <p className="text-muted">{t('totals.title')}</p>
          <p className="money text-[2.5rem] font-semibold leading-tight" aria-live="polite">
            <Money value={due} />
          </p>
          {exchange && quote && (
            <p className="mt-1 flex justify-between text-[0.9375rem]">
              <span className="text-muted">{t('exch.credit')}</span>
              <Money value={`-${exchange.refund}`} />
            </p>
          )}
          {isPositive(credit) && quote && (
            <p className="mt-1 flex justify-between text-[0.9375rem]" data-testid="credit-applied">
              <span className="text-muted">{t('custc.creditApplied')}</span>
              <Money value={`-${credit}`} />
            </p>
          )}
          {quoting && <p className="text-[0.8125rem] text-muted">{t('totals.updating')}</p>}
          {quote && <TotalsBreakdown quote={quote} />}
          {quote?.requiresProfessionalReview && <div className="mt-3"><Callout kind="warn">{t('sell.pendingReview')}</Callout></div>}
        </Note>

        <PaymentPanel
          pay={pay}
          priced={cart.length > 0 && !!quote && !quoting}
          submitLabel={offline ? t('till.offlineSubmit') : exchange ? t('exch.complete') : t('pay.complete')}
          onSubmit={complete}
          canSubmit={cart.length > 0 && !(offline && (cart.some((l) => l.statutory || l.discount || l.override) || exchange))}
          cashOnly={offline}
        />
      </aside>

      {/* Phones: the total and Pay stay in reach while the cart scrolls (the payment panel is below it). */}
      {cart.length > 0 && !panelInView && (
        <div className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-hair bg-white/95 px-4 py-3 shadow-[0_-4px_12px_rgb(0_0_0/0.08)] backdrop-blur lg:hidden" data-testid="pay-bar">
          <div className="mx-auto flex max-w-[640px] items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[0.8125rem] text-muted">{t('totals.title')} · {cart.length === 1 ? t('sell.itemsOne') : t('sell.itemsN', { n: String(cart.length) })}</p>
              <p className="money text-[1.5rem] font-semibold leading-tight" aria-live="polite"><Money value={due} /></p>
            </div>
            <button className="btn btn-primary min-h-12 px-6 text-[1.0625rem]" disabled={!quote || quoting} onClick={goToPayment}>
              {t('sell.pay')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A held cart's line as the server gives it back on resume. */
interface HeldLine {
  id?: string;
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  wholeUnits?: boolean;
  statutory?: { scheme: 'SC' | 'PWD'; beneficiary: string };
  discountRate?: string;
  discount?: string;
  priceOverrideId?: string;
}

/** A refusal the till makes itself, before pricing (e.g. a discount while offline). */
class OfflineRefusal extends Error {}

/** The till's offline pricing in the shape of the server's quote (lines matched by position). */
function offlineQuote(r: Awaited<ReturnType<OfflineEngine['quote']>>, cart: CartLine[]): Quote {
  return {
    taxProfile: { vatStatus: r.taxProfile.vatStatus, vatRate: r.taxProfile.vatRate },
    totals: r.totals,
    requiresProfessionalReview: false,
    lines: r.lines.map((l, i) => ({
      id: cart[i]!.id, variantId: cart[i]!.variantId, sku: r.items[i]!.sku, name: r.items[i]!.name, unitPrice: r.items[i]!.unitPrice,
      quantity: cart[i]!.quantity, gross: l.gross, statutoryDiscount: l.statutoryDiscount, amountDue: l.amountDue, vatTreatment: r.items[i]!.vatTreatment,
    })),
  };
}

function TotalsBreakdown({ quote }: { quote: Quote }) {
  const { t } = useT();
  const z = quote.totals;
  const rows: [string, string][] =
    quote.taxProfile.vatStatus === 'VAT'
      ? [
          [t('totals.vatable'), z.vatableSales],
          [`${t('totals.vat')} ${toDec(quote.taxProfile.vatRate).times(100).toString()}%`, z.vatAmount],
          [t('totals.exempt'), z.vatExemptSales],
          [t('totals.zero'), z.zeroRatedSales],
        ]
      : [
          [t('totals.pt'), z.percentageTaxSales],
          [t('totals.exempt'), z.vatExemptSales],
        ];
  if (isPositive(z.vatExemptionAmount)) rows.push([t('totals.vatExemption'), `-${z.vatExemptionAmount}`]);
  if (isPositive(z.statutoryDiscount)) rows.push([t('totals.statutory'), `-${z.statutoryDiscount}`]);
  return (
    <dl className="mt-3 grid gap-1 border-t border-hair-soft pt-3 text-[0.875rem]">
      {rows
        .filter(([, v]) => !isZero(v.replace('-', '')))
        .map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-muted">{k}</dt>
            <dd><Money value={v} /></dd>
          </div>
        ))}
    </dl>
  );
}
