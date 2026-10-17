import { Minus, Plus, ScanLine, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure, uuid } from '../lib/api';
import { toDec } from '@1pos/money';
import { isPositive, isZero } from '../lib/money';
import { useTill } from '../lib/till';
import type { LookupItem, Quote, Receipt as ReceiptData } from '../types';
import { OfflineSaleError, type OfflineEngine, type OfflineReceipt as OfflineReceiptData } from '@1pos/pos-offline';
import { errorText, PaymentPanel, unanswered, usePayment, type Notice } from './Payment';
import type { Shift } from './Registers';
import { Receipt } from './Receipt';
import { OfflineReceipt } from './Till';
import { Callout, Field, Money, Note } from './ui';

interface CartLine {
  id: string;
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  wholeUnits: boolean;
  statutory?: { scheme: 'SC' | 'PWD'; beneficiary: string };
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
export function Sell({ shift, cashierUserId, active = true }: { shift: Shift; cashierUserId: string; active?: boolean }) {
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
  const [scDraft, setScDraft] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const due = quote?.totals.amountDue ?? '0.00';
  const pay = usePayment({ shift, due, setNotice });

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
          const r = await till.engine!.quote(cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })));
          if (live) {
            setQuote(offlineQuote(r, cart));
            setNotice((n) => (n?.kind === 'error' ? null : n));
          }
          return;
        }
        const q = await api<Quote>('POST', '/v1/tax/quote', {
          branchId: shift.branch.id,
          lines: cart.map((l) => ({ id: l.id, variantId: l.variantId, quantity: l.quantity, ...(l.statutory && { statutory: { scheme: l.statutory.scheme } }) })),
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
    };
  }

  function addItem(item: LookupItem) {
    if (!item.price) {
      setNotice({ kind: 'warn', text: t('sell.unpriced', { name: item.name }) });
      return;
    }
    setNotice(null);
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
        const found = await api<{ data: ProductHit[] }>('GET', `/v1/products?q=${encodeURIComponent(q)}&limit=8`).catch(() => ({ data: [] }));
        if (found.data.length) setHits(found.data);
        else setNotice({ kind: 'warn', text: t('sell.notFound', { q }) });
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
    setCart((c) => c.map((l) => (l.id === lineId ? { ...l, statutory: { scheme, beneficiary: ref } } : l)));
    setScDraft(null);
    focusScan();
  }

  function clearStatutory(lineId: string) {
    setCart((c) => c.map((l) => (l.id === lineId ? { id: l.id, variantId: l.variantId, sku: l.sku, name: l.name, quantity: l.quantity, wholeUnits: l.wholeUnits } : l)));
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
    const saleId = await pay.submit(
      (body, key) =>
        api<{ id: string }>(
          'POST',
          '/v1/sales',
          {
            cashierSessionId: shift.sessionId,
            ...body,
            lines: cart.map((l) => ({ id: l.id, variantId: l.variantId, quantity: l.quantity, ...(l.statutory && { statutory: l.statutory }) })),
            beneficiaries: beneficiaries.filter((b) => cart.some((l) => l.statutory?.beneficiary === b.ref)),
            expectedAmountDue: due,
          },
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

  function newSale() {
    setCart([]);
    setBeneficiaries([]);
    pay.reset();
    setReceipt(null);
    setOfflineReceipt(null);
    setNotice(null);
    focusScan();
  }

  if (receipt || offlineReceipt) {
    return (
      <div className="mx-auto grid max-w-[1100px] gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[1fr_360px]">
        {receipt ? <Receipt data={receipt} /> : <OfflineReceipt data={offlineReceipt!} />}
        <div className="no-print grid content-start gap-3">
          <button className="btn btn-primary w-full" autoFocus onClick={newSale}>
            {t('sell.newSale')}
          </button>
        </div>
      </div>
    );
  }

  const quoteLine = (id: string) => quote?.lines.find((l) => l.id === id);

  return (
    <div className="mx-auto grid max-w-[1440px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[1fr_400px]">
      <div className="grid content-start gap-4">
        <form onSubmit={scan} className="flex gap-2">
          <label htmlFor="scan" className="sr-only">{t('sell.scan')}</label>
          <div className="relative flex-1">
            <ScanLine className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
            <input id="scan" ref={scanRef} autoFocus autoComplete="off" className="input pl-10 text-[1.0625rem]" placeholder={t('sell.scan')} />
          </div>
          <button className="btn btn-primary">{t('sell.add')}</button>
        </form>

        {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}

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
                    <div className="grid grid-cols-[1fr_auto] items-start gap-3 sm:grid-cols-[1fr_auto_auto]">
                      <div className="min-w-0">
                        <p className="font-semibold">{l.name}</p>
                        <p className="serial text-[0.75rem] text-muted">
                          {l.sku}
                          {q && <> · <Money value={q.unitPrice} /></>}
                        </p>
                        {b && (
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-[0.8125rem]">
                            <span className="chip bg-blue">{b.scheme}</span>
                            <span>{b.name}</span>
                            <span className="serial text-muted">{b.idNumber}</span>
                            <button className="btn btn-sm btn-danger" onClick={() => clearStatutory(l.id)}>{t('sell.removeDiscount')}</button>
                          </p>
                        )}
                      </div>
                      <div className="col-span-2 row-start-2 flex items-center gap-1 sm:col-span-1 sm:row-start-auto">
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
                        {/* Discounts need the server: not offered offline (ADR-0015 §1). */}
                        {!l.statutory && !offline && (
                          <button className="btn btn-sm" aria-pressed={scDraft === l.id} onClick={() => setScDraft(scDraft === l.id ? null : l.id)}>
                            {t('sell.sc')}
                          </button>
                        )}
                        {/* Kept apart from the other row controls: one mis-tap must not drop a line. */}
                        <button className="btn btn-sm btn-danger ml-3" aria-label={t('sell.remove')} onClick={() => remove(l.id)}>
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </div>
                      <div className="text-right">
                        <Money value={q?.amountDue} className="text-[1.0625rem] font-semibold" />
                        {q && isPositive(q.statutoryDiscount) && (
                          <p className="money text-[0.75rem] text-muted line-through">
                            <Money value={q.gross} />
                          </p>
                        )}
                      </div>
                    </div>
                    {scDraft === l.id && (
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
                          <button type="button" className="btn" onClick={() => setScDraft(null)}>{t('common.cancel')}</button>
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
          {quoting && <p className="text-[0.8125rem] text-muted">{t('totals.updating')}</p>}
          {quote && <TotalsBreakdown quote={quote} />}
          {quote?.requiresProfessionalReview && <div className="mt-3"><Callout kind="warn">{t('sell.pendingReview')}</Callout></div>}
        </Note>

        <PaymentPanel
          pay={pay}
          priced={cart.length > 0 && !!quote && !quoting}
          submitLabel={offline ? t('till.offlineSubmit') : t('pay.complete')}
          onSubmit={complete}
          canSubmit={cart.length > 0 && !(offline && cart.some((l) => l.statutory))}
          cashOnly={offline}
        />
      </aside>
    </div>
  );
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
