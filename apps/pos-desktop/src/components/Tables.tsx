import { ShoppingBag } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api } from '../lib/api';
import { usePoll } from '../lib/poll';
import type { DiningArea, OrderSummary } from '../types';
import { BillScreen } from './BillScreen';
import { OrderScreen } from './OrderScreen';
import { errorText, type Notice } from './Payment';
import type { Shift } from './Registers';
import { Callout, Field, Note } from './ui';

type View = { name: 'floor' } | { name: 'order'; orderId: string } | { name: 'bill'; orderId: string; billId: string };

/** Table service (ADR-0014): floor → order → bill → checks, all on the server; this tab only shows and asks. */
export function Tables({ shift, permissions, active }: { shift: Shift; permissions: string[]; active: boolean }) {
  const [view, setView] = useState<View>({ name: 'floor' });
  if (view.name === 'order') {
    return (
      <OrderScreen
        shift={shift}
        orderId={view.orderId}
        permissions={permissions}
        active={active}
        onBack={() => setView({ name: 'floor' })}
        onBill={(billId) => setView({ name: 'bill', orderId: view.orderId, billId })}
      />
    );
  }
  if (view.name === 'bill') {
    return <BillScreen shift={shift} billId={view.billId} onBack={() => setView({ name: 'order', orderId: view.orderId })} onDone={() => setView({ name: 'floor' })} />;
  }
  return <Floor shift={shift} active={active} onOpen={(orderId) => setView({ name: 'order', orderId })} />;
}

function Floor({ shift, active, onOpen }: { shift: Shift; active: boolean; onOpen: (orderId: string) => void }) {
  const { t } = useT();
  const [areas, setAreas] = useState<DiningArea[] | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [opening, setOpening] = useState<{ tableId: string; code: string } | 'TAKEAWAY' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ data: DiningArea[] }>('GET', `/v1/dining-areas?branchId=${shift.branch.id}`)
      .then(({ data }) => {
        setAreas(data);
        setAreaId((a) => a ?? data[0]?.id ?? null);
      })
      .catch((err) => setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) }));
  }, [shift.branch.id]);

  const loadOrders = useCallback(() => {
    api<{ data: OrderSummary[] }>('GET', `/v1/restaurant/orders?branchId=${shift.branch.id}&status=LIVE`)
      .then(({ data }) => setOrders(data))
      .catch(() => undefined); // the next poll retries; the floor keeps what it last showed
  }, [shift.branch.id]);
  usePoll(loadOrders, 8000, active);

  async function open(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!opening || busy) return;
    const f = new FormData(e.currentTarget);
    const guests = String(f.get('guests') ?? '').trim();
    const name = String(f.get('customerName') ?? '').trim();
    setBusy(true);
    try {
      const body =
        opening === 'TAKEAWAY'
          ? { branchId: shift.branch.id, orderType: 'TAKEAWAY', ...(name && { customerName: name }) }
          : { branchId: shift.branch.id, orderType: 'DINE_IN', tableId: opening.tableId, ...(/^\d{1,3}$/.test(guests) && Number(guests) > 0 && { guestCount: Number(guests) }) };
      const order = await api<{ id: string }>('POST', '/v1/restaurant/orders', body);
      setOpening(null);
      onOpen(order.id);
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
      loadOrders();
    } finally {
      setBusy(false);
    }
  }

  if (areas === null) return <p className="px-6 py-8 text-muted">{notice ? notice.text : t('floor.loading')}</p>;

  const area = areas.find((a) => a.id === areaId) ?? areas[0];
  const byTable = new Map(orders.filter((o) => o.tableId).map((o) => [o.tableId!, o]));
  const takeaway = orders.filter((o) => o.orderType === 'TAKEAWAY');

  return (
    <div className="mx-auto grid max-w-[1440px] gap-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        {areas.length > 1 && (
          <nav className="flex flex-wrap gap-1" aria-label={t('floor.areas')}>
            {areas.map((a) => (
              <button key={a.id} type="button" className="btn btn-sm" aria-current={a.id === area?.id ? 'page' : undefined} aria-pressed={a.id === area?.id} onClick={() => setAreaId(a.id)}>
                {a.name}
              </button>
            ))}
          </nav>
        )}
        {areas.length === 1 && <h1 className="section-title">{area!.name}</h1>}
        <div className="flex-1" />
        <button type="button" className="btn" onClick={() => setOpening('TAKEAWAY')}>
          <ShoppingBag className="size-4" aria-hidden /> {t('floor.takeaway')}
        </button>
      </div>

      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}

      {opening && (
        <Note denom="violet" className="p-4">
          <form className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={open}>
            {opening === 'TAKEAWAY' ? (
              <Field id="customerName" name="customerName" label={t('floor.customerName')} hint={t('floor.customerHint')} autoFocus maxLength={100} />
            ) : (
              <Field id="guests" name="guests" label={t('floor.guests', { table: opening.code })} inputMode="numeric" autoFocus placeholder="2" />
            )}
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={busy}>{opening === 'TAKEAWAY' ? t('floor.startTakeaway') : t('floor.openTable')}</button>
              <button type="button" className="btn" onClick={() => setOpening(null)}>{t('common.cancel')}</button>
            </div>
          </form>
        </Note>
      )}

      {!area ? (
        <Note className="p-6">
          <p className="text-muted">{t('floor.noTables')}</p>
        </Note>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3" aria-label={t('floor.tables')}>
          {area.tables.map((tb) => {
            const o = byTable.get(tb.id);
            return (
              <li key={tb.id}>
                <button
                  type="button"
                  className="note grid min-h-[128px] w-full content-start gap-1 p-4 pr-6 text-left hover:border-[#b6ae98]"
                  onClick={() => (o ? onOpen(o.id) : setOpening({ tableId: tb.id, code: tb.code }))}
                  aria-label={`${tb.code} — ${o ? t(o.status === 'BILLED' ? 'floor.billed' : 'floor.open', { n: String(o.orderNumber) }) : t('floor.free')}`}
                >
                  <span className="serial text-[1.5rem] font-bold leading-tight">{tb.code}</span>
                  <span className="text-[0.8125rem] text-muted">
                    {o?.guestCount ? t('floor.guestsNow', { n: String(o.guestCount) }) : t('floor.seats', { n: String(tb.seats) })}
                  </span>
                  {o ? <OrderBadges o={o} /> : <span className="text-[0.875rem] text-muted">{t('floor.free')}</span>}
                  <span aria-hidden className="denom bg-violet" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {takeaway.length > 0 && (
        <Note className="p-4">
          <h2 className="section-title mb-2">{t('floor.takeawayOrders')}</h2>
          <ul className="grid gap-1">
            {takeaway.map((o) => (
              <li key={o.id} className="row-rule">
                <button type="button" className="flex min-h-12 w-full flex-wrap items-center gap-3 px-2 text-left hover:bg-paper" onClick={() => onOpen(o.id)}>
                  <span className="serial font-semibold">#{o.orderNumber}</span>
                  <span className="flex-1">{o.customerName ?? t('floor.takeaway')}</span>
                  <OrderBadges o={o} numbered={false} />
                </button>
              </li>
            ))}
          </ul>
        </Note>
      )}
    </div>
  );
}

/** What a live order needs: still to send, ready to serve, or billed and waiting to pay. */
function OrderBadges({ o, numbered = true }: { o: OrderSummary; numbered?: boolean }) {
  const { t } = useT();
  const pending = o.items.PENDING ?? 0;
  const ready = o.items.READY ?? 0;
  const status = numbered ? t(o.status === 'BILLED' ? 'floor.billed' : 'floor.open', { n: String(o.orderNumber) }) : t(o.status === 'BILLED' ? 'order.status.BILLED' : 'order.status.OPEN');
  return (
    <span className="flex flex-wrap gap-1">
      <span className={`tag ${o.status === 'BILLED' ? 'tag-warn' : ''}`}>{status}</span>
      {pending > 0 && <span className="tag">{t('floor.toSend', { n: String(pending) })}</span>}
      {ready > 0 && <span className="tag tag-warn">{t('floor.ready', { n: String(ready) })}</span>}
    </span>
  );
}
