import { CreditCard, LogIn, LogOut, Printer, QrCode, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useT, type MessageKey } from '../i18n';
import { api, ApiFailure, uuid } from '../lib/api';
import { addDays, dateLabel } from '../lib/calendar';
import { gte, isPositive, isZero, parseAmount, peso, quickTenders, sub } from '../lib/money';
import { statementToPrintable } from '../lib/printing';
import { useTill } from '../lib/till';
import type { BoardRoom, Folio, FolioStatement, Housekeeping, HousekeepingStatus, PaymentIntent, Stay } from '../types';
import { errorText, unanswered, type Notice } from './Payment';
import type { Shift } from './Registers';
import { Callout, Empty, Field, Money, Note, PaymentTag } from './ui';

const STATUSES: HousekeepingStatus[] = ['CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER'];
const ready = (s: HousekeepingStatus) => s === 'CLEAN' || s === 'INSPECTED';

/** What the server's refusals mean at the front desk (the server's own message otherwise). */
const DESK_ERRORS: Record<string, MessageKey> = {
  ROOM_DOUBLE_BOOKED: 'rooms.err.doubleBooked',
  ROOM_OUT_OF_ORDER: 'rooms.err.outOfOrder',
  ROOM_NOT_READY: 'rooms.err.notReady',
  OVER_OCCUPANCY: 'rooms.err.overOccupancy',
  GUEST_REGISTRY_REQUIRED: 'rooms.err.registry',
  TOO_EARLY: 'rooms.err.tooEarly',
  FOLIO_BALANCE_DUE: 'rooms.err.balanceDue',
  DEPOSIT_HELD: 'rooms.err.depositHeld',
  SESSION_NOT_OPEN: 'rooms.err.sessionNotOpen',
  INSUFFICIENT_STORE_CREDIT: 'rooms.err.storeCredit',
  STORE_CREDIT_NEEDS_CUSTOMER: 'rooms.err.storeCreditCustomer',
  NOTHING_TO_PAY: 'rooms.err.nothingToPay',
};

const deskError = (err: unknown, t: (k: MessageKey, v?: Record<string, string>) => string) => {
  const code = err instanceof ApiFailure ? err.error.code : '';
  return DESK_ERRORS[code] ? t(DESK_ERRORS[code]!) : errorText(err, t('common.error'), t('common.network'));
};

/**
 * One Idempotency-Key per attempt at a front-desk write: kept when no answer came back (a retry cannot
 * take the money or check in twice), new after an answer, either way (ADR-0009 failure semantics).
 */
function useAttemptKey() {
  const key = useRef(uuid());
  return {
    get: () => key.current,
    settle: (err?: unknown) => {
      if (!err || !unanswered(err)) key.current = uuid();
    },
  };
}

/**
 * The front desk at the counter (ADR-0023): the rooms of the shift's branch with their housekeeping
 * status and who is in each, today's arrivals and departures; walk-in check-in with the guest
 * registry, check-in of a booking, the folio, cash deposits at this drawer, check-out with payment at
 * this drawer, and the statement. Online only: the server keeps the stays and folios.
 */
export function Rooms({ shift, permissions, active }: { shift: Shift; permissions: string[]; active: boolean }) {
  const { t } = useT();
  const till = useTill();
  const offline = till.mode === 'ready' && !till.online;
  const [board, setBoard] = useState<Housekeeping | null>(null);
  const [inHouse, setInHouse] = useState<Stay[]>([]);
  const [arrivals, setArrivals] = useState<Stay[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const branchId = shift.branch.id;

  async function load() {
    try {
      const hk = await api<Housekeeping>('GET', `/v1/lodging/housekeeping?branchId=${branchId}`);
      const day = hk.day;
      const staying = await api<{ data: Stay[] }>('GET', `/v1/stays?branchId=${branchId}&status=IN_HOUSE&limit=200`);
      // Booked stays that cover today: arriving today, or due and not yet come.
      const booked = day ? await api<{ data: Stay[] }>('GET', `/v1/stays?branchId=${branchId}&status=BOOKED&from=${day}&to=${addDays(day, 1)}&limit=200`) : { data: [] };
      setBoard(hk);
      setInHouse(staying.data);
      setArrivals(booked.data);
      setNotice((n) => (n?.kind === 'error' ? null : n));
    } catch (err) {
      if (unanswered(err)) till.reportUnreachable();
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
  }

  // Re-read on opening the tab and every minute while open (housekeeping and the desk change rooms too).
  useEffect(() => {
    if (!active || offline) return;
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [active, offline, branchId]);

  if (offline) {
    return (
      <div className="mx-auto grid max-w-[1440px] gap-4 px-4 py-5 sm:px-6">
        <h1 className="text-[1.5rem] font-bold">{t('nav.rooms')}</h1>
        <div data-testid="rooms-offline"><Callout kind="warn">{t('rooms.offline')}</Callout></div>
      </div>
    );
  }

  const rooms = board?.data ?? [];
  const day = board?.day ?? null;
  const stayIn = (roomId: string) => inHouse.find((s) => s.roomId === roomId) ?? null;
  const arrivalFor = (roomId: string) => arrivals.find((s) => s.roomId === roomId) ?? null;
  const selected = rooms.find((r) => r.roomId === selectedId) ?? null;
  const count = (f: (r: BoardRoom) => boolean) => rooms.filter(f).length;
  const summary: [MessageKey, number][] = [
    ['rooms.sum.inHouse', count((r) => r.occupied)],
    ['rooms.sum.arrivals', arrivals.length],
    ['rooms.sum.departures', count((r) => r.departingToday)],
    ['rooms.sum.vacantReady', count((r) => !r.occupied && ready(r.status))],
    ['rooms.sum.dirty', count((r) => r.status === 'DIRTY')],
    ['rooms.sum.outOfOrder', count((r) => r.status === 'OUT_OF_ORDER')],
  ];

  return (
    <div className="mx-auto grid max-w-[1440px] gap-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="mr-auto text-[1.5rem] font-bold">{t('nav.rooms')}</h1>
        {day && <p className="serial text-[0.8125rem] text-muted" data-testid="rooms-day">{dateLabel(day)}</p>}
      </div>
      <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="rooms-summary">
        {summary.map(([k, n]) => (
          <div key={k} className="rounded-[5px] border border-hair bg-white px-3 py-2">
            <dt className="text-[0.75rem] text-muted">{t(k)}</dt>
            <dd className="money text-[1.25rem] font-semibold">{n}</dd>
          </div>
        ))}
      </dl>

      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}

      {selected && day && (
        <RoomPanel
          key={selected.roomId}
          room={selected}
          day={day}
          stay={stayIn(selected.roomId)}
          arrival={arrivalFor(selected.roomId)}
          shift={shift}
          permissions={permissions}
          onChanged={(text) => { setNotice(text ? { kind: 'info', text } : null); void load(); }}
          onClose={() => setSelectedId(null)}
        />
      )}

      {board === null ? null : rooms.length === 0 ? (
        <Note><Empty>{t('rooms.none')}</Empty></Note>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="room-board">
          {rooms.map((r) => {
            const s = stayIn(r.roomId);
            const a = arrivalFor(r.roomId);
            return (
              <li key={r.roomId}>
                <button
                  type="button"
                  data-testid="room-card"
                  data-room={r.number}
                  data-status={r.status}
                  aria-pressed={selectedId === r.roomId}
                  onClick={() => setSelectedId(selectedId === r.roomId ? null : r.roomId)}
                  className={`grid h-full w-full content-start gap-1 rounded-[6px] border bg-white p-3 text-left hover:border-blue ${selectedId === r.roomId ? 'border-blue ring-2 ring-blue' : 'border-hair'} ${r.status === 'OUT_OF_ORDER' ? 'opacity-70' : ''}`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="money text-[1.375rem] font-bold leading-none">{r.number}</span>
                    <StatusTag status={r.status} />
                  </span>
                  <span className="truncate text-[0.8125rem] text-muted">{r.roomType.name}{r.floor ? ` · ${t('rooms.floor', { floor: r.floor })}` : ''}</span>
                  <span className={`truncate text-[0.9375rem] ${s ? 'font-semibold' : 'text-muted'}`}>{s ? s.guestDisplayName : t('rooms.vacant')}</span>
                  <span className="flex flex-wrap gap-1">
                    {r.departingToday && <span className="tag tag-warn">{t(r.overstay ? 'rooms.overstay' : 'rooms.departsToday')}</span>}
                    {a && <span className="tag tag-warn" title={a.guestDisplayName ?? ''}>{t('rooms.arrivesToday')}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusTag({ status }: { status: HousekeepingStatus }) {
  const { t } = useT();
  return <span className={`tag shrink-0 ${status === 'DIRTY' ? 'tag-warn' : ''}`}>{t(`rooms.status.${status}` as MessageKey)}</span>;
}

/** One room: its housekeeping status, and the guest in it, the guest arriving, or a walk-in. */
function RoomPanel({ room, day, stay, arrival, shift, permissions, onChanged, onClose }: {
  room: BoardRoom;
  day: string;
  stay: Stay | null;
  arrival: Stay | null;
  shift: Shift;
  permissions: string[];
  onChanged: (text: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const canManage = permissions.includes('lodging.manage');
  const [walkIn, setWalkIn] = useState(false);
  return (
    <Note denom="violet" className="grid gap-4 p-4" aria-label={t('rooms.roomN', { room: room.number })} data-testid="room-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[1.25rem] font-semibold">{t('rooms.roomN', { room: room.number })} · {room.roomType.name}</h2>
          {room.lastChange && (
            <p className="text-[0.8125rem] text-muted">
              {t('rooms.lastChange', { who: room.lastChange.byName ?? '—', when: new Date(room.lastChange.at).toLocaleString('en-PH', { dateStyle: 'short', timeStyle: 'short' }) })}
              {room.lastChange.note ? ` · ${room.lastChange.note}` : ''}
            </p>
          )}
        </div>
        <span className="flex items-center gap-2">
          <StatusTag status={room.status} />
          <button type="button" className="btn btn-sm" onClick={onClose}>{t('rooms.close')}</button>
        </span>
      </div>

      {permissions.includes('lodging.housekeeping') && <HousekeepingControls room={room} onChanged={onChanged} />}

      {stay ? (
        <InHousePanel key={stay.id} stayId={stay.id} day={day} shift={shift} permissions={permissions} onChanged={onChanged} />
      ) : arrival ? (
        <ArrivalPanel key={arrival.id} stay={arrival} room={room} canManage={canManage} onChanged={onChanged} />
      ) : !canManage ? (
        <p className="text-muted">{t('rooms.vacant')}</p>
      ) : room.status === 'OUT_OF_ORDER' ? (
        <p className="text-muted">{t('rooms.outOfOrderNoWalkIn')}</p>
      ) : walkIn ? (
        <WalkInForm room={room} day={day} shift={shift} onDone={(text) => { setWalkIn(false); onChanged(text); }} onCancel={() => setWalkIn(false)} />
      ) : (
        <button type="button" className="btn btn-primary justify-self-start" data-testid="walk-in" onClick={() => setWalkIn(true)}>
          <UserPlus className="size-4" aria-hidden /> {t('rooms.walkIn')}
        </button>
      )}
    </Note>
  );
}

/** Housekeeping (§9): set the room clean, dirty, inspected, or out of order with a reason. */
function HousekeepingControls({ room, onChanged }: { room: BoardRoom; onChanged: (text: string | null) => void }) {
  const { t } = useT();
  const [outOfOrder, setOutOfOrder] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(status: HousekeepingStatus) {
    if (status === 'OUT_OF_ORDER' && !note.trim()) return;
    setBusy(true);
    try {
      await api('POST', `/v1/rooms/${room.roomId}/status`, { status, ...(status === 'OUT_OF_ORDER' && { note: note.trim() }) });
      setError(null);
      setOutOfOrder(false);
      setNote('');
      onChanged(t('rooms.statusSet', { room: room.number, status: t(`rooms.status.${status}` as MessageKey) }));
    } catch (err) {
      setError(deskError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2" data-testid="housekeeping">
      <p className="section-title">{t('rooms.housekeeping')}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('rooms.housekeeping')}>
        {STATUSES.filter((s) => s !== room.status).map((s) => (
          <button key={s} type="button" className="btn btn-sm" data-status={s} disabled={busy} onClick={() => (s === 'OUT_OF_ORDER' ? setOutOfOrder(true) : void set(s))}>
            {t(`rooms.mark.${s}` as MessageKey)}
          </button>
        ))}
      </div>
      {outOfOrder && (
        <form className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); void set('OUT_OF_ORDER'); }}>
          <Field id="oooNote" label={t('rooms.outOfOrderWhy')} value={note} maxLength={200} required autoFocus onChange={(e) => setNote(e.target.value)} />
          <button className="btn sm:mb-[2px]" disabled={busy || !note.trim()}>{t('rooms.mark.OUT_OF_ORDER')}</button>
          <button type="button" className="btn sm:mb-[2px]" onClick={() => setOutOfOrder(false)}>{t('common.back')}</button>
        </form>
      )}
      {error && <Callout kind="error">{error}</Callout>}
    </div>
  );
}

interface GuestDraft {
  key: string;
  fullName: string;
  nationality: string;
  idType: string;
  idNumber: string;
  address: string;
  contact: string;
}

const emptyGuest = (): GuestDraft => ({ key: uuid(), fullName: '', nationality: '', idType: '', idNumber: '', address: '', contact: '' });
/** The registry entry as the API takes it: blank fields left out; the first guest is the primary one. */
const guestBody = (g: GuestDraft, isPrimary: boolean) => ({
  isPrimary,
  fullName: g.fullName.trim(),
  ...Object.fromEntries((['nationality', 'idType', 'idNumber', 'address', 'contact'] as const).flatMap((k) => (g[k].trim() ? [[k, g[k].trim()]] : []))),
});

/** The guest registry (§8): who stays, with the ID the front desk saw. */
function GuestFields({ guests, onChange }: { guests: GuestDraft[]; onChange: (gs: GuestDraft[]) => void }) {
  const { t } = useT();
  const patch = (k: string, p: Partial<GuestDraft>) => onChange(guests.map((g) => (g.key === k ? { ...g, ...p } : g)));
  return (
    <div className="grid gap-3">
      {guests.map((g, i) => {
        const id = (f: string) => `${f}-${i}`;
        return (
          <fieldset key={g.key} className="grid gap-3 rounded-[5px] border border-hair bg-white p-3" data-testid="guest-fields">
            <legend className="px-1 text-[0.8125rem] font-semibold text-muted">{i === 0 ? t('rooms.primaryGuest') : t('rooms.guestN', { n: String(i + 1) })}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={id('guestFullName')} label={t('rooms.fullName')} value={g.fullName} maxLength={120} autoComplete="off" required={i === 0} onChange={(e) => patch(g.key, { fullName: e.target.value })} />
              <Field id={id('guestNationality')} label={t('rooms.nationality')} value={g.nationality} maxLength={60} autoComplete="off" onChange={(e) => patch(g.key, { nationality: e.target.value })} />
              <Field id={id('guestIdType')} label={t('rooms.idType')} hint={t('rooms.idTypeHint')} value={g.idType} maxLength={40} autoComplete="off" onChange={(e) => patch(g.key, { idType: e.target.value })} />
              <Field id={id('guestIdNumber')} label={t('rooms.idNumber')} value={g.idNumber} maxLength={64} autoComplete="off" onChange={(e) => patch(g.key, { idNumber: e.target.value })} />
              <Field id={id('guestAddress')} label={t('rooms.address')} value={g.address} maxLength={300} autoComplete="off" onChange={(e) => patch(g.key, { address: e.target.value })} />
              <Field id={id('guestContact')} label={t('rooms.contact')} value={g.contact} maxLength={120} autoComplete="off" onChange={(e) => patch(g.key, { contact: e.target.value })} />
            </div>
            {i > 0 && <button type="button" className="btn btn-sm btn-danger justify-self-start" onClick={() => onChange(guests.filter((x) => x.key !== g.key))}>{t('rooms.removeGuest')}</button>}
          </fieldset>
        );
      })}
      {guests.length < 20 && <button type="button" className="btn btn-sm justify-self-start" onClick={() => onChange([...guests, emptyGuest()])}>{t('rooms.addGuest')}</button>}
    </div>
  );
}

/** A walk-in (§4): book this room from today and check the guest in, in one call. */
function WalkInForm({ room, day, shift, onDone, onCancel }: { room: BoardRoom; day: string; shift: Shift; onDone: (text: string) => void; onCancel: () => void }) {
  const { t } = useT();
  const [departure, setDeparture] = useState(addDays(day, 1));
  const [adults, setAdults] = useState('1');
  const [children, setChildren] = useState('0');
  const [guests, setGuests] = useState<GuestDraft[]>([emptyGuest()]);
  const [allowCharges, setAllowCharges] = useState(true);
  const [limit, setLimit] = useState('');
  const [override, setOverride] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useAttemptKey();
  const limitAmount = limit.trim() ? parseAmount(limit) : null;
  const ok = guests[0]!.fullName.trim() !== '' && guests.every((g, i) => i === 0 || g.fullName.trim() !== '') && departure > day
    && /^\d+$/.test(adults) && Number(adults) >= 1 && /^\d+$/.test(children) && (!limit.trim() || limitAmount !== null) && (ready(room.status) || override);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    try {
      await api('POST', '/v1/stays', {
        branchId: shift.branch.id, roomId: room.roomId, arrivalDate: day, departureDate: departure,
        adults: Number(adults), children: Number(children), source: 'WALK_IN',
        guests: guests.map((g, i) => guestBody(g, i === 0)),
        allowCharges, ...(allowCharges && limitAmount && { chargeLimit: limitAmount }),
        checkIn: true, ...(override && { overrideHousekeeping: true }),
      }, { 'idempotency-key': key.get() });
      key.settle();
      onDone(t('rooms.checkedIn', { room: room.number, name: guests[0]!.fullName.trim() }));
    } catch (err) {
      key.settle(err);
      setError(deskError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => void submit(e)} data-testid="walk-in-form" aria-label={t('rooms.walkIn')}>
      <p className="section-title">{t('rooms.walkInTitle', { day: dateLabel(day) })}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field id="departure" type="date" label={t('rooms.departure')} value={departure} min={addDays(day, 1)} onChange={(e) => setDeparture(e.target.value)} />
        <Field id="adults" inputMode="numeric" label={t('rooms.adults')} value={adults} onChange={(e) => setAdults(e.target.value)} />
        <Field id="children" inputMode="numeric" label={t('rooms.children')} value={children} onChange={(e) => setChildren(e.target.value)} />
      </div>
      <GuestFields guests={guests} onChange={setGuests} />
      <ChargeFields allowCharges={allowCharges} setAllowCharges={setAllowCharges} limit={limit} setLimit={setLimit} invalid={limit.trim() !== '' && limitAmount === null} />
      {!ready(room.status) && <OverrideField status={room.status} checked={override} onChange={setOverride} />}
      {error && <Callout kind="error">{error}</Callout>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={!ok || busy}><LogIn className="size-4" aria-hidden /> {t('rooms.checkIn')}</button>
        <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

function ChargeFields({ allowCharges, setAllowCharges, limit, setLimit, invalid }: { allowCharges: boolean; setAllowCharges: (v: boolean) => void; limit: string; setLimit: (v: string) => void; invalid: boolean }) {
  const { t } = useT();
  return (
    <div className="grid gap-2 sm:grid-cols-[auto_14rem] sm:items-end">
      <label className="flex min-h-12 items-center gap-2">
        <input type="checkbox" id="allowCharges" className="size-5" checked={allowCharges} onChange={(e) => setAllowCharges(e.target.checked)} />
        {t('rooms.allowCharges')}
      </label>
      {allowCharges && <Field id="chargeLimit" className="input-money" inputMode="decimal" label={t('rooms.chargeLimit')} hint={t('rooms.chargeLimitHint')} error={invalid ? t('rooms.amountInvalid') : undefined} value={limit} onChange={(e) => setLimit(e.target.value)} />}
    </div>
  );
}

function OverrideField({ status, checked, onChange }: { status: HousekeepingStatus; checked: boolean; onChange: (v: boolean) => void }) {
  const { t } = useT();
  return (
    <div className="grid gap-2">
      <Callout kind="warn">{t('rooms.notReady', { status: t(`rooms.status.${status}` as MessageKey) })}</Callout>
      <label className="flex min-h-12 items-center gap-2">
        <input type="checkbox" id="overrideHousekeeping" className="size-5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {t('rooms.override')}
      </label>
    </div>
  );
}

/** A booking arriving today (§4): check it in, recording the primary guest first when the registry has none. */
function ArrivalPanel({ stay, room, canManage, onChanged }: { stay: Stay; room: BoardRoom; canManage: boolean; onChanged: (text: string | null) => void }) {
  const { t } = useT();
  const hasPrimary = stay.guests.some((g) => g.isPrimary);
  const [guests, setGuests] = useState<GuestDraft[]>(() => [{ ...emptyGuest(), fullName: hasPrimary ? '' : (stay.guestDisplayName ?? '') }]);
  const [override, setOverride] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = (hasPrimary || guests[0]!.fullName.trim() !== '') && (ready(room.status) || override);

  async function checkIn(e: FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    try {
      // Check-in is idempotent by state: a retry of a lost answer is refused as "not booked", never doubled.
      await api('POST', `/v1/stays/${stay.id}/check-in`, {
        ...(override && { overrideHousekeeping: true }),
        guests: hasPrimary ? [] : guests.filter((g) => g.fullName.trim()).map((g, i) => guestBody(g, i === 0)),
      });
      onChanged(t('rooms.checkedIn', { room: room.number, name: stay.guestDisplayName ?? guests[0]!.fullName.trim() }));
    } catch (err) {
      setError(deskError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-3" onSubmit={(e) => void checkIn(e)} data-testid="arrival-panel">
      <p className="section-title">{t('rooms.arrival')}</p>
      <p className="text-[1.0625rem] font-semibold">{stay.guestDisplayName}</p>
      <p className="text-[0.9375rem] text-muted">{t('rooms.dates', { from: dateLabel(stay.arrivalDate), to: dateLabel(stay.departureDate) })} · {t('rooms.guests', { n: String(stay.adults + stay.children) })}</p>
      {canManage && (
        <>
          {!hasPrimary && (
            <>
              <p className="text-[0.875rem]">{t('rooms.registryFirst')}</p>
              <GuestFields guests={guests} onChange={setGuests} />
            </>
          )}
          {!ready(room.status) && <OverrideField status={room.status} checked={override} onChange={setOverride} />}
          {error && <Callout kind="error">{error}</Callout>}
          <button className="btn btn-primary justify-self-start" disabled={!ok || busy}><LogIn className="size-4" aria-hidden /> {t('rooms.checkIn')}</button>
        </>
      )}
    </form>
  );
}

/**
 * The guest in the room: the stay, its folio and deposits; a cash deposit at this drawer, and the
 * check-out (nights and deposits put on the folio, the balance paid here, then the statement).
 */
function InHousePanel({ stayId, day, shift, permissions, onChanged }: { stayId: string; day: string; shift: Shift; permissions: string[]; onChanged: (text: string | null) => void }) {
  const { t } = useT();
  const [stay, setStay] = useState<Stay | null>(null);
  const [view, setView] = useState<'none' | 'folio' | 'deposit' | 'checkout'>('none');
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = permissions.includes('lodging.manage');

  async function load() {
    try {
      setStay(await api<Stay>('GET', `/v1/stays/${stayId}`));
    } catch (err) {
      setError(errorText(err, t('common.error'), t('common.network')));
    }
  }
  useEffect(() => {
    void load();
  }, [stayId]);

  if (!stay) return error ? <Callout kind="error">{error}</Callout> : null;
  const balance = stay.folio?.balance ?? '0.00';
  return (
    <div className="grid gap-3" data-testid="in-house">
      {/* Once checked out, only the outcome and the statement stay on screen. */}
      {!ended && (<>
      <div className="grid gap-1">
        <p className="section-title">{t('rooms.inHouse')}</p>
        <p className="text-[1.125rem] font-semibold" data-testid="in-house-guest">{stay.guestDisplayName}</p>
        <p className="text-[0.9375rem] text-muted">
          {t('rooms.dates', { from: dateLabel(stay.arrivalDate), to: dateLabel(stay.departureDate) })} · {t('rooms.guests', { n: String(stay.adults + stay.children) })}
        </p>
      </div>
      {stay.overstay && <Callout kind="warn"><span data-testid="overstay">{t('rooms.overstayHint', { date: dateLabel(stay.departureDate) })}</span></Callout>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.9375rem] sm:grid-cols-4">
        <div><dt className="text-[0.8125rem] text-muted">{t('rooms.balance')}</dt><dd data-testid="stay-balance"><Money value={balance} className="font-semibold" /></dd></div>
        <div><dt className="text-[0.8125rem] text-muted">{t('rooms.depositsHeld')}</dt><dd data-testid="stay-deposits"><Money value={stay.depositsHeld ?? '0.00'} /></dd></div>
        <div><dt className="text-[0.8125rem] text-muted">{t('rooms.charged')}</dt><dd><Money value={stay.folio?.charged ?? '0.00'} /></dd></div>
        <div>
          <dt className="text-[0.8125rem] text-muted">{t('rooms.chargeLimit')}</dt>
          <dd>{!stay.allowCharges ? t('room.noCharges') : stay.chargeLimit === null ? t('room.noLimitShort') : <Money value={stay.chargeLimit} />}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        {stay.folio && <button type="button" className="btn" aria-pressed={view === 'folio'} onClick={() => setView(view === 'folio' ? 'none' : 'folio')}>{t('rooms.folio')}</button>}
        {canManage && <button type="button" className="btn" aria-pressed={view === 'deposit'} onClick={() => setView(view === 'deposit' ? 'none' : 'deposit')}>{t('rooms.cashDeposit')}</button>}
        {canManage && (
          <button type="button" className={`btn ${view === 'checkout' ? '' : 'btn-primary'}`} data-testid="check-out" aria-pressed={view === 'checkout'} onClick={() => setView(view === 'checkout' ? 'none' : 'checkout')}>
            <LogOut className="size-4" aria-hidden /> {t('rooms.checkOut')}
          </button>
        )}
      </div>
      </>)}
      {view === 'folio' && stay.folio && <FolioView folioId={stay.folio.id} />}
      {view === 'deposit' && (
        <DepositForm stay={stay} shift={shift} onDone={(text) => { setView('none'); void load(); onChanged(text); }} />
      )}
      {view === 'checkout' && <CheckOut stay={stay} day={day} shift={shift} onReload={load} onCheckedOut={() => setEnded(true)} onDone={onChanged} />}
    </div>
  );
}

/** The folio's entries and balance; the statement can be printed from here at any time. */
function FolioView({ folioId, refresh = 0 }: { folioId: string; refresh?: number }) {
  const { t } = useT();
  const [folio, setFolio] = useState<Folio | null>(null);
  const [statement, setStatement] = useState<FolioStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Folio>('GET', `/v1/folios/${folioId}`).then(setFolio, (err) => setError(errorText(err, t('common.error'), t('common.network'))));
  }, [folioId, refresh]);

  async function showStatement() {
    try {
      setStatement(await api<FolioStatement>('GET', `/v1/folios/${folioId}/statement`));
    } catch (err) {
      setError(errorText(err, t('common.error'), t('common.network')));
    }
  }

  if (error) return <Callout kind="error">{error}</Callout>;
  if (!folio) return null;
  return (
    <div className="grid gap-2" data-testid="folio">
      <div className="overflow-x-auto rounded-[5px] border border-hair bg-white">
        <table className="w-full text-[0.9375rem]">
          <thead className="bg-table-head text-left text-[0.8125rem] text-muted">
            <tr><th className="px-3 py-2 font-semibold">{t('rooms.date')}</th><th className="px-3 py-2 font-semibold">{t('rooms.entry')}</th><th className="px-3 py-2 text-right font-semibold">{t('rooms.amount')}</th></tr>
          </thead>
          <tbody>
            {folio.entries.length === 0 && <tr><td colSpan={3} className="px-3 py-3 text-muted">{t('rooms.folioEmpty')}</td></tr>}
            {folio.entries.map((e) => (
              <tr key={e.id} className="border-t border-hair-soft" data-kind={e.kind}>
                <td className="serial whitespace-nowrap px-3 py-1.5 text-[0.8125rem] text-muted">{e.nightDate ?? e.createdAt.slice(0, 10)}</td>
                <td className="px-3 py-1.5">{e.description ?? t(`folio.kind.${e.kind}` as MessageKey)}</td>
                <td className="px-3 py-1.5 text-right"><Money value={e.amount} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-hair font-semibold"><td className="px-3 py-2" colSpan={2}>{t('rooms.balance')}</td><td className="px-3 py-2 text-right" data-testid="folio-balance"><Money value={folio.balance} /></td></tr>
          </tfoot>
        </table>
      </div>
      {statement ? <Statement data={statement} /> : <button type="button" className="btn btn-sm justify-self-start" onClick={() => void showStatement()}>{t('rooms.statement')}</button>}
    </div>
  );
}

/** A cash deposit taken at this drawer (§6): held without VAT until it is applied to the folio. */
function DepositForm({ stay, shift, onDone }: { stay: Stay; shift: Shift; onDone: (text: string) => void }) {
  const { t } = useT();
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useAttemptKey();
  const value = parseAmount(amount);
  const ok = value !== null && isPositive(value);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    try {
      await api('POST', `/v1/stays/${stay.id}/deposits`, { method: 'CASH', cashierSessionId: shift.sessionId, amount: value }, { 'idempotency-key': key.get() });
      key.settle();
      onDone(t('rooms.depositTaken', { amount: peso(value!), room: stay.room?.number ?? '' }));
    } catch (err) {
      key.settle(err);
      setError(unanswered(err) ? t('rooms.unconfirmed') : deskError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-2 rounded-[5px] border border-hair bg-white p-3 sm:grid-cols-[14rem_auto] sm:items-end" onSubmit={(e) => void submit(e)} data-testid="deposit-form">
      <Field id="depositAmount" className="input-money" inputMode="decimal" label={t('rooms.depositAmount')} hint={t('rooms.depositHint')} value={amount} placeholder="0.00" autoFocus onChange={(e) => setAmount(e.target.value)} />
      <button className="btn btn-primary sm:mb-[26px]" disabled={!ok || busy}>{t('rooms.takeDeposit')}</button>
      {error && <div className="sm:col-span-2"><Callout kind={error === t('rooms.unconfirmed') ? 'warn' : 'error'}>{error}</Callout></div>}
    </form>
  );
}

/**
 * Check-out (§4, §5.2): prepare (every night still due and the deposits held go on the folio), pay what
 * is left at this drawer (cash with change, card, QR, or the guest's store credit), refund a deposit left
 * over, then check out; the room turns dirty and the statement is printed for the guest to sign.
 */
function CheckOut({ stay, day, shift, onReload, onCheckedOut, onDone }: {
  stay: Stay;
  day: string;
  shift: Shift;
  onReload: () => Promise<void>;
  onCheckedOut: () => void;
  onDone: (text: string | null) => void;
}) {
  const { t } = useT();
  const early = day < addDays(stay.departureDate, -1);
  const [departEarly, setDepartEarly] = useState(false);
  const [prepared, setPrepared] = useState<{ folioId: string; balance: string; depositsHeld: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [checkedOut, setCheckedOut] = useState(false);
  const [done, setDone] = useState<FolioStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refundKey = useAttemptKey();

  async function prepare() {
    setBusy(true);
    try {
      setPrepared(await api<{ folioId: string; balance: string; depositsHeld: string }>('POST', `/v1/stays/${stay.id}/prepare-check-out`, { departEarly }));
      setRefresh((n) => n + 1);
      setError(null);
    } catch (err) {
      setError(deskError(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function refundDeposit() {
    setBusy(true);
    try {
      await api('POST', `/v1/stays/${stay.id}/deposits/refund`, { reason: 'Left over at check-out', refund: { method: 'CASH', cashierSessionId: shift.sessionId } }, { 'idempotency-key': refundKey.get() });
      refundKey.settle();
      await prepare();
    } catch (err) {
      refundKey.settle(err);
      setError(unanswered(err) ? t('rooms.unconfirmed') : deskError(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function checkOut() {
    if (!prepared) return;
    setBusy(true);
    try {
      await api('POST', `/v1/stays/${stay.id}/check-out`, { departEarly });
      setCheckedOut(true);
      onCheckedOut();
      setDone(await api<FolioStatement>('GET', `/v1/folios/${prepared.folioId}/statement`).catch(() => null));
      setError(null);
    } catch (err) {
      // Check-out is guarded by state: a retry after a lost answer is refused ("checked out"), never doubled.
      setError(deskError(err, t));
      if (err instanceof ApiFailure && err.error.code === 'FOLIO_BALANCE_DUE') void prepare();
    } finally {
      setBusy(false);
    }
  }

  if (checkedOut) {
    return (
      <div className="grid gap-3" data-testid="checked-out">
        <Callout kind="info">{t('rooms.checkedOut', { room: stay.room?.number ?? '' })}</Callout>
        {done && <Statement data={done} />}
        <button type="button" className="btn btn-primary justify-self-start" onClick={() => onDone(t('rooms.checkedOut', { room: stay.room?.number ?? '' }))}>{t('rooms.done')}</button>
      </div>
    );
  }

  const balance = prepared?.balance ?? '0.00';
  const held = prepared?.depositsHeld ?? '0.00';
  return (
    <div className="grid gap-3 rounded-[5px] border border-hair bg-white p-3" data-testid="checkout">
      <p className="section-title">{t('rooms.checkOut')}</p>
      {!prepared ? (
        <>
          <p className="text-[0.9375rem]">{t('rooms.prepareLede')}</p>
          {early && (
            <label className="flex min-h-12 items-center gap-2">
              <input type="checkbox" id="departEarly" className="size-5" checked={departEarly} onChange={(e) => setDepartEarly(e.target.checked)} />
              {t('rooms.departEarly', { date: dateLabel(stay.departureDate) })}
            </label>
          )}
          <button type="button" className="btn btn-primary justify-self-start" data-testid="prepare-check-out" disabled={busy} onClick={() => void prepare()}>{t('rooms.prepare')}</button>
        </>
      ) : (
        <>
          <FolioView folioId={prepared.folioId} refresh={refresh} />
          <p className="flex items-baseline justify-between gap-3">
            <span className="text-[1.0625rem]">{t('rooms.toPay')}</span>
            <Money value={balance} className="text-[1.875rem] font-semibold leading-tight" />
          </p>
          {isPositive(balance) && (
            <FolioPayment
              folioId={prepared.folioId}
              balance={balance}
              shift={shift}
              hasCustomer={Boolean(stay.customerId)}
              onPaid={async () => { await prepare(); await onReload(); }}
            />
          )}
          {isZero(balance) && isPositive(held) && (
            <div className="grid gap-2">
              <Callout kind="warn">{t('rooms.depositLeft', { amount: peso(held) })}</Callout>
              <button type="button" className="btn justify-self-start" disabled={busy} onClick={() => void refundDeposit()}>{t('rooms.refundDeposit', { amount: peso(held) })}</button>
            </div>
          )}
          {isZero(balance) && isZero(held) && (
            <button type="button" className="btn btn-primary min-h-14 justify-self-start px-6 text-[1.0625rem]" data-testid="finish-check-out" disabled={busy} onClick={() => void checkOut()}>
              <LogOut className="size-4" aria-hidden /> {t('rooms.finishCheckOut')}
            </button>
          )}
        </>
      )}
      {error && <Callout kind="error">{error}</Callout>}
    </div>
  );
}

/**
 * Paying the folio at this drawer (§5.2): cash (change given), card or QR (a payment of purpose FOLIO,
 * then recorded on the folio), or the guest's store credit. Each recording has its own key, kept when
 * no answer comes back so the money is never taken twice.
 */
function FolioPayment({ folioId, balance, shift, hasCustomer, onPaid }: { folioId: string; balance: string; shift: Shift; hasCustomer: boolean; onPaid: () => Promise<void> }) {
  const { t } = useT();
  const [cash, setCash] = useState('');
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [change, setChange] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const payKey = useAttemptKey();
  const intentKey = useRef<{ key: string; method: PaymentIntent['method'] } | null>(null);
  const txId = useRef(uuid());
  const tendered = parseAmount(cash);

  async function record(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await api<{ payment: { change: string | null }; balance: string }>('POST', `/v1/folios/${folioId}/payments`, { cashierSessionId: shift.sessionId, ...body }, { 'idempotency-key': payKey.get() });
      payKey.settle();
      setChange(r.payment.change && isPositive(r.payment.change) ? r.payment.change : null);
      setNotice(null);
      setCash('');
      setIntent(null);
      txId.current = uuid();
      await onPaid();
    } catch (err) {
      payKey.settle(err);
      setNotice(unanswered(err) ? { kind: 'warn', text: t('rooms.unconfirmed') } : { kind: 'error', text: deskError(err, t) });
    } finally {
      setBusy(false);
    }
  }

  async function takeElectronic(method: PaymentIntent['method']) {
    setBusy(true);
    try {
      const key = intentKey.current?.method === method ? intentKey.current.key : uuid();
      intentKey.current = { key, method };
      const p = await api<PaymentIntent>('POST', '/v1/payment-intents', { cashierSessionId: shift.sessionId, clientTransactionId: txId.current, method, amount: balance, purpose: 'FOLIO' }, { 'idempotency-key': key });
      intentKey.current = null;
      setIntent(p);
      setNotice(p.status === 'FAILED' ? { kind: 'warn', text: t('pay.declined') } : null);
      if (p.status === 'SUCCEEDED') {
        setBusy(false);
        await record({ method: 'INTENT', paymentIntentId: p.id });
      }
    } catch (err) {
      if (!unanswered(err)) intentKey.current = null;
      setNotice(unanswered(err) ? { kind: 'warn', text: t('pay.intentUnconfirmed') } : { kind: 'error', text: deskError(err, t) });
    } finally {
      setBusy(false);
    }
  }

  async function checkIntent() {
    if (!intent) return;
    try {
      const p = await api<PaymentIntent>('POST', `/v1/payment-intents/${intent.id}/reconcile`);
      setIntent(p);
      if (p.status === 'SUCCEEDED') await record({ method: 'INTENT', paymentIntentId: p.id });
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
  }

  const waiting = intent && (intent.status === 'UNKNOWN' || intent.status === 'PROCESSING');
  return (
    <div className="grid gap-3" data-testid="folio-payment">
      {change && (
        <p className="flex items-baseline justify-between gap-3" aria-live="polite" data-testid="folio-change">
          <span className="text-[1.0625rem]">{t('pay.change')}</span>
          <Money value={change} className="text-[1.875rem] font-semibold leading-tight" />
        </p>
      )}
      <div className="field">
        <label htmlFor="folioCash">{t('pay.tendered')}</label>
        <input id="folioCash" className="input input-money" inputMode="decimal" value={cash} placeholder="0.00" onChange={(e) => setCash(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        {quickTenders(balance).map((v) => (
          <button key={v} type="button" className="btn btn-sm money" onClick={() => setCash(v)}><Money value={v} /></button>
        ))}
      </div>
      {tendered && (
        <p className="flex items-baseline justify-between gap-3">
          {gte(tendered, balance) ? (
            <><span>{t('pay.change')}</span><Money value={sub(tendered, balance)} className="text-[1.25rem] font-semibold" /></>
          ) : (
            <><span className="text-muted">{t('rooms.partPayment')}</span><Money value={tendered} /></>
          )}
        </p>
      )}
      <button type="button" className="btn btn-primary" data-testid="folio-pay-cash" disabled={busy || !tendered || !isPositive(tendered)} onClick={() => void record({ method: 'CASH', tendered })}>
        {t('rooms.payCash')}
      </button>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn" disabled={busy || Boolean(waiting)} onClick={() => void takeElectronic('CARD')}><CreditCard className="size-4" aria-hidden /> {t('pay.card')}</button>
        <button type="button" className="btn" disabled={busy || Boolean(waiting)} onClick={() => void takeElectronic('QR')}><QrCode className="size-4" aria-hidden /> {t('pay.qr')}</button>
      </div>
      {intent && (
        <p className="flex flex-wrap items-center justify-between gap-2 text-[0.9375rem]">
          <span>{t('pay.paidElectronic', { method: intent.method === 'CARD' ? t('pay.card') : t('pay.qr') })} <PaymentTag status={intent.status} /></span>
          {waiting && <button type="button" className="btn btn-sm" onClick={() => void checkIntent()}>{t('pay.check')}</button>}
          {intent.status === 'SUCCEEDED' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void record({ method: 'INTENT', paymentIntentId: intent.id })}>{t('rooms.recordPayment')}</button>}
        </p>
      )}
      {hasCustomer && (
        <button type="button" className="btn" disabled={busy} onClick={() => void record({ method: 'STORE_CREDIT', amount: balance })}>{t('rooms.payStoreCredit', { amount: peso(balance) })}</button>
      )}
      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}
    </div>
  );
}

/** The guest folio statement, as the server words it ("Guest folio — not an invoice" while invoicing is off). */
export function Statement({ data }: { data: FolioStatement }) {
  const { t } = useT();
  const till = useTill();
  const ref = useRef<HTMLDivElement>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const print = async () => {
    if (!ref.current) return;
    setPrintError(null);
    try {
      await till.printer.print(ref.current, statementToPrintable(data));
    } catch (e) {
      setPrintError((e as Error).message);
    }
  };
  const totals: [string, string][] = [
    ['Room nights', data.totals.roomNights], ['Accommodation tax', data.totals.accommodationTax], ['Charges', data.totals.charges],
    ['Adjustments', data.totals.adjustments], ['Deposits', data.totals.deposits], ['Payments', data.totals.payments],
  ];
  return (
    <div className="grid content-start gap-3" data-testid="statement">
      <div ref={ref} className="printable note mx-auto w-full max-w-[420px] p-6 font-[family-name:var(--font-serial)] text-[0.875rem]">
        <header className="text-center">
          <p className="text-[1.0625rem] font-semibold">{data.seller.tradeName ?? data.seller.registeredName}</p>
          <p>{data.seller.registeredName}</p>
          {data.seller.registeredAddress && <p>{data.seller.registeredAddress}</p>}
          {data.seller.tin && <p className="serial">TIN {data.seller.tin}</p>}
          <p className="serial mt-2 font-semibold">{data.title}</p>
        </header>
        <p className="serial mt-3 flex justify-between border-y border-dashed border-hair py-1">
          <span>Room {data.stay.roomNumber} · {data.stay.roomType}</span>
          <span>{data.stay.arrivalDate} – {data.stay.departureDate}</span>
        </p>
        {data.stay.guestName && <p className="mt-1">Guest: {data.stay.guestName}</p>}
        <ul className="mt-2 grid gap-1">
          {data.lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-3">
              <span><span className="serial text-muted">{l.date}</span> {l.description}</span>
              <span className="money">{l.amount}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 grid gap-0.5 border-t border-dashed border-hair pt-2">
          {totals.filter(([, v]) => !isZero(v)).map(([k, v]) => (
            <div key={k} className="flex justify-between"><dt>{k}</dt><dd><Money value={v} /></dd></div>
          ))}
          <div className="flex justify-between text-[1rem] font-semibold"><dt>BALANCE</dt><dd><Money value={data.totals.balance} /></dd></div>
        </dl>
        <p className="mt-8 border-t border-ink pt-1 text-center text-muted">{data.signatureLine}</p>
      </div>
      {printError && <div className="no-print mx-auto w-full max-w-[420px]"><Callout kind="error">{t('receipt.printFailed')} ({printError})</Callout></div>}
      <button type="button" className="no-print btn mx-auto" onClick={() => void print()}>
        <Printer className="size-4" aria-hidden /> {printError ? t('receipt.reprint') : t('rooms.printStatement')}
      </button>
    </div>
  );
}

