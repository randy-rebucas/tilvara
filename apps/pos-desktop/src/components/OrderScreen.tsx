import { ArrowLeft, Minus, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useT, type MessageKey } from '../i18n';
import { api, uuid } from '../lib/api';
import type { BranchMenu, DiningArea, MenuItem, Order, OrderItem, OrderSummary, Quote } from '../types';
import { errorText, unanswered, type Notice } from './Payment';
import type { Shift } from './Registers';
import { usePoll } from '../lib/poll';
import { Callout, Field, Money, Note } from './ui';

interface Compose {
  item: MenuItem;
  chosen: string[];
  qty: number;
  course: number;
  /** Whose item it is at the table (for a split by seat); null = shared. */
  seat: number | null;
  note: string;
  /** One Idempotency-Key per composed item: a retry after a lost answer cannot add it twice. */
  key: string;
}
interface Diner {
  ref: string;
  scheme: 'SC' | 'PWD';
  name: string;
  idNumber: string;
}
type Place = { id: string; label: string };
type Panel =
  | { kind: 'void'; item: OrderItem; key: string }
  | { kind: 'transfer'; free: { id: string; code: string }[] }
  | { kind: 'merge'; orders: Place[] }
  | { kind: 'move'; orders: Place[]; free: { id: string; code: string }[]; chosen: string[] }
  | { kind: 'cancel' }
  | { kind: 'bill'; key: string }
  | null;

const LIVE = (i: { status: string }) => i.status !== 'VOIDED';

/**
 * One order: the published menu (with modifiers) on one side, the ticket on the other. Items are
 * added as PENDING, sent to the kitchen by course, served, voided (manager) and finally billed —
 * every step on the server, which also prices the subtotal.
 */
export function OrderScreen({ shift, orderId, permissions, active, onBack, onBill }: {
  shift: Shift;
  orderId: string;
  permissions: string[];
  active: boolean;
  onBack: () => void;
  onBill: (billId: string) => void;
}) {
  const { t } = useT();
  const can = (p: string) => permissions.includes(p);
  const [order, setOrder] = useState<Order | null>(null);
  const [menu, setMenu] = useState<BranchMenu['menu'] | undefined>(undefined);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [subtotal, setSubtotal] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);

  const load = useCallback(() => {
    api<Order>('GET', `/v1/restaurant/orders/${orderId}`)
      .then(setOrder)
      .catch((err) => setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) }));
  }, [orderId]);
  usePoll(load, 5000, active);

  const orderType = order?.orderType;
  useEffect(() => {
    if (!orderType) return;
    api<BranchMenu>('GET', `/v1/branches/${shift.branch.id}/menu?orderType=${orderType}`)
      .then(({ menu: m }) => {
        setMenu(m);
        setSectionId((s) => s ?? m?.sections[0]?.id ?? null);
      })
      .catch((err) => setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) }));
  }, [orderType, shift.branch.id]);

  // Server-priced subtotal of what is live on the order (before the service charge, which the bill adds).
  const liveKey = order ? JSON.stringify(order.items.filter(LIVE).map((i) => [i.id, i.quantity, i.modifiers.filter(LIVE).map((m) => m.id)])) : '';
  useEffect(() => {
    if (!order) return;
    const lines = order.items.filter(LIVE).flatMap((i) => [
      { id: i.id, variantId: i.variantId!, quantity: i.quantity },
      ...i.modifiers.filter((m) => LIVE(m) && m.variantId).map((m) => ({ id: m.id, variantId: m.variantId!, quantity: m.quantity })),
    ]);
    if (!lines.length) {
      setSubtotal(null);
      return;
    }
    let live = true;
    api<Quote>('POST', '/v1/tax/quote', { branchId: shift.branch.id, lines })
      .then((q) => live && setSubtotal(q.totals.amountDue))
      .catch(() => live && setSubtotal(null));
    return () => {
      live = false;
    };
  }, [liveKey, shift.branch.id]);

  /** Run one order action; the server answers with the order as it now is. */
  async function act(run: () => Promise<Order | null>, after?: () => void) {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    try {
      const next = await run();
      if (next) setOrder(next);
      setNotice(null);
      after?.();
    } catch (err) {
      setNotice({ kind: unanswered(err) ? 'warn' : 'error', text: errorText(err, t('common.error'), t('order.unconfirmed')) });
      if (!unanswered(err)) load();
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }

  function startCompose(item: MenuItem) {
    if (!item.available) return;
    setCompose({ item, chosen: [], qty: 1, course: 1, seat: null, note: '', key: uuid() });
  }

  function toggle(groupId: string, optionId: string) {
    setCompose((c) => {
      if (!c) return c;
      const group = c.item.modifierGroups.find((g) => g.id === groupId)!;
      const inGroup = c.chosen.filter((id) => group.options.some((o) => o.id === id));
      if (c.chosen.includes(optionId)) return { ...c, chosen: c.chosen.filter((id) => id !== optionId) };
      // A pick-one group swaps the choice; otherwise stop at the group's maximum.
      if (group.maxSelect === 1) return { ...c, chosen: [...c.chosen.filter((id) => !inGroup.includes(id)), optionId] };
      if (inGroup.length >= group.maxSelect) return c;
      return { ...c, chosen: [...c.chosen, optionId] };
    });
  }

  const missing = compose?.item.modifierGroups.filter((g) => compose.chosen.filter((id) => g.options.some((o) => o.id === id)).length < g.minSelect) ?? [];

  function addComposed() {
    if (!compose || missing.length) return;
    const c = compose;
    void act(async () => {
      try {
        return await api<Order>(
          'POST',
          `/v1/restaurant/orders/${orderId}/items`,
          { items: [{ variantId: c.item.variantId, quantity: String(c.qty), course: c.course, modifierOptionIds: c.chosen, ...(c.seat && { seat: c.seat }), ...(c.note.trim() && { note: c.note.trim() }) }] },
          { 'idempotency-key': c.key },
        );
      } catch (err) {
        // Refused (not unanswered): the next attempt is a new request.
        if (!unanswered(err)) setCompose((x) => (x ? { ...x, key: uuid() } : x));
        throw err;
      }
    }, () => setCompose(null));
  }

  const fire = (courses?: number[]) => act(() => api<Order>('POST', `/v1/restaurant/orders/${orderId}/fire`, courses ? { courses } : {}));
  const remove = (itemId: string) => act(() => api<Order>('POST', `/v1/order-items/${itemId}/remove`));
  const served = (itemId: string) => act(async () => (await api('POST', `/v1/order-items/${itemId}/status`, { status: 'SERVED' }), null), load);

  function voidItem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (panel?.kind !== 'void') return;
    const f = new FormData(e.currentTarget);
    const reason = String(f.get('reason') ?? '').trim();
    if (!reason) return;
    const p = panel;
    void act(() => api<Order>('POST', `/v1/order-items/${p.item.id}/void`, { reason, wasted: f.get('wasted') === 'on' }, { 'idempotency-key': p.key }), () => setPanel(null));
  }

  /** The floor right now: free tables, and the other open orders (by table code or name). */
  async function floorNow() {
    const [areas, live] = await Promise.all([
      api<{ data: DiningArea[] }>('GET', `/v1/dining-areas?branchId=${shift.branch.id}`),
      api<{ data: OrderSummary[] }>('GET', `/v1/restaurant/orders?branchId=${shift.branch.id}&status=LIVE`),
    ]);
    const tables = areas.data.flatMap((a) => a.tables);
    const taken = new Set(live.data.map((o) => o.tableId));
    const others = live.data
      .filter((o) => o.id !== orderId && o.status === 'OPEN')
      .map((o) => ({ id: o.id, label: `${o.tableId ? (tables.find((tb) => tb.id === o.tableId)?.code ?? '—') : (o.customerName ?? t('floor.takeaway'))} · #${o.orderNumber}` }));
    return { free: tables.filter((tb) => !taken.has(tb.id)), others };
  }

  async function openPanel(kind: 'transfer' | 'merge' | 'move') {
    try {
      const { free, others } = await floorNow();
      if (kind === 'transfer') setPanel({ kind, free });
      else if (kind === 'merge') setPanel({ kind, orders: others });
      else setPanel({ kind, orders: others, free, chosen: [] });
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
  }
  const openTransfer = () => openPanel('transfer');

  /** Merge this order into another open one (this one closes as MERGED); the floor shows the result. */
  const mergeInto = (intoOrderId: string) => act(async () => (await api('POST', `/v1/restaurant/orders/${orderId}/merge`, { intoOrderId }), null), onBack);

  /** Move the chosen items (with their choices) to another open order or a new order on a free table. */
  function moveTo(target: { toOrderId: string } | { toTableId: string }) {
    if (panel?.kind !== 'move' || panel.chosen.length === 0) return;
    const itemIds = panel.chosen;
    void act(async () => (await api<{ from: Order }>('POST', `/v1/restaurant/orders/${orderId}/move-items`, { itemIds, ...target })).from, () => setPanel(null));
  }

  function cancelOrder(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    if (reason) void act(async () => (await api('POST', `/v1/restaurant/orders/${orderId}/cancel`, { reason }), null), onBack);
  }

  if (!order) {
    return (
      <div className="px-6 py-8">
        {notice ? <Callout kind={notice.kind}>{notice.text}</Callout> : <p className="text-muted">{t('floor.loading')}</p>}
      </div>
    );
  }

  const closed = order.status === 'SETTLED' || order.status === 'CANCELLED' || order.status === 'MERGED';
  const billed = order.status === 'BILLED' && order.bill?.status === 'ACTIVE';
  const editable = order.status === 'OPEN';
  const pending = order.items.filter((i) => i.status === 'PENDING');
  const pendingCourses = [...new Set(pending.map((i) => i.course))].sort();
  const live = order.items.filter(LIVE);
  const section = menu?.sections.find((s) => s.id === sectionId) ?? menu?.sections[0];
  const title = order.table ? order.table.code : (order.customerName ?? t('floor.takeaway'));

  return (
    <div className="mx-auto grid max-w-[1440px] gap-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-sm" onClick={onBack} aria-label={t('order.backToFloor')}>
          <ArrowLeft className="size-4" aria-hidden /> {t('order.floor')}
        </button>
        <h1 className="text-[1.25rem] font-semibold">
          <span className="serial">{title}</span> <span className="serial text-[0.9375rem] text-muted">#{order.orderNumber}</span>
        </h1>
        {order.guestCount && <span className="text-muted">{t('floor.guestsNow', { n: String(order.guestCount) })}</span>}
        <span className={`tag ${billed ? 'tag-warn' : ''}`}>{t(`order.status.${order.status}` as MessageKey)}</span>
      </div>

      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}
      {closed && <Callout kind="info">{t('order.closed')}</Callout>}
      {billed && (
        <Callout kind="warn">
          <span className="flex flex-wrap items-center justify-between gap-3">
            {t('order.billedNotice', { n: String(order.bill!.billNumber) })}
            <button type="button" className="btn btn-primary" onClick={() => onBill(order.bill!.id)}>{t('order.toBill')}</button>
          </span>
        </Callout>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_440px]">
        {/* Menu */}
        <div className="grid content-start gap-3">
          {editable && menu === null && <Callout kind="warn">{t('order.noMenu')}</Callout>}
          {editable && menu && (
            <>
              <nav className="flex flex-wrap gap-1" aria-label={t('order.sections')}>
                {menu.sections.map((s) => (
                  <button key={s.id} type="button" className="btn btn-sm" aria-pressed={s.id === section?.id} onClick={() => setSectionId(s.id)}>
                    {s.name}
                  </button>
                ))}
              </nav>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2" aria-label={section?.name}>
                {section?.items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      disabled={!it.available}
                      aria-pressed={compose?.item.id === it.id}
                      className="note grid min-h-[88px] w-full content-between gap-1 p-3 pr-5 text-left disabled:opacity-55"
                      onClick={() => startCompose(it)}
                    >
                      <span className="font-semibold leading-snug">{it.name}</span>
                      {it.soldOut ? <span className="tag tag-bad justify-self-start">{t('order.soldOut')}</span> : it.price ? <Money value={it.price} className="text-muted" /> : <span className="text-[0.8125rem] text-muted">{t('order.unpriced')}</span>}
                      <span aria-hidden className="denom bg-blue" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {compose && (
            <Note denom="blue" className="grid gap-4 p-5" aria-label={compose.item.name}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[1.125rem] font-semibold">{compose.item.name}</h2>
                {compose.item.price && <Money value={compose.item.price} />}
              </div>
              {compose.item.modifierGroups.map((g) => (
                <fieldset key={g.id} className="grid gap-2">
                  <legend className="mb-1 text-[0.875rem] font-semibold">
                    {g.name}{' '}
                    <span className="font-normal text-muted">
                      {g.minSelect > 0 ? t(g.maxSelect === 1 ? 'order.pickOne' : 'order.pickAtLeast', { n: String(g.minSelect) }) : t('order.upTo', { n: String(g.maxSelect) })}
                    </span>
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {g.options.map((o) => (
                      <button key={o.id} type="button" className="btn btn-sm" disabled={!o.available} aria-pressed={compose.chosen.includes(o.id)} onClick={() => toggle(g.id, o.id)}>
                        {o.name}
                        {o.price && o.price !== '0' && <span className="money text-muted">+<Money value={o.price} /></span>}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ))}
              <div className="flex flex-wrap items-end gap-4">
                <div className="grid gap-1">
                  <span className="text-[0.8125rem] font-semibold">{t('sell.qty')}</span>
                  <div className="flex items-center gap-1">
                    <button type="button" className="btn btn-sm" aria-label={`${t('sell.qty')} −`} disabled={compose.qty <= 1} onClick={() => setCompose({ ...compose, qty: compose.qty - 1 })}>
                      <Minus className="size-4" aria-hidden />
                    </button>
                    <span className="money w-10 text-center text-[1.0625rem]" aria-live="polite">{compose.qty}</span>
                    <button type="button" className="btn btn-sm" aria-label={`${t('sell.qty')} +`} disabled={compose.qty >= 99} onClick={() => setCompose({ ...compose, qty: compose.qty + 1 })}>
                      <Plus className="size-4" aria-hidden />
                    </button>
                  </div>
                </div>
                <div className="grid gap-1" role="group" aria-label={t('order.course')}>
                  <span className="text-[0.8125rem] font-semibold">{t('order.course')}</span>
                  <div className="flex gap-1">
                    {[1, 2, 3].map((n) => (
                      <button key={n} type="button" className="btn btn-sm" aria-pressed={compose.course === n} onClick={() => setCompose({ ...compose, course: n })}>
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                {order.orderType === 'DINE_IN' && (
                  <div className="grid gap-1" role="group" aria-label={t('order.seat')}>
                    <span className="text-[0.8125rem] font-semibold">{t('order.seat')}</span>
                    <div className="flex flex-wrap gap-1">
                      <button type="button" className="btn btn-sm" aria-pressed={compose.seat === null} onClick={() => setCompose({ ...compose, seat: null })}>{t('order.seatShared')}</button>
                      {Array.from({ length: Math.min(Math.max(order.guestCount ?? 4, 1), 12) }, (_, i) => i + 1).map((n) => (
                        <button key={n} type="button" className="btn btn-sm" aria-label={t('kds.seat', { n: String(n) })} aria-pressed={compose.seat === n} onClick={() => setCompose({ ...compose, seat: n })}>
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <Field id="itemNote" label={t('order.note')} value={compose.note} maxLength={200} onChange={(e) => setCompose({ ...compose, note: e.target.value })} />
              {missing.length > 0 && <p className="text-[0.875rem] text-muted">{t('order.chooseFirst', { groups: missing.map((g) => g.name).join(', ') })}</p>}
              <div className="flex gap-2">
                <button type="button" className="btn btn-primary flex-1" disabled={missing.length > 0 || working} onClick={addComposed}>{t('order.addToOrder')}</button>
                <button type="button" className="btn" onClick={() => setCompose(null)}>{t('common.cancel')}</button>
              </div>
            </Note>
          )}
        </div>

        {/* Ticket */}
        <aside className="grid content-start gap-4" aria-label={t('order.ticket')}>
          <Note className="p-2">
            {order.items.length === 0 ? (
              <p className="grid min-h-[160px] place-items-center px-4 text-center text-muted">{t('order.empty')}</p>
            ) : (
              <ul aria-label={t('order.ticket')}>
                {order.items.map((i) => (
                  <TicketRow
                    key={i.id}
                    item={i}
                    canVoid={can('sales.void') && !billed && !closed}
                    canServe={!closed}
                    working={working}
                    onRemove={() => remove(i.id)}
                    onServed={() => served(i.id)}
                    onVoid={() => setPanel({ kind: 'void', item: i, key: uuid() })}
                  />
                ))}
              </ul>
            )}
          </Note>

          {panel?.kind === 'void' && (
            <Note className="p-4">
              <form className="grid gap-3" onSubmit={voidItem}>
                <p className="font-semibold">{t('order.voidTitle', { name: panel.item.name })}</p>
                <Field id="voidReason" name="reason" required maxLength={200} label={t('history.reason')} autoFocus />
                <label className="flex min-h-12 items-center gap-3">
                  <input type="checkbox" name="wasted" className="size-5" defaultChecked={panel.item.status !== 'FIRED'} />
                  <span>{t('order.wasted')}</span>
                </label>
                <div className="flex gap-2">
                  <button className="btn btn-danger" disabled={working}>{t('order.void')}</button>
                  <button type="button" className="btn" onClick={() => setPanel(null)}>{t('common.cancel')}</button>
                </div>
              </form>
            </Note>
          )}

          <Note className="grid gap-3 p-5">
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-muted">{t('order.subtotal')}</span>
              <Money value={subtotal ?? (live.length ? null : '0.00')} className="text-[1.75rem] font-semibold" />
            </p>
            {order.orderType === 'DINE_IN' && live.length > 0 && <p className="text-[0.8125rem] text-muted">{t('order.subtotalHint')}</p>}

            {editable && pending.length > 0 && (
              <div className="grid gap-2">
                {pendingCourses.length > 1 &&
                  pendingCourses.map((c) => (
                    <button key={c} type="button" className="btn" disabled={working} onClick={() => fire([c])}>
                      {t('order.sendCourse', { n: String(c) })}
                    </button>
                  ))}
                <button type="button" className="btn btn-primary" disabled={working} onClick={() => fire()}>
                  {t('order.sendAll', { n: String(pending.length) })}
                </button>
              </div>
            )}
            {editable && (
              <button type="button" className="btn btn-primary min-h-14 text-[1.0625rem]" disabled={working || pending.length > 0 || live.length === 0} onClick={() => setPanel({ kind: 'bill', key: uuid() })}>
                {t('order.bill')}
              </button>
            )}
            {editable && pending.length > 0 && live.length > 0 && <p className="text-[0.8125rem] text-muted">{t('order.sendBeforeBill')}</p>}
            {editable && (
              <div className="flex flex-wrap gap-2">
                {order.orderType === 'DINE_IN' && <button type="button" className="btn btn-sm" onClick={() => void openTransfer()}>{t('order.transfer')}</button>}
                {live.length > 0 && <button type="button" className="btn btn-sm" onClick={() => void openPanel('move')}>{t('order.moveItems')}</button>}
                <button type="button" className="btn btn-sm" onClick={() => void openPanel('merge')}>{t('order.merge')}</button>
                <button type="button" className="btn btn-sm btn-danger ml-auto" onClick={() => setPanel({ kind: 'cancel' })}>{t('order.cancel')}</button>
              </div>
            )}
          </Note>

          {panel?.kind === 'bill' && (
            <BillPrep order={order} permissions={permissions} working={working} onCancel={() => setPanel(null)} onBill={(body) => {
              const p = panel;
              void act(async () => {
                const bill = await api<{ id: string }>('POST', `/v1/restaurant/orders/${orderId}/bill`, body, { 'idempotency-key': p.key });
                onBill(bill.id);
                return null;
              });
            }} />
          )}

          {panel?.kind === 'transfer' && (
            <Note denom="violet" className="grid gap-3 p-4">
              <p className="font-semibold">{t('order.transferTo')}</p>
              {panel.free.length === 0 ? (
                <p className="text-muted">{t('order.noFreeTables')}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {panel.free.map((tb) => (
                    <button key={tb.id} type="button" className="btn serial" disabled={working} onClick={() => void act(() => api<Order>('POST', `/v1/restaurant/orders/${orderId}/transfer`, { tableId: tb.id }), () => setPanel(null))}>
                      {tb.code}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" className="btn justify-self-start" onClick={() => setPanel(null)}>{t('common.cancel')}</button>
            </Note>
          )}

          {panel?.kind === 'merge' && (
            <Note className="grid gap-3 p-4">
              <p className="font-semibold">{t('order.mergeInto')}</p>
              <p className="text-[0.875rem] text-muted">{t('order.mergeHint')}</p>
              {panel.orders.length === 0 ? (
                <p className="text-muted">{t('order.noOtherOrders')}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {panel.orders.map((o) => (
                    <button key={o.id} type="button" className="btn serial" disabled={working} onClick={() => void mergeInto(o.id)}>{o.label}</button>
                  ))}
                </div>
              )}
              <button type="button" className="btn justify-self-start" onClick={() => setPanel(null)}>{t('common.cancel')}</button>
            </Note>
          )}

          {panel?.kind === 'move' && (
            <Note className="grid gap-3 p-4">
              <p className="font-semibold">{t('order.moveTitle')}</p>
              <fieldset className="grid gap-1">
                <legend className="sr-only">{t('order.moveWhich')}</legend>
                {live.map((i) => (
                  <label key={i.id} className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      className="size-5"
                      checked={panel.chosen.includes(i.id)}
                      onChange={(e) => setPanel({ ...panel, chosen: e.target.checked ? [...panel.chosen, i.id] : panel.chosen.filter((x) => x !== i.id) })}
                    />
                    <span><span className="money">{i.quantity}×</span> {i.name}{i.seat ? <span className="serial ml-2 text-[0.8125rem] text-muted">{t('kds.seat', { n: String(i.seat) })}</span> : null}</span>
                  </label>
                ))}
              </fieldset>
              {panel.chosen.length > 0 && (
                <>
                  <p className="text-[0.875rem] font-semibold">{t('order.moveToOrder')}</p>
                  <div className="flex flex-wrap gap-2">
                    {panel.orders.map((o) => <button key={o.id} type="button" className="btn serial" disabled={working} onClick={() => moveTo({ toOrderId: o.id })}>{o.label}</button>)}
                    {panel.orders.length === 0 && <span className="text-muted">{t('order.noOtherOrders')}</span>}
                  </div>
                  <p className="text-[0.875rem] font-semibold">{t('order.moveToTable')}</p>
                  <div className="flex flex-wrap gap-2">
                    {panel.free.map((tb) => <button key={tb.id} type="button" className="btn serial" disabled={working} onClick={() => moveTo({ toTableId: tb.id })}>{tb.code}</button>)}
                    {panel.free.length === 0 && <span className="text-muted">{t('order.noFreeTables')}</span>}
                  </div>
                </>
              )}
              <button type="button" className="btn justify-self-start" onClick={() => setPanel(null)}>{t('common.cancel')}</button>
            </Note>
          )}

          {panel?.kind === 'cancel' && (
            <Note className="p-4">
              <form className="grid gap-3" onSubmit={cancelOrder}>
                <p className="font-semibold">{t('order.cancelTitle')}</p>
                <p className="text-[0.875rem] text-muted">{t('order.cancelHint')}</p>
                <Field id="cancelReason" name="reason" required maxLength={200} label={t('history.reason')} autoFocus />
                <div className="flex gap-2">
                  <button className="btn btn-danger" disabled={working}>{t('order.cancel')}</button>
                  <button type="button" className="btn" onClick={() => setPanel(null)}>{t('common.back')}</button>
                </div>
              </form>
            </Note>
          )}
        </aside>
      </div>
    </div>
  );
}

const STATUS_TONE: Partial<Record<OrderItem['status'], string>> = { READY: 'tag-warn', VOIDED: 'tag-bad' };

function TicketRow({ item: i, canVoid, canServe, working, onRemove, onServed, onVoid }: {
  item: OrderItem;
  canVoid: boolean;
  canServe: boolean;
  working: boolean;
  onRemove: () => void;
  onServed: () => void;
  onVoid: () => void;
}) {
  const { t } = useT();
  const voided = i.status === 'VOIDED';
  const cooking = i.status === 'FIRED' || i.status === 'IN_PREP' || i.status === 'READY';
  return (
    <li className="row-rule px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className={`font-semibold ${voided ? 'text-muted line-through' : ''}`}>
            <span className="money">{i.quantity}×</span> {i.name}
          </p>
          {i.modifiers.length > 0 && <p className="text-[0.875rem] text-muted">{i.modifiers.map((m) => m.name).join(' · ')}</p>}
          {i.note && <p className="text-[0.875rem] italic text-muted">“{i.note}”</p>}
          <p className="mt-1 flex flex-wrap items-center gap-1">
            <span className={`tag ${STATUS_TONE[i.status] ?? ''}`}>{t(`item.status.${i.status}` as MessageKey)}</span>
            {i.course > 1 && <span className="tag">{t('order.courseN', { n: String(i.course) })}</span>}
            {i.seat && <span className="tag">{t('kds.seat', { n: String(i.seat) })}</span>}
            {voided && i.voidReason && <span className="text-[0.8125rem] text-muted">{i.voidReason}{i.wasteAdjustmentId ? ` · ${t('order.wastedShort')}` : ''}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {cooking && canServe && <button type="button" className="btn btn-sm" disabled={working} onClick={onServed}>{t('order.served')}</button>}
          {!voided && i.status !== 'PENDING' && canVoid && <button type="button" className="btn btn-sm btn-danger" disabled={working} onClick={onVoid}>{t('order.void')}</button>}
          {i.status === 'PENDING' && (
            <button type="button" className="btn btn-sm btn-danger" aria-label={t('sell.remove')} disabled={working} onClick={onRemove}>
              <Trash2 className="size-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** Before the bill is printed: SC/PWD diners and the items for their own use, and an order discount. */
function BillPrep({ order, permissions, working, onCancel, onBill }: {
  order: Order;
  permissions: string[];
  working: boolean;
  onCancel: () => void;
  onBill: (body: Record<string, unknown>) => void;
}) {
  const { t } = useT();
  const [diners, setDiners] = useState<Diner[]>([]);
  const [assigned, setAssigned] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [discount, setDiscount] = useState('');
  const live = order.items.filter(LIVE);

  function addDiner(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    const idNumber = String(f.get('idNumber') ?? '').trim();
    if (!name || !idNumber) return;
    setDiners((d) => [...d, { ref: `d${d.length + 1}`, scheme: f.get('scheme') === 'PWD' ? 'PWD' : 'SC', name, idNumber }]);
    setAdding(false);
  }

  const pct = discount.trim();
  const validPct = pct === '' || (/^\d{1,2}(\.\d{1,2})?$/.test(pct) && Number(pct) > 0);
  // A percentage the server turns into its rate: "10" → "0.1" (string arithmetic only, no floats).
  const rate = pct === '' || !validPct ? undefined : (() => {
    const [w, f = ''] = pct.split('.');
    return `0.${w!.padStart(2, '0')}${f}`.replace(/0+$/, '').replace(/\.$/, '');
  })();
  const used = new Set(Object.values(assigned));

  function submit() {
    const statutory = Object.entries(assigned).filter(([, ref]) => ref).map(([orderItemId, beneficiary]) => ({ orderItemId, beneficiary }));
    onBill({
      beneficiaries: diners.filter((d) => used.has(d.ref)).map((d) => ({ ref: d.ref, scheme: d.scheme, name: d.name, idNumber: d.idNumber })),
      statutory,
      ...(rate && { discountRate: rate }),
    });
  }

  return (
    <Note className="grid gap-4 p-5">
      <h2 className="text-[1.0625rem] font-semibold">{t('bill.prepTitle')}</h2>
      <div className="grid gap-2">
        <p className="text-[0.875rem] text-muted">{t('bill.scHint')}</p>
        {diners.map((d) => (
          <p key={d.ref} className="flex flex-wrap items-center gap-2 text-[0.9375rem]">
            <span className="chip bg-blue">{d.scheme}</span> {d.name} <span className="serial text-[0.8125rem] text-muted">{d.idNumber}</span>
          </p>
        ))}
        {adding ? (
          <form className="grid gap-3 rounded-[5px] border border-hair bg-white p-4" onSubmit={addDiner}>
            <div className="grid gap-3 sm:grid-cols-[110px_1fr_1fr]">
              <div className="field">
                <label htmlFor="dinerScheme">{t('sell.scheme')}</label>
                <select id="dinerScheme" name="scheme" className="input">
                  <option value="SC">SC</option>
                  <option value="PWD">PWD</option>
                </select>
              </div>
              <Field id="dinerName" name="name" required label={t('sell.beneficiaryName')} autoFocus />
              <Field id="dinerId" name="idNumber" required label={t('sell.idNumber')} />
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary">{t('sell.apply')}</button>
              <button type="button" className="btn" onClick={() => setAdding(false)}>{t('common.cancel')}</button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn btn-sm justify-self-start" onClick={() => setAdding(true)}>{t('bill.addDiner')}</button>
        )}
        {diners.length > 0 && (
          <ul className="grid gap-1">
            {live.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={`own-${i.id}`}>{i.quantity}× {i.name}</label>
                <select id={`own-${i.id}`} className="input h-12 w-auto" value={assigned[i.id] ?? ''} onChange={(e) => setAssigned((a) => ({ ...a, [i.id]: e.target.value }))}>
                  <option value="">{t('bill.regular')}</option>
                  {diners.map((d) => (
                    <option key={d.ref} value={d.ref}>{`${d.scheme} · ${d.name}`}</option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </div>
      {permissions.includes('sales.discount') && (
        <Field id="discountPct" label={t('bill.discount')} hint={t('bill.discountHint')} inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} error={validPct ? undefined : t('bill.discountInvalid')} placeholder="0" />
      )}
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary flex-1" disabled={working || !validPct} onClick={submit}>{t('bill.print')}</button>
        <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </Note>
  );
}
