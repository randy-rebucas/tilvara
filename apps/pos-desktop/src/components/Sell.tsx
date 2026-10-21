import { CalendarClock, ChefHat, MonitorUp, Minus, PauseCircle, Pin, Plus, ScanLine, Ticket, Trash2, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure, uuid } from '../lib/api';
import { toDec } from '@1pos/money';
import { add, gte, isPositive, isZero, peso, sub } from '../lib/money';
import { clockTime } from '../lib/calendar';
import { pressIfEnabled, useShortcuts } from '../lib/shortcuts';
import { useTill } from '../lib/till';
import { openCustomerDisplay, usePublishDisplay, type DisplayState } from '../lib/customer-display';
import type { AppointmentRingUp, CounterCustomer, CustomerNote, CustomerPackage, LookupItem, Quote, Receipt as ReceiptData } from '../types';
import { OfflineSaleError, type OfflineEngine, type OfflineReceipt as OfflineReceiptData } from '@1pos/pos-offline';
import { errorText, PaymentPanel, unanswered, usePayment, type Notice, type TipStaff } from './Payment';
import type { Shift } from './Registers';
import { Receipt } from './Receipt';
import { OfflineReceipt } from './Till';
import { Callout, Empty, Field, Money, Note } from './ui';
import { QuickKeys } from './QuickKeys';
import { CartDiscountPanel, CustomerPanel, DiscountPanel, ExchangeBanner, HeldCartsPanel, PricePanel, rateOf, type ExchangeStart, type HeldCart, type LineDiscount, type LineOverride } from './CounterTools';
import { CounterChoicesPanel, useCounterMenu, type CounterItem } from './Choices';

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
  /** Counter service (session 25): a menu item's choices and a note for the kitchen. */
  choices?: { id: string; name: string; variantId: string | null }[];
  kitchenNote?: string;
  /** ADR-0022: who did or sold it (a service staff member), and the customer's package paying for it. */
  staffId?: string;
  packageId?: string;
  packageName?: string;
}

/** A service staff member as the till offers them on a line (from the server, or the till's snapshot offline). */
interface LineStaff {
  id: string;
  displayName: string;
  color: string | null;
  /** The services they do; none = every service (absent offline: anyone). */
  services?: { variantId: string }[];
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
    ...(!forQuote && l.choices?.length && { choices: l.choices.map((c) => c.id) }),
    ...(!forQuote && l.kitchenNote && { kitchenNote: l.kitchenNote }),
    ...(l.staffId && { staffId: l.staffId }),
    ...(l.packageId && { packageId: l.packageId }),
  };
}

/** Id of a priced choice's own line in the quote: under its item (the server prices it the same way). */
const choiceLineId = (lineId: string, n: number) => `${lineId}.c${n + 1}`;

/**
 * The cart as the server prices it (counter service): each item followed by its priced choices as
 * lines of their own, at the item's quantity, with the item's SC/PWD scheme. Free choices cost nothing.
 */
function quoteLines(cart: CartLine[]) {
  return cart.flatMap((l) => [
    lineBody(l, true),
    ...(l.choices ?? []).flatMap((c, n) => (c.variantId
      ? [{ id: choiceLineId(l.id, n), variantId: c.variantId, quantity: l.quantity, ...(l.statutory && { statutory: { scheme: l.statutory.scheme } }) }]
      : [])),
  ]);
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
export function Sell({ shift, cashierUserId, active = true, permissions = [], exchange = null, onExchangeEnd, salon = false, ringUp = null, onRingUpTaken, lodging = false }: {
  shift: Shift;
  cashierUserId: string;
  active?: boolean;
  /** From /me (any scope): hints for which controls to offer; the server decides. */
  permissions?: string[];
  /** An exchange started from This shift: the refund pays for the cart first (session 20). */
  exchange?: ExchangeStart | null;
  onExchangeEnd?: () => void;
  /** A salon or hybrid business (ADR-0022): staff on lines, packages, client notes, appointments. */
  salon?: boolean;
  /** An appointment to ring up, handed over from the Appointments tab; `onRingUpTaken` once it is read. */
  ringUp?: AppointmentRingUp | null;
  onRingUpTaken?: () => void;
  /** A hotel, resort or hybrid business (ADR-0023): the "Charge to room" tender, online only. */
  lodging?: boolean;
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
  // Counter service (session 25): the takeaway menu's choices, the item being chosen for, the pickup name.
  const counter = useCounterMenu(shift, offline);
  const [choosing, setChoosing] = useState<{ item: LookupItem; menuItem: CounterItem; lineId?: string } | null>(null);
  const [pickupName, setPickupName] = useState('');
  const hasKitchen = Boolean(counter && cart.some((l) => counter.items.has(l.variantId)));
  const [showHeld, setShowHeld] = useState(false);
  const [discountingCart, setDiscountingCart] = useState(false);
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
  // Salons (ADR-0022): the branch's staff, the appointment being rung up, the customer's packages and pinned notes.
  const [staff, setStaff] = useState<LineStaff[]>([]);
  const [appointment, setAppointment] = useState<AppointmentRingUp['appointment'] | null>(null);
  const [packages, setPackages] = useState<CustomerPackage[]>([]);
  const [pinnedNotes, setPinnedNotes] = useState<CustomerNote[]>([]);
  const staffName = (id: string) => staff.find((x) => x.id === id)?.displayName ?? appointment?.services.find((x) => x.staffId === id)?.staffName ?? '';
  // The tip is shared among the distinct staff on the lines, in line order (ADR-0022 §7).
  const staffKey = cart.map((l) => l.staffId ?? '').join(',');
  const tipStaff = useMemo<TipStaff[]>(
    () => [...new Set(cart.flatMap((l) => (l.staffId ? [l.staffId] : [])))].map((id) => ({ id, name: staffName(id) })),
    [staffKey, staff],
  );
  const pay = usePayment({ shift, due: payable, setNotice, allowTip: !exchange, tipStaff, allowRoomCharge: lodging && !offline && !exchange });

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

  // Salons: the staff who can be named on a line. Online from the server; offline from the till's snapshot.
  useEffect(() => {
    if (!salon) return;
    let live = true;
    const fromSnapshot = () => till.snapshotStaff();
    const load: Promise<LineStaff[]> = offline
      ? fromSnapshot()
      : api<{ data: (LineStaff & { archivedAt: string | null })[] }>('GET', `/v1/service-staff?branchId=${shift.branch.id}`)
          .then((r) => r.data.filter((x) => !x.archivedAt))
          .catch(() => fromSnapshot());
    load.then((xs) => live && setStaff(xs)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [salon, offline, shift.branch.id]);

  // Salons: the customer's open packages (to use a session) and pinned notes (allergies, preferences).
  useEffect(() => {
    setPackages([]);
    setPinnedNotes([]);
    if (!salon || !customer || offline) return;
    let live = true;
    api<{ data: CustomerPackage[] }>('GET', `/v1/customers/${customer.id}/packages?open=true`)
      .then((r) => live && setPackages(r.data.filter((p) => !p.expired)))
      .catch(() => undefined);
    api<{ data: CustomerNote[] }>('GET', `/v1/customers/${customer.id}/notes`)
      .then((r) => live && setPinnedNotes(r.data.filter((n) => n.pinned)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [salon, customer?.id, offline]);

  // An appointment handed over from the Appointments tab: its services become the cart, with their staff.
  useEffect(() => {
    if (!ringUp) return;
    onRingUpTaken?.();
    if (cart.length > 0 || pay.intents.length > 0 || exchange || receipt || offlineReceipt) {
      setNotice({ kind: 'warn', text: t('appt.cartBusy') });
      return;
    }
    const a = ringUp.appointment;
    setCart(a.services.map((x) => ({ id: uuid(), variantId: x.variantId, sku: '', name: x.name, quantity: '1', wholeUnits: true, staffId: x.staffId })));
    setAppointment(a);
    setNotice(null);
    if (a.customerId) {
      api<CounterCustomer>('GET', `/v1/customers/${a.customerId}`)
        .then((c) => setCustomer(c))
        .catch((err) => setNotice({ kind: 'warn', text: errorText(err, t('common.error'), t('common.network')) }));
    }
    focusScan();
  }, [ringUp?.nonce]);

  // Clearing the cart forgets the appointment it was rung up for.
  useEffect(() => {
    if (cart.length === 0 && appointment) setAppointment(null);
  }, [cart.length]);

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
          if (cart.some((l) => l.packageId)) throw new OfflineRefusal(t('pkg.onlineOnly'));
          const r = await till.engine!.quote(cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity, choices: l.choices?.map((c) => c.id), kitchenNote: l.kitchenNote, staffId: l.staffId })));
          if (live) {
            setQuote(offlineQuote(r, cart));
            setNotice((n) => (n?.kind === 'error' ? null : n));
          }
          return;
        }
        const q = await api<Quote>('POST', '/v1/tax/quote', {
          branchId: shift.branch.id,
          lines: quoteLines(cart),
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
      ...(item.productType && { productType: item.productType as LookupItem['productType'] }),
    };
  }

  /** Add an item; `times` is a quantity typed before the scan ("5*", ADR-0021 §3). */
  function addItem(item: LookupItem, times?: string) {
    if (!item.price) {
      setNotice({ kind: 'warn', text: t('sell.unpriced', { name: item.name }) });
      return;
    }
    // A package needs the server (the customer's balance, ADR-0022 §6): the till refuses it offline.
    if (offline && item.productType === 'PACKAGE') {
      setNotice({ kind: 'warn', text: t('pkg.onlineOnlyItem', { name: item.name }) });
      return;
    }
    // Counter service: a menu item the kitchen cannot make now is refused here; one with choices asks for them.
    const menuItem = counter?.items.get(item.variantId);
    if (menuItem && !menuItem.available) {
      setNotice({ kind: 'warn', text: t(menuItem.soldOut ? 'counter.soldOut' : 'sell.unpriced', { name: menuItem.name }) });
      return;
    }
    if (menuItem && menuItem.modifierGroups.length > 0 && !item.quantity) {
      setNotice(null);
      setChoosing({ item, menuItem });
      return;
    }
    setNotice(null);
    // A scale label is one weighed pack: its own line, at the printed weight, never merged with another.
    if (item.quantity) {
      setCart((c) => [...c, { id: uuid(), variantId: item.variantId, sku: item.sku, name: item.name, quantity: item.quantity!, wholeUnits: false }]);
      return;
    }
    const wholeUnits = item.soldBy === 'UNIT' && !item.uom.allowsFraction;
    if (times && wholeUnits && !toDec(times).isInteger()) {
      setNotice({ kind: 'warn', text: t('sell.wholeUnits', { name: item.name }) });
      return;
    }
    const n = times ?? '1';
    setCart((c) => {
      // Never into a discounted or manager-priced line: the approval was for what was on it then.
      const existing = c.find((l) => l.variantId === item.variantId && !l.statutory && !l.discount && !l.override && l.wholeUnits && !l.choices?.length && !l.kitchenNote);
      if (existing) return c.map((l) => (l === existing ? { ...l, quantity: toDec(l.quantity).plus(n).toString() } : l));
      return [...c, { id: uuid(), variantId: item.variantId, sku: item.sku, name: item.name, quantity: toDec(n).toString(), wholeUnits }];
    });
  }

  async function scan(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await addByCode(scanRef.current?.value.trim() ?? '');
  }

  /** Scan, typed code or quick key. "5*" (or "5×") before the code sells five. */
  async function addByCode(raw: string) {
    const multiplied = /^(\d{1,5}(?:\.\d{1,4})?)\s*[*×]\s*(\S.*)$/.exec(raw);
    const q = multiplied ? multiplied[2]!.trim() : raw;
    const times = multiplied && toDec(multiplied[1]!).gt(0) ? multiplied[1]! : undefined;
    if (!q) return;
    if (multiplied && !times) {
      setNotice({ kind: 'warn', text: t('sell.timesZero') });
      return;
    }
    setHits(null);
    const fromSnapshot = async () => {
      const item = await lookupOffline(q);
      if (item) {
        addItem(item, times);
        scanRef.current!.value = '';
      } else setNotice({ kind: 'warn', text: t('till.notFoundOffline', { q }) });
    };
    try {
      if (offline) await fromSnapshot();
      else {
        try {
          addItem(await api<LookupItem>('GET', `/v1/catalog/lookup?code=${encodeURIComponent(q)}&branchId=${shift.branch.id}`), times);
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

  /** The choices panel was applied: a new line (never merged), or the line being changed. */
  function applyChoices(ids: string[], note: string) {
    if (!choosing) return;
    const options = choosing.menuItem.modifierGroups.flatMap((g) => g.options);
    const choices = ids.map((id) => {
      const o = options.find((x) => x.id === id)!;
      return { id: o.id, name: o.name, variantId: o.variantId };
    });
    const extra = { choices, ...(note && { kitchenNote: note }) };
    if (choosing.lineId) {
      patchLine(choosing.lineId, (l) => {
        const { choices: _c, kitchenNote: _n, ...rest } = l;
        return { ...rest, ...extra };
      });
    } else {
      const { item } = choosing;
      const wholeUnits = item.soldBy === 'UNIT' && !item.uom.allowsFraction;
      setCart((c) => [...c, { id: uuid(), variantId: item.variantId, sku: item.sku, name: item.name, quantity: '1', wholeUnits, ...extra }]);
    }
    setChoosing(null);
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

  /**
   * Lines a whole-cart discount reaches (ADR-0021 §3): none with SC/PWD, an approved price, its own
   * discount or a promotion (the cashier's discount would replace the promotion).
   */
  const cartDiscountLines = cart.filter((l) => !l.statutory && !l.override && !l.discount && !quote?.lines.find((q) => q.id === l.id)?.promotionId);
  function discountCart(percent: string) {
    const ids = new Set(cartDiscountLines.map((l) => l.id));
    setCart((c) => c.map((l) => (ids.has(l.id) ? { ...l, discount: { kind: 'RATE' as const, percent } } : l)));
    setDiscountingCart(false);
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
        // A package session needs the customer, who is not held with the cart: the line is held without it.
        lines: cart.map((l) => {
          const { packageId: _p, ...body } = lineBody(l);
          return { ...body, name: l.name, sku: l.sku || (quote?.lines.find((q) => q.id === l.id)?.sku ?? l.variantId.slice(0, 8)), wholeUnits: l.wholeUnits };
        }),
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

  function heldChoices(l: HeldLine) {
    const options = counter?.items.get(l.variantId)?.modifierGroups.flatMap((g) => g.options) ?? [];
    return (l.choices ?? []).flatMap((id) => {
      const o = options.find((x) => x.id === id);
      return o ? [{ id: o.id, name: o.name, variantId: o.variantId }] : [];
    });
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
        // Counter service: the held choices (ids) get their names back from the menu served now; one
        // no longer offered is dropped, and the quote or the server then asks for the item's choices again.
        ...(l.choices?.length && { choices: heldChoices(l) }),
        ...(l.kitchenNote && { kitchenNote: l.kitchenNote }),
        ...(l.staffId && { staffId: l.staffId }),
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
      const { receipt: kept, kitchen } = await till.engine!.ringUp({
        cashierUserId, terminalTxnId: pay.txId, tendered: pay.cashAmount,
        lines: cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity, choices: l.choices?.map((c) => c.id), kitchenNote: l.kitchenNote, staffId: l.staffId })),
        ...(pickupName.trim() && { pickupName: pickupName.trim() }),
        ...(isPositive(pay.cashTip) && { tip: pay.cashTip }),
      });
      setNotice(null);
      setOfflineReceipt(kept);
      void till.refresh();
      // Counter service offline: the kitchen gets its tickets from this till's printers.
      if (kitchen.length && kept.callNumber) {
        const failed = await till.printLocalKitchen(kitchen, { callNumber: kept.callNumber, pickupName: kept.pickupName }, new Date(kept.occurredAt).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: false }));
        if (failed.length) setNotice({ kind: 'warn', text: t('counter.kitchenNotPrinted', { stations: failed.join(', '), n: String(kept.callNumber) }) });
      }
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
              {
                // Nothing to pay (package sessions only): the sale still names a tender, cash of nothing.
                cashierSessionId: shift.sessionId, ...body, tenders: creditTender.length || body.tenders.length ? [...creditTender, ...body.tenders] : [{ method: 'CASH' as const, tendered: '0.00' }],
                lines, beneficiaries: used, expectedAmountDue: due, ...withCustomer,
                ...(hasKitchen && pickupName.trim() && { pickupName: pickupName.trim() }),
                ...(appointment && { appointmentId: appointment.id }),
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
    setAppointment(null);
    setCustomer(null);
    setUsingCredit(false);
    setPickingCustomer(false);
    setCart([]);
    setBeneficiaries([]);
    setPanel(null);
    setChoosing(null);
    setPickupName('');
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
          {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}
          <button className="btn btn-primary w-full" autoFocus onClick={newSale}>
            {t('sell.newSale')} <kbd className="kbd">F2</kbd>
          </button>
        </div>
      </div>
    );
  }

  const quoteLine = (id: string) => quote?.lines.find((l) => l.id === id);
  /** What a cart line costs with its priced choices (each its own line in the quote). */
  const lineDue = (l: CartLine) => {
    const own = quoteLine(l.id)?.amountDue;
    if (own === undefined) return undefined;
    return (l.choices ?? []).reduce((a, c, n) => (c.variantId ? add(a, quoteLine(choiceLineId(l.id, n))?.amountDue ?? '0.00') : a), own);
  };
  /** Take the customer off the sale: package sessions on the cart were theirs, so the lines go back to full price. */
  const removeCustomer = () => {
    setCustomer(null);
    setUsingCredit(false);
    setCart((c) => (c.some((l) => l.packageId) ? c.map(({ packageId: _p, packageName: _n, ...rest }) => rest) : c));
  };
  /**
   * Staff offered on a line: for a service, those who do it (none listed = every service) and whoever is
   * on it now; anyone for a product (who sold it).
   */
  const staffFor = (l: CartLine) => {
    if (quoteLine(l.id)?.productType !== 'SERVICE') return staff;
    return staff.filter((x) => x.id === l.staffId || !x.services?.length || x.services.some((v) => v.variantId === l.variantId));
  };
  /**
   * A package of the customer's that covers this service line, with the sessions it has left after the
   * other lines of this cart using it (ADR-0022 §6). Online only; never on a line with a discount of its own.
   */
  const packageFor = (l: CartLine) => {
    if (offline || l.packageId || quoteLine(l.id)?.productType !== 'SERVICE') return null;
    for (const p of packages) {
      const item = p.services.find((x) => x.variantId === l.variantId);
      if (!item) continue;
      const used = cart.filter((o) => o.id !== l.id && o.packageId === p.id && o.variantId === l.variantId).reduce((a, o) => a.plus(o.quantity), toDec('0'));
      const left = toDec(String(item.sessionsLeft)).minus(used);
      if (left.gte(l.quantity)) return { pkg: p, left: left.toString() };
    }
    return null;
  };
  function applyPackage(lineId: string, p: CustomerPackage) {
    // A session is paid for already: no SC/PWD, discount or approved price on it (the server refuses them).
    patchLine(lineId, ({ statutory: _s, discount: _d, override: _o, ...rest }) => ({ ...rest, packageId: p.id, packageName: p.name }));
    if (panel?.lineId === lineId) setPanel(null);
    focusScan();
  }
  const dropPackage = (lineId: string) => patchLine(lineId, ({ packageId: _p, packageName: _n, ...rest }) => rest);
  // A package sold needs a customer to own it (ADR-0022 §6): said before payment, not by a refused sale.
  const packageNeedsCustomer = !customer && Boolean(quote?.lines.some((l) => l.productType === 'PACKAGE'));
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
          <span><kbd className="kbd">5*</kbd> {t('keys.times')}</span>
          <span><kbd className="kbd">F4</kbd> {t('keys.cash')}</span>
          <span><kbd className="kbd">F8</kbd> {t('keys.exact')}</span>
          <span><kbd className="kbd">F9</kbd> {t('keys.complete')}</span>
        </p>

        {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}

        {exchange && <ExchangeBanner exchange={exchange} total={quote?.totals.amountDue} onCancel={newSale} />}

        {appointment && (
          <div className="no-print flex flex-wrap items-center gap-2 rounded-[5px] border border-hair bg-white px-3 py-2" data-testid="sale-appointment">
            <CalendarClock className="size-4 text-muted" aria-hidden />
            <span className="font-semibold">{t('appt.ringing', { time: clockTime(appointment.startsAt, shift.branch.timezone) })}</span>
            <span className="text-muted">{appointment.customerName ?? appointment.guestName ?? ''}</span>
            <button type="button" className="btn btn-sm ml-auto" onClick={() => setAppointment(null)}>{t('appt.forget')}</button>
          </div>
        )}

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
              <button type="button" className="btn btn-sm" onClick={removeCustomer}>{t('custc.remove')}</button>
            </span>
            {pinnedNotes.length > 0 && (
              <ul className="grid w-full gap-1 border-t border-hair-soft pt-2 text-[0.875rem]" aria-label={t('notes.pinned')} data-testid="customer-notes">
                {pinnedNotes.map((n) => (
                  <li key={n.id} className="flex items-start gap-2">
                    <Pin className="mt-0.5 size-4 shrink-0 text-orange" aria-hidden />
                    <span className="whitespace-pre-line">{n.body}</span>
                  </li>
                ))}
              </ul>
            )}
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
            {cart.length > 0 && canDiscount && (
              <button type="button" className="btn btn-sm" aria-pressed={discountingCart} onClick={() => setDiscountingCart(!discountingCart)}>
                {t('disc.cartButton')}
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
        {discountingCart && !offline && <CartDiscountPanel eligible={cartDiscountLines.length} onApply={discountCart} onCancel={() => setDiscountingCart(false)} />}
        {showHeld && held.length > 0 && <HeldCartsPanel carts={held} cartEmpty={cart.length === 0} timezone={shift.branch.timezone} onResume={resume} onDiscard={discard} />}

        {choosing && (
          <CounterChoicesPanel
            key={choosing.lineId ?? choosing.item.variantId}
            item={choosing.menuItem}
            editing={Boolean(choosing.lineId)}
            initial={choosing.lineId ? cart.find((l) => l.id === choosing.lineId)?.choices?.map((c) => c.id) : undefined}
            initialNote={choosing.lineId ? cart.find((l) => l.id === choosing.lineId)?.kitchenNote : undefined}
            onApply={applyChoices}
            onCancel={() => { setChoosing(null); focusScan(); }}
          />
        )}

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

        {!choosing && <QuickKeys branchId={shift.branch.id} offline={offline} onPick={(sku) => { void addByCode(sku).then(focusScan); }} />}

        <Note denom="blue" className="min-h-[240px] p-2">
          {cart.length === 0 ? (
            <Empty>{t('sell.emptyCart')}</Empty>
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
                          {l.sku || q?.sku}
                          {q && <> · <Money value={q.unitPrice} /></>}
                        </p>
                        {l.packageId && (
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-[0.8125rem]" data-testid="line-package">
                            <span className="chip bg-green">{t('pkg.fromPackage', { name: l.packageName ?? '' })}</span>
                            <button type="button" className="btn btn-sm" onClick={() => dropPackage(l.id)}>{t('pkg.stop')}</button>
                          </p>
                        )}
                        {(l.choices?.length || l.kitchenNote) && (
                          <p className="mt-1 text-[0.875rem]" data-testid="line-choices">
                            {l.choices?.map((c, n) => {
                              const cq = c.variantId ? quoteLine(choiceLineId(l.id, n)) : undefined;
                              return <span key={c.id} className="mr-2">{c.name}{cq && <span className="money text-muted"> +<Money value={cq.amountDue} /></span>}</span>;
                            })}
                            {l.kitchenNote && <span className="italic text-muted">“{l.kitchenNote}”</span>}
                          </p>
                        )}
                        {q?.promotionName && q.discount && isPositive(q.discount) && (
                          <p className="mt-1 text-[0.8125rem]" data-testid="line-promotion">
                            <span className="chip bg-green">{q.promotionName} · −<Money value={q.discount} /></span>
                          </p>
                        )}
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
                            <button className="btn btn-sm" aria-label={`${t('sell.qty')} −`} disabled={toDec(l.quantity).lte(1)} onClick={() => setQty(l.id, toDec(l.quantity).minus(1).toString())}>
                              <Minus className="size-4" aria-hidden />
                            </button>
                            <span className="money w-10 text-center text-[1.0625rem]" aria-label={t('sell.qty')}>{l.quantity}</span>
                            <button
                              className="btn btn-sm"
                              aria-label={`${t('sell.qty')} +`}
                              // An approved price covers the quantity it was approved for; more needs a new approval.
                              disabled={Boolean(l.override?.quantity && toDec(l.quantity).gte(l.override.quantity))}
                              onClick={() => setQty(l.id, toDec(l.quantity).plus(1).toString())}
                            >
                              <Plus className="size-4" aria-hidden />
                            </button>
                          </>
                        ) : (
                          <input
                            aria-label={t('sell.qty')}
                            className="input money h-9 w-24 text-right"
                            inputMode="decimal"
                            defaultValue={l.quantity}
                            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (/^\d{1,6}(\.\d{1,4})?$/.test(v) && toDec(v).gt(0)) setQty(l.id, v);
                              // Refused: show the quantity the cart is priced at, not what was typed.
                              else e.target.value = l.quantity;
                            }}
                          />
                        )}
                        {salon && staff.length > 0 && (
                          <select
                            className="input h-9 w-auto max-w-[11rem] py-0 text-[0.875rem]"
                            aria-label={t('staff.forLine', { name: l.name })}
                            data-testid="line-staff"
                            value={l.staffId ?? ''}
                            onChange={(e) => patchLine(l.id, ({ staffId: _s, ...rest }) => (e.target.value ? { ...rest, staffId: e.target.value } : rest))}
                          >
                            <option value="">{t('staff.none')}</option>
                            {staffFor(l).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}
                          </select>
                        )}
                        {(() => {
                          const offer = packageFor(l);
                          return offer && (
                            <button type="button" className="btn btn-sm" data-testid="use-package" onClick={() => applyPackage(l.id, offer.pkg)}>
                              <Ticket className="size-4" aria-hidden /> {t('pkg.use', { n: offer.left })}
                            </button>
                          );
                        })()}
                        {/* Discounts and price changes need the server: not offered offline (ADR-0015 §1). A package session takes none. */}
                        {!l.statutory && !offline && !l.packageId && (
                          <button className="btn btn-sm" aria-pressed={isOpen(l.id, 'sc')} onClick={() => toggle(l.id, 'sc')}>
                            {t('sell.sc')}
                          </button>
                        )}
                        {canDiscount && !l.statutory && !offline && !l.packageId && (
                          <button className="btn btn-sm" aria-pressed={isOpen(l.id, 'discount')} onClick={() => toggle(l.id, 'discount')}>
                            {t('disc.button')}
                          </button>
                        )}
                        {!offline && !l.packageId && (
                          <button className="btn btn-sm" aria-pressed={isOpen(l.id, 'price')} onClick={() => (l.override ? setOverride(l.id, null) : toggle(l.id, 'price'))}>
                            {l.override ? t('price.undo') : t('price.button')}
                          </button>
                        )}
                        {counter?.items.get(l.variantId) && (
                          <button className="btn btn-sm" aria-label={t('counter.changeChoices', { name: l.name })} onClick={() => {
                            const menuItem = counter.items.get(l.variantId)!;
                            setChoosing({ item: { variantId: l.variantId, sku: l.sku, name: l.name, soldBy: 'UNIT', uom: { code: '', allowsFraction: !l.wholeUnits }, price: { amount: q?.unitPrice ?? '0' } }, menuItem, lineId: l.id });
                          }}>
                            <ChefHat className="size-4" aria-hidden /> {t('counter.choices')}
                          </button>
                        )}
                        {/* Kept apart from the other row controls: one mis-tap must not drop a line. */}
                        <button className="btn btn-sm btn-danger ml-3" aria-label={t('sell.remove')} onClick={() => remove(l.id)}>
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </div>
                      <div className="text-right">
                        <Money value={lineDue(l)} className="text-[1.0625rem] font-semibold" />
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
                        quantity={l.quantity}
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

        {hasKitchen && (
          <Note className="no-print grid gap-1 p-4">
            <Field id="pickupName" label={t('counter.pickupName')} hint={t('counter.pickupHint')} value={pickupName} maxLength={60} autoComplete="off" onChange={(e) => setPickupName(e.target.value)} />
          </Note>
        )}

        {packageNeedsCustomer && <Callout kind="warn">{t('pkg.needsCustomer')}</Callout>}
        {offline && appointment && <Callout kind="warn">{t('appt.offlineRingUp')}</Callout>}

        <PaymentPanel
          pay={pay}
          priced={cart.length > 0 && !!quote && !quoting}
          submitLabel={offline ? t('till.offlineSubmit') : exchange ? t('exch.complete') : t('pay.complete')}
          onSubmit={complete}
          canSubmit={cart.length > 0 && !packageNeedsCustomer && !(offline && (cart.some((l) => l.statutory || l.discount || l.override || l.packageId) || exchange || appointment))}
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
  choices?: string[];
  kitchenNote?: string;
  staffId?: string;
}

/** A refusal the till makes itself, before pricing (e.g. a discount while offline). */
class OfflineRefusal extends Error {}

/**
 * The till's offline pricing in the shape of the server's quote. Lines come back in cart order, each
 * item followed by its priced choices (`parentIndex`), which take the ids the online quote gives them.
 */
function offlineQuote(r: Awaited<ReturnType<OfflineEngine['quote']>>, cart: CartLine[]): Quote {
  // Walk the priced lines: an item moves to the next cart line, a priced choice to that line's next one.
  let k = -1;
  let m = 0;
  const owners = r.lines.map((_, i) => {
    if (r.parentIndex[i] === null) {
      k += 1;
      m = 0;
      return { line: cart[k]!, id: cart[k]!.id };
    }
    const line = cart[k]!;
    const priced = (line.choices ?? []).flatMap((c, n) => (c.variantId ? [n] : []));
    return { line, id: choiceLineId(line.id, priced[m++]!) };
  });
  return {
    taxProfile: { vatStatus: r.taxProfile.vatStatus, vatRate: r.taxProfile.vatRate },
    totals: r.totals,
    requiresProfessionalReview: false,
    lines: r.lines.map((l, i) => ({
      id: owners[i]!.id, variantId: r.items[i]!.variantId, sku: r.items[i]!.sku, name: r.items[i]!.name, unitPrice: r.items[i]!.unitPrice,
      quantity: owners[i]!.line.quantity, gross: l.gross, statutoryDiscount: l.statutoryDiscount, amountDue: l.amountDue, vatTreatment: r.items[i]!.vatTreatment,
      // Promotions run offline too, from the snapshot (ADR-0021).
      discount: l.discount, promotionId: r.promotions[i]!.promotionId, ...(r.promotionNames[i] && { promotionName: r.promotionNames[i]! }),
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
