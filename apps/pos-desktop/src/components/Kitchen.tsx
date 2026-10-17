import { ChefHat, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT, type MessageKey } from '../i18n';
import { api } from '../lib/api';
import { chime, soundPreference } from '../lib/chime';
import { usePoll } from '../lib/poll';
import type { KitchenTicket } from '../types';
import { errorText, type Notice } from './Payment';
import { Callout, Note } from './ui';

type Place = { id: string; code: string; name: string };
export type KitchenPlace = { branch: Place; station: Place | null };

/** Minutes after firing when a ticket is marked late (amber): someone must look at it. */
const LATE_AFTER_MIN = 10;
/** How long a newly arrived ticket flashes. */
const FLASH_MS = 8000;

/** Finished tickets, read-only: what was cooked and served, to answer "did table 4's burger go out?". */
function DoneTickets({ tickets, showStation }: { tickets: KitchenTicket[] | null; showStation: boolean }) {
  const { t } = useT();
  if (tickets === null) return <p className="text-muted">{t('floor.loading')}</p>;
  if (tickets.length === 0) return <p className="py-10 text-center text-muted">{t('kds.noneDone')}</p>;
  const clock = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—');
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] items-start gap-3" aria-label={t('kds.viewDone')}>
      {tickets.map((tk) => (
        <li key={tk.id}>
          <Note className="grid gap-2 p-4 opacity-90">
            <div className="flex items-start justify-between gap-2 border-b border-hair-soft pb-2">
              <div>
                <p className="serial text-[1.125rem] font-bold">{tk.order ? (tk.order.tableCode ?? tk.order.customerName ?? t('floor.takeaway')) : '—'}</p>
                <p className="serial text-[0.8125rem] text-muted">
                  #{tk.order?.orderNumber} · {t('kds.ticket', { n: String(tk.ticketNumber) })}{showStation && <> · <span className="text-violet">{tk.station.code}</span></>}
                </p>
              </div>
              <span className="serial text-[0.8125rem] text-muted">{t('kds.firedAt', { time: clock(tk.firedAt) })}<br />{tk.bumpedAt && t('kds.bumpedAt', { time: clock(tk.bumpedAt) })}</span>
            </div>
            <ul className="grid gap-1 text-[0.9375rem]">
              {tk.items.map((i) => (
                <li key={i.id} className={`flex justify-between gap-2 ${i.status === 'VOIDED' ? 'text-muted line-through' : ''}`}>
                  <span><span className="money">{i.quantity}×</span> {i.name}{i.modifiers.length > 0 && <span className="text-muted"> · {i.modifiers.map((m) => m.name).join(', ')}</span>}</span>
                  <span className="tag">{t(`item.status.${i.status}` as MessageKey)}</span>
                </li>
              ))}
            </ul>
          </Note>
        </li>
      ))}
    </ul>
  );
}

/** Pick the branch and station this screen shows (kitchen staff see only their own branches). */
export function KitchenPicker({ onReady, onBack }: { onReady: (p: KitchenPlace) => void; onBack?: () => void }) {
  const { t } = useT();
  const [branches, setBranches] = useState<Place[] | null>(null);
  const [branch, setBranch] = useState<Place | null>(null);
  const [stations, setStations] = useState<Place[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    api<{ data: Place[] }>('GET', '/v1/branches')
      .then(({ data }) => {
        setBranches(data);
        if (data.length === 1) setBranch(data[0]!);
      })
      .catch((err) => setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) }));
  }, []);

  useEffect(() => {
    if (!branch) return;
    setStations(null);
    api<{ data: Place[] }>('GET', `/v1/kitchen-stations?branchId=${branch.id}`)
      .then(({ data }) => setStations(data))
      .catch((err) => setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) }));
  }, [branch?.id]);

  return (
    <div className="mx-auto max-w-[760px] px-4 py-10 sm:px-6">
      <h1 className="text-[1.75rem] font-bold">{t('kds.pickTitle')}</h1>
      <p className="mt-1 text-muted">{t('kds.pickLede')}</p>
      {notice && <div className="mt-4"><Callout kind={notice.kind}>{notice.text}</Callout></div>}
      {branches?.length === 0 && <div className="mt-6"><Callout kind="warn">{t('kds.noBranch')}</Callout></div>}
      {branches && branches.length > 1 && (
        <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label={t('kds.branch')}>
          {branches.map((b) => (
            <button key={b.id} type="button" className="btn" aria-pressed={branch?.id === b.id} onClick={() => setBranch(b)}>
              {b.name} <span className="serial text-[0.8125rem] text-violet">{b.code}</span>
            </button>
          ))}
        </div>
      )}
      {branch && stations && (
        <div className="mt-6 grid gap-3">
          {stations.length === 0 && <Callout kind="warn">{t('kds.noStations')}</Callout>}
          {stations.map((s) => (
            <Note key={s.id} denom="violet" className="flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <p className="text-[1.0625rem] font-semibold">{s.name}</p>
                <p className="serial text-[0.8125rem] text-violet">{s.code} <span className="text-muted">· {branch.name}</span></p>
              </div>
              <button type="button" className="btn btn-primary" onClick={() => onReady({ branch, station: s })}>{t('kds.show')}</button>
            </Note>
          ))}
          {stations.length > 1 && (
            <button type="button" className="btn justify-self-start" onClick={() => onReady({ branch, station: null })}>{t('kds.allStations')}</button>
          )}
        </div>
      )}
      {onBack && <button type="button" className="btn mt-8" onClick={onBack}>{t('common.back')}</button>}
    </div>
  );
}

/**
 * The kitchen display (ADR-0014 §7): open tickets for a station, oldest first. The kitchen starts and
 * readies items, or bumps a whole ticket; the floor sees it on its next poll. Statuses only move forward.
 */
export function KitchenBoard({ place }: { place: KitchenPlace }) {
  const { t } = useT();
  const [tickets, setTickets] = useState<KitchenTicket[] | null>(null);
  const [done, setDone] = useState<KitchenTicket[] | null>(null);
  const [view, setView] = useState<'open' | 'done'>('open');
  const [notice, setNotice] = useState<Notice>(null);
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(new Set<string>());
  const [, force] = useState(0);
  // New tickets chime once and flash for a while; the first load is what was already there.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Map<string, number>>(new Map());
  const [sound, setSound] = useState(soundPreference.get);
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const load = useCallback(() => {
    const q = new URLSearchParams({ branchId: place.branch.id, status: 'OPEN', ...(place.station && { stationId: place.station.id }) });
    api<{ data: KitchenTicket[] }>('GET', `/v1/kitchen/tickets?${q}`)
      .then(({ data }) => {
        setTickets(data);
        setNotice((n) => (n?.kind === 'warn' ? null : n));
        const arrived = seen.current ? data.filter((tk) => !seen.current!.has(tk.id)) : [];
        seen.current = new Set([...(seen.current ?? []), ...data.map((tk) => tk.id)]);
        if (arrived.length) {
          if (soundRef.current) chime();
          setFresh((m) => new Map([...m, ...arrived.map((tk) => [tk.id, Date.now()] as const)]));
        }
      })
      // Keep showing the last tickets: a kitchen screen must not go blank on a dropped connection.
      .catch(() => setNotice({ kind: 'warn', text: t('kds.offline') }));
  }, [place.branch.id, place.station?.id]);
  usePoll(load, 4000, true);

  /** Recently finished tickets (everything served or voided), newest first, to look one up again. */
  const loadDone = useCallback(() => {
    const q = new URLSearchParams({ branchId: place.branch.id, status: 'ALL', ...(place.station && { stationId: place.station.id }) });
    api<{ data: KitchenTicket[] }>('GET', `/v1/kitchen/tickets?${q}`)
      .then(({ data }) => setDone(data.filter((tk) => tk.items.every((i) => i.status === 'SERVED' || i.status === 'VOIDED')).slice(0, 30)))
      .catch(() => setNotice({ kind: 'warn', text: t('kds.offline') }));
  }, [place.branch.id, place.station?.id]);
  useEffect(() => {
    if (view === 'done') loadDone();
  }, [view, loadDone]);

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      // A ticket stops flashing after FLASH_MS.
      setFresh((m) => (m.size && [...m.values()].some((at) => Date.now() - at > FLASH_MS) ? new Map([...m].filter(([, at]) => Date.now() - at <= FLASH_MS)) : m));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /** One action at a time per ticket or item: a double tap must not skip a status. */
  async function act(key: string, run: () => Promise<unknown>) {
    if (busy.current.has(key)) return;
    busy.current.add(key);
    force((n) => n + 1);
    try {
      await run();
      setNotice(null);
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    } finally {
      busy.current.delete(key);
      force((n) => n + 1);
      load();
    }
  }
  const setStatus = (itemId: string, status: 'IN_PREP' | 'READY') => act(itemId, () => api('POST', `/v1/order-items/${itemId}/status`, { status }));
  const bump = (ticketId: string) => act(ticketId, () => api('POST', `/v1/kitchen/tickets/${ticketId}/bump`));

  return (
    <div className="grid gap-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2" role="group" aria-label={t('kds.view')}>
          <button type="button" className="btn" aria-pressed={view === 'open'} onClick={() => setView('open')}>{t('kds.viewOpen')}{tickets ? ` (${tickets.length})` : ''}</button>
          <button type="button" className="btn" aria-pressed={view === 'done'} onClick={() => setView('done')}>{t('kds.viewDone')}</button>
        </div>
        <button
          type="button"
          className="btn"
          aria-pressed={sound}
          onClick={() => {
            const next = !sound;
            setSound(next);
            soundPreference.set(next);
            if (next) chime(); // also unlocks audio in browsers that need a tap first
          }}
        >
          {sound ? <Volume2 className="size-4" aria-hidden /> : <VolumeX className="size-4" aria-hidden />} {sound ? t('kds.soundOn') : t('kds.soundOff')}
        </button>
      </div>
      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}
      {view === 'done' ? (
        <DoneTickets tickets={done} showStation={!place.station} />
      ) : tickets === null ? (
        <p className="text-muted">{t('floor.loading')}</p>
      ) : tickets.length === 0 ? (
        <div className="grid min-h-[50vh] place-items-center text-center text-muted">
          <p className="grid justify-items-center gap-3 text-[1.25rem]"><ChefHat className="size-10" aria-hidden /> {t('kds.empty')}</p>
        </div>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] items-start gap-4" aria-label={t('kds.tickets')}>
          {tickets.map((tk) => {
            const minutes = Math.max(0, Math.floor((now - Date.parse(tk.firedAt)) / 60000));
            const seconds = Math.max(0, Math.floor((now - Date.parse(tk.firedAt)) / 1000) % 60);
            const late = minutes >= LATE_AFTER_MIN;
            const where = tk.order ? (tk.order.tableCode ?? tk.order.customerName ?? t('floor.takeaway')) : '—';
            const waiting = tk.items.some((i) => i.status === 'FIRED' || i.status === 'IN_PREP');
            return (
              <li key={tk.id}>
                <Note className={`grid gap-3 p-4 ${late ? 'border-[#e7c27a]' : ''} ${fresh.has(tk.id) ? 'kds-fresh' : ''}`} aria-label={t('kds.ticketLabel', { n: String(tk.ticketNumber), where })} data-fresh={fresh.has(tk.id) || undefined}>
                  {fresh.has(tk.id) && <span className="tag tag-warn justify-self-start">{t('kds.newTicket')}</span>}
                  <header className="flex flex-wrap items-start justify-between gap-2 border-b border-hair-soft pb-2">
                    <div>
                      <p className="serial text-[1.5rem] font-bold leading-tight">{where}</p>
                      <p className="serial text-[0.8125rem] text-muted">
                        #{tk.order?.orderNumber} · {t('kds.ticket', { n: String(tk.ticketNumber) })}
                        {tk.course > 1 && <> · {t('order.courseN', { n: String(tk.course) })}</>}
                        {!place.station && <> · <span className="text-violet">{tk.station.code}</span></>}
                      </p>
                    </div>
                    <span className={`tag money text-[0.875rem] ${late ? 'tag-warn' : ''}`} aria-label={t('kds.elapsed', { m: String(minutes) })}>
                      {late && `${t('kds.late')} · `}{minutes}:{String(seconds).padStart(2, '0')}
                    </span>
                  </header>
                  <ul className="grid gap-3">
                    {tk.items.map((i) => (
                      <li key={i.id} className="grid gap-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className={`text-[1.125rem] font-semibold leading-snug ${i.status === 'READY' || i.status === 'SERVED' ? 'text-muted' : ''}`}>
                            <span className="money">{i.quantity}×</span> {i.name}
                            {i.seat && <span className="serial ml-2 text-[0.8125rem] text-muted">{t('kds.seat', { n: String(i.seat) })}</span>}
                          </p>
                          <span className={`tag ${i.status === 'READY' ? 'tag-warn' : ''}`}>{i.status === 'FIRED' ? t('kds.new') : t(`item.status.${i.status}` as MessageKey)}</span>
                        </div>
                        {i.modifiers.length > 0 && <p className="text-[1rem]">{i.modifiers.map((m) => m.name).join(' · ')}</p>}
                        {i.note && <p className="text-[1rem] italic">“{i.note}”</p>}
                        {i.status === 'FIRED' && <button type="button" className="btn btn-sm justify-self-start" disabled={busy.current.has(i.id)} onClick={() => void setStatus(i.id, 'IN_PREP')}>{t('kds.start')}</button>}
                        {i.status === 'IN_PREP' && <button type="button" className="btn btn-sm justify-self-start" disabled={busy.current.has(i.id)} onClick={() => void setStatus(i.id, 'READY')}>{t('kds.ready')}</button>}
                      </li>
                    ))}
                  </ul>
                  {waiting && (
                    <button type="button" className="btn btn-primary w-full" disabled={busy.current.has(tk.id)} onClick={() => void bump(tk.id)}>
                      {t('kds.bump')}
                    </button>
                  )}
                </Note>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
