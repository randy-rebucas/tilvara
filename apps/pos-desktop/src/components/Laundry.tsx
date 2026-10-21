import { Copy, CreditCard, Printer, QrCode, Search, Timer, Truck, WashingMachine } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toDec } from '@1pos/money';
import { useT, type MessageKey } from '../i18n';
import { api, ApiFailure, uuid } from '../lib/api';
import { isPositive, isZero, parseAmount, peso } from '../lib/money';
import { jobQuantity, stubToPrintable, tagToPrintable, ticketTime } from '../lib/printing';
import { useTill } from '../lib/till';
import type {
  BoardMachine, CounterCustomer, CustomerPackage, JobOrder, JobStatus, JobSummary, JobTicket, LaundryInfo, LaundrySettings, LaundryTrip, MachineBoard, MachineKind,
  PaymentIntent, Receipt as ReceiptData,
} from '../types';
import { CustomerPanel } from './CounterTools';
import { errorText, PaymentPanel, unanswered, usePayment, type Notice } from './Payment';
import { Receipt } from './Receipt';
import type { Shift } from './Registers';
import { Callout, Empty, Field, Money, Note, PaymentTag } from './ui';

type View = 'jobs' | 'new' | 'claim' | 'machines' | 'trips';
const STEPS = ['WASHING', 'DRYING', 'FOLDING', 'READY'] as const;
const OPEN: JobStatus[] = ['RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY', 'OUT_FOR_DELIVERY'];

/** What the server's refusals mean at the laundry counter (the server's own message otherwise). */
const LAUNDRY_ERRORS: Record<string, MessageKey> = {
  CLAIM_CODE_MISMATCH: 'laundry.err.claimCode',
  MACHINE_BUSY: 'laundry.err.machineBusy',
  MACHINE_OUT_OF_ORDER: 'laundry.err.machineOut',
  MACHINE_KIND_MISMATCH: 'laundry.err.machineKind',
  DEPOSIT_EXCEEDS_TOTAL: 'laundry.err.depositExceeds',
  PACKAGE_EXHAUSTED: 'laundry.err.packageExhausted',
  PACKAGE_NEEDS_WHOLE_UNITS: 'laundry.err.packageWhole',
  JOB_NOT_PRICED: 'laundry.err.notPriced',
  JOB_ORDER_ENDED: 'laundry.err.ended',
  INVALID_STATUS_MOVE: 'laundry.err.statusMove',
  INSUFFICIENT_DRAWER_CASH: 'laundry.err.drawerCash',
  REFUND_METHOD_REQUIRED: 'laundry.err.refundMethod',
  SESSION_NOT_OPEN: 'rooms.err.sessionNotOpen',
};

const laundryError = (err: unknown, t: (k: MessageKey, v?: Record<string, string>) => string) => {
  const code = err instanceof ApiFailure ? err.error.code : '';
  return LAUNDRY_ERRORS[code] ? t(LAUNDRY_ERRORS[code]!) : errorText(err, t('common.error'), t('common.network'));
};

/** One Idempotency-Key per attempt: kept when no answer came back, new after any answer (ADR-0009). */
function useAttemptKey() {
  const key = useRef(uuid());
  return {
    get: () => key.current,
    settle: (err?: unknown) => {
      if (!err || !unanswered(err)) key.current = uuid();
    },
  };
}

const STATUS_KEY: Record<JobStatus, MessageKey> = {
  RECEIVED: 'laundry.status.RECEIVED', WASHING: 'laundry.status.WASHING', DRYING: 'laundry.status.DRYING', FOLDING: 'laundry.status.FOLDING',
  READY: 'laundry.status.READY', OUT_FOR_DELIVERY: 'laundry.status.OUT_FOR_DELIVERY', CLAIMED: 'laundry.status.CLAIMED',
  CANCELLED: 'laundry.status.CANCELLED', DISPOSED: 'laundry.status.DISPOSED',
};

function StatusTag({ job }: { job: Pick<JobSummary, 'status' | 'overdue' | 'unclaimed'> }) {
  const { t } = useT();
  return (
    <span className="flex flex-wrap gap-1">
      <span className={`tag ${job.status === 'READY' ? 'border-blue font-semibold text-blue' : ''}`} data-testid="job-status" data-status={job.status}>{t(STATUS_KEY[job.status])}</span>
      {job.overdue && <span className="tag tag-warn">{t('laundry.overdue')}</span>}
      {job.unclaimed && <span className="tag tag-bad">{t('laundry.unclaimed')}</span>}
    </span>
  );
}

const when = (at: string, tz: string) => ticketTime(at, tz);
/** Loads a weight needs at a service's kilos per load (the till suggests it; the person may change it). */
export const loadsFor = (weight: string, kgPerLoad: string | null) => {
  if (!kgPerLoad || !/^\d+(\.\d+)?$/.test(weight) || toDec(weight).lte(0)) return '1';
  return toDec(weight).div(kgPerLoad).ceil().toString();
};

/**
 * Laundry at the counter (ADR-0024): drop-off job orders with a claim stub and a bag tag, down payments
 * at this drawer, the job board (received → ready → claimed, overdue and unclaimed), loads put on a
 * machine, the claim with the deposit applied, the washers and dryers with their timers, and the day's
 * pickups and deliveries. Online only: the server keeps the jobs.
 */
export function Laundry({ shift, permissions, active }: { shift: Shift; permissions: string[]; active: boolean }) {
  const { t } = useT();
  const till = useTill();
  const offline = till.mode === 'ready' && !till.online;
  const canManage = permissions.includes('laundry.manage');
  const canDeliver = permissions.includes('laundry.deliver');
  const [view, setView] = useState<View>(canManage ? 'jobs' : 'trips');
  const [selected, setSelected] = useState<{ id: string; claim?: { code?: string; via?: 'COUNTER' | 'DELIVERY' } } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  if (offline) {
    return (
      <div className="mx-auto grid max-w-[1440px] gap-4 px-4 py-5 sm:px-6">
        <h1 className="text-[1.5rem] font-bold">{t('nav.laundry')}</h1>
        <div data-testid="laundry-offline"><Callout kind="warn">{t('laundry.offline')}</Callout></div>
      </div>
    );
  }

  const views: [View, MessageKey][] = [
    ...(canManage ? ([['jobs', 'laundry.view.jobs'], ['new', 'laundry.view.new'], ['claim', 'laundry.view.claim']] as [View, MessageKey][]) : []),
    ['machines', 'laundry.view.machines'],
    ...(canManage || canDeliver ? ([['trips', 'laundry.view.trips']] as [View, MessageKey][]) : []),
  ];
  const open = (id: string, claim?: { code?: string; via?: 'COUNTER' | 'DELIVERY' }) => {
    setSelected({ id, ...(claim && { claim }) });
    setView('jobs');
  };

  return (
    <div className="mx-auto grid max-w-[1440px] gap-4 px-4 py-5 sm:px-6" data-testid="laundry">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="mr-auto text-[1.5rem] font-bold">{t('nav.laundry')}</h1>
        <nav className="flex flex-wrap gap-1" aria-label={t('nav.laundry')} data-testid="laundry-views">
          {views.map(([v, label]) => (
            <button key={v} type="button" data-view={v} aria-pressed={view === v} className={`btn btn-sm ${view === v ? 'border-blue font-semibold' : ''}`} onClick={() => { setView(v); setNotice(null); }}>
              {t(label)}
            </button>
          ))}
        </nav>
      </div>
      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}
      {view === 'jobs' && (
        <JobsView
          shift={shift} permissions={permissions} active={active} selected={selected} onSelect={setSelected}
          onNotice={setNotice}
        />
      )}
      {view === 'new' && <DropOffForm shift={shift} onDone={(job) => { setNotice({ kind: 'info', text: t('laundry.received', { ref: job.reference }) }); open(job.id); }} onCancel={() => setView('jobs')} />}
      {view === 'claim' && <ClaimLookup shift={shift} onFound={(job, code) => open(job.id, { ...(code && { code }), via: 'COUNTER' })} />}
      {view === 'machines' && <MachinesView branchId={shift.branch.id} canStop={canManage} active={active} />}
      {view === 'trips' && <TripsView shift={shift} active={active} onClaimAtDoor={(jobId) => open(jobId, { via: 'DELIVERY' })} onNotice={setNotice} />}
    </div>
  );
}

// ------------------------------------------------------------------ the job board

type Filter = 'open' | 'READY' | 'overdue' | 'unclaimed';

function JobsView({ shift, permissions, active, selected, onSelect, onNotice }: {
  shift: Shift;
  permissions: string[];
  active: boolean;
  selected: { id: string; claim?: { code?: string; via?: 'COUNTER' | 'DELIVERY' } } | null;
  onSelect: (s: { id: string; claim?: { code?: string; via?: 'COUNTER' | 'DELIVERY' } } | null) => void;
  onNotice: (n: Notice) => void;
}) {
  const { t } = useT();
  const till = useTill();
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const branchId = shift.branch.id;
  const tz = shift.branch.timezone;

  async function load() {
    const params = new URLSearchParams({ branchId, limit: '100' });
    if (filter === 'open') params.set('open', 'true');
    if (filter === 'READY') params.set('status', 'READY');
    if (filter === 'overdue') params.set('overdue', 'true');
    if (filter === 'unclaimed') params.set('unclaimed', 'true');
    if (q.trim()) params.set('q', q.trim());
    try {
      setJobs((await api<{ data: JobSummary[] }>('GET', `/v1/job-orders?${params}`)).data);
    } catch (err) {
      if (unanswered(err)) till.reportUnreachable();
      onNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
  }

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [active, filter, branchId, refresh]);

  const filters: [Filter, MessageKey][] = [['open', 'laundry.filter.open'], ['READY', 'laundry.filter.ready'], ['overdue', 'laundry.filter.overdue'], ['unclaimed', 'laundry.filter.unclaimed']];
  return (
    <div className="grid gap-4">
      {selected && (
        <JobPanel
          key={`${selected.id}:${selected.claim?.via ?? ''}`}
          jobId={selected.id}
          claim={selected.claim}
          shift={shift}
          permissions={permissions}
          onChanged={() => setRefresh((n) => n + 1)}
          onClose={() => onSelect(null)}
        />
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('laundry.filter')}>
          {filters.map(([f, label]) => (
            <button key={f} type="button" className={`btn btn-sm ${filter === f ? 'border-blue font-semibold' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(label)}</button>
          ))}
        </div>
        <form className="ml-auto flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <Field id="jobSearch" label={t('laundry.search')} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          <button className="btn mb-[2px]" aria-label={t('laundry.find')}><Search className="size-4" aria-hidden /></button>
        </form>
      </div>
      {jobs === null ? null : jobs.length === 0 ? (
        <Note><Empty>{t('laundry.noJobs')}</Empty></Note>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="job-board">
          {jobs.map((j) => (
            <li key={j.id}>
              <button
                type="button"
                data-testid="job-card"
                data-ref={j.reference}
                aria-pressed={selected?.id === j.id}
                onClick={() => onSelect(selected?.id === j.id ? null : { id: j.id })}
                className={`grid h-full w-full content-start gap-1 rounded-[6px] border bg-white p-3 text-left hover:border-blue ${selected?.id === j.id ? 'border-blue ring-2 ring-blue' : 'border-hair'}`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="money text-[1.125rem] font-bold">{j.reference}</span>
                  {j.serviceLevel === 'EXPRESS' && <span className="tag tag-warn">{t('laundry.express')}</span>}
                </span>
                <span className="truncate font-semibold">{j.customerDisplayName ?? '—'}</span>
                <StatusTag job={j} />
                <span className="flex justify-between gap-2 text-[0.8125rem] text-muted">
                  <span>{t('laundry.readyBy', { when: when(j.promisedAt, tz) })}</span>
                  <span>{isPositive(j.balance) ? <>{t('laundry.balance')} <Money value={j.balance} /></> : t('laundry.paid')}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one job

function JobPanel({ jobId, claim, shift, permissions, onChanged, onClose }: {
  jobId: string;
  claim?: { code?: string; via?: 'COUNTER' | 'DELIVERY' };
  shift: Shift;
  permissions: string[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [job, setJob] = useState<JobOrder | null>(null);
  const [panel, setPanel] = useState<'deposit' | 'ticket' | 'claim' | 'machine' | 'cancel' | 'back' | null>(claim ? 'claim' : null);
  const [message, setMessage] = useState<{ text: string; phone: string | null; copied: boolean } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  // Claimed on this panel: the claim form stays to show the receipt.
  const [claimedHere, setClaimedHere] = useState(false);
  const canManage = permissions.includes('laundry.manage');
  const tz = shift.branch.timezone;

  async function load() {
    try {
      setJob(await api<JobOrder>('GET', `/v1/job-orders/${jobId}`));
    } catch (err) {
      setNotice({ kind: 'error', text: laundryError(err, t) });
    }
  }
  useEffect(() => {
    void load();
  }, [jobId]);

  const changed = async (text?: string) => {
    if (text) setNotice({ kind: 'info', text });
    await load();
    onChanged();
  };

  async function move(status: (typeof STEPS)[number] | 'FOLDING', note?: string) {
    if (!job) return;
    setBusy(true);
    try {
      await api('POST', `/v1/job-orders/${job.id}/status`, { status, ...(note && { note }) });
      setPanel(null);
      await changed(t('laundry.moved', { ref: job.reference, status: t(STATUS_KEY[status]) }));
    } catch (err) {
      setNotice({ kind: 'error', text: laundryError(err, t) });
    } finally {
      setBusy(false);
    }
  }

  async function copyMessage() {
    if (!job) return;
    try {
      const m = await api<{ text: string; phone: string | null }>('GET', `/v1/job-orders/${job.id}/message`);
      let copied = false;
      try {
        await navigator.clipboard.writeText(m.text);
        copied = true;
      } catch {
        // No clipboard (browser mode without permission): the text is shown to copy by hand.
      }
      setMessage({ ...m, copied });
    } catch (err) {
      setNotice({ kind: 'error', text: laundryError(err, t) });
    }
  }

  if (!job) {
    return <Note className="p-4" data-testid="job-panel">{notice ? <Callout kind={notice.kind}>{notice.text}</Callout> : t('floor.loading')}</Note>;
  }

  const isOpen = OPEN.includes(job.status);
  const at = (STEPS as readonly string[]).indexOf(job.status);
  const next = isOpen && job.status !== 'OUT_FOR_DELIVERY' ? STEPS.filter((_, i) => i > at) : [];
  const onMachine = ['RECEIVED', 'WASHING', 'DRYING'].includes(job.status);
  const liveDelivery = job.trips.find((x) => x.kind === 'DELIVERY' && x.status === 'SCHEDULED');
  return (
    <Note className="grid gap-3 p-4" data-testid="job-panel" aria-label={job.reference}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="flex flex-wrap items-baseline gap-2 text-[1.25rem] font-bold">
            <span className="money">{job.reference}</span>
            {job.serviceLevel === 'EXPRESS' && <span className="tag tag-warn">{t('laundry.express')}</span>}
          </h2>
          <StatusTag job={job} />
          <p className="text-[0.9375rem]">
            <span className="font-semibold">{job.customerDisplayName ?? '—'}</span>
            {job.customerPhone && <span className="serial ml-2 text-muted">{job.customerPhone}</span>}
          </p>
          <p className="text-[0.875rem] text-muted">
            {t('laundry.readyBy', { when: when(job.promisedAt, tz) })} · {t('laundry.bags', { n: String(job.bagCount) })}{job.weightKg ? ` · ${job.weightKg} kg` : ''}
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={onClose}>{t('common.back')}</button>
      </div>

      {job.lines.length === 0 ? (
        <Callout kind="warn">{t('laundry.notPriced')}</Callout>
      ) : (
        <ul className="grid gap-1 border-y border-dashed border-hair py-2" data-testid="job-lines">
          {job.lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-3 text-[0.9375rem]">
              <span>
                {l.name}
                <span className="ml-2 text-[0.8125rem] text-muted">{jobQuantity({ measuredQuantity: l.measuredQuantity, quantity: l.quantity, unit: l.laundryUnit })}{l.customerPackageId ? ` · ${t('laundry.packageSession')}` : ''}</span>
              </span>
              <Money value={l.amountDue} />
            </li>
          ))}
        </ul>
      )}
      <dl className="grid gap-0.5 text-[0.9375rem]" data-testid="job-money">
        <div className="flex justify-between"><dt>{t('laundry.total')}</dt><dd><Money value={job.amountDue} /></dd></div>
        {/* A job that has ended owes nothing more: its claim is a sale, a cancel or disposal settled the down payment. */}
        {isOpen && !isZero(job.depositHeld) && <div className="flex justify-between"><dt>{t('laundry.downPayment')}</dt><dd><Money value={job.depositHeld} /></dd></div>}
        {isOpen && <div className="flex justify-between text-[1.0625rem] font-semibold"><dt>{t('laundry.balance')}</dt><dd><Money value={job.balance} /></dd></div>}
        {isOpen && job.storageDays > 0 && <p className="text-[0.875rem] text-muted">{t('laundry.storageDays', { n: String(job.storageDays) })}</p>}
      </dl>
      {(job.items.length > 0 || job.conditionNotes || job.specialInstructions) && (
        <div className="grid gap-1 text-[0.875rem]">
          {job.items.length > 0 && <p data-testid="job-items">{job.items.map((i) => `${i.count} × ${i.label}`).join(', ')}</p>}
          {job.conditionNotes && <p><span className="font-semibold">{t('laundry.condition')}:</span> {job.conditionNotes}</p>}
          {job.specialInstructions && <p><span className="font-semibold">{t('laundry.instructions')}:</span> {job.specialInstructions}</p>}
        </div>
      )}
      {job.trips.filter((x) => x.status === 'SCHEDULED').map((x) => (
        <p key={x.id} className="flex items-center gap-2 text-[0.875rem]"><Truck className="size-4" aria-hidden /> {t(x.kind === 'PICKUP' ? 'laundry.pickup' : 'laundry.delivery')}: {x.address}</p>
      ))}

      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}

      {isOpen && canManage && (
        <div className="flex flex-wrap gap-2" data-testid="job-actions">
          {next.map((s) => (
            <button key={s} type="button" className={`btn ${s === 'READY' ? 'btn-primary' : ''}`} data-step={s} disabled={busy} onClick={() => void move(s)}>{t(`laundry.to.${s}` as MessageKey)}</button>
          ))}
          {job.status === 'READY' && <button type="button" className="btn" onClick={() => setPanel(panel === 'back' ? null : 'back')}>{t('laundry.backToFolding')}</button>}
          {onMachine && <button type="button" className="btn" data-testid="put-on-machine" onClick={() => setPanel(panel === 'machine' ? null : 'machine')}><WashingMachine className="size-4" aria-hidden /> {t('laundry.onMachine')}</button>}
          {isPositive(job.balance) && <button type="button" className="btn" data-testid="take-deposit" onClick={() => setPanel(panel === 'deposit' ? null : 'deposit')}>{t('laundry.takeDeposit')}</button>}
          <button type="button" className="btn" data-testid="print-ticket" onClick={() => setPanel(panel === 'ticket' ? null : 'ticket')}><Printer className="size-4" aria-hidden /> {t('laundry.ticket')}</button>
          {(job.status === 'READY' || job.status === 'OUT_FOR_DELIVERY') && <button type="button" className="btn" data-testid="copy-message" onClick={() => void copyMessage()}><Copy className="size-4" aria-hidden /> {t('laundry.copyMessage')}</button>}
          {job.status !== 'OUT_FOR_DELIVERY' && job.pricedAt && (
            <button type="button" className="btn btn-primary" data-testid="claim-open" onClick={() => setPanel(panel === 'claim' ? null : 'claim')}>{t('laundry.claim')}</button>
          )}
          {job.status !== 'OUT_FOR_DELIVERY' && <button type="button" className="btn btn-danger" onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}>{t('laundry.cancelJob')}</button>}
        </div>
      )}
      {liveDelivery && job.status === 'OUT_FOR_DELIVERY' && claim?.via !== 'DELIVERY' && <Callout kind="info">{t('laundry.outForDelivery')}</Callout>}
      {message && (
        <div className="grid gap-1 rounded-[5px] border border-hair bg-white p-3" data-testid="ready-message">
          <p className="text-[0.8125rem] text-muted">{message.copied ? t('laundry.copied') : t('laundry.copyByHand')}{message.phone ? ` · ${message.phone}` : ''}</p>
          <p className="select-all">{message.text}</p>
        </div>
      )}

      {panel === 'back' && <BackToFolding busy={busy} onSubmit={(note) => void move('FOLDING', note)} />}
      {panel === 'machine' && <PutOnMachine job={job} branchId={shift.branch.id} onDone={(text) => { setPanel(null); void changed(text); }} />}
      {panel === 'deposit' && <DepositForm job={job} shift={shift} onDone={(text) => { setPanel('ticket'); void changed(text); }} />}
      {panel === 'ticket' && <TicketView jobId={job.id} />}
      {panel === 'cancel' && <CancelForm job={job} shift={shift} onDone={(text) => { setPanel(null); void changed(text); }} />}
      {/* Stays up once claimed: it shows the receipt. */}
      {panel === 'claim' && (isOpen || claimedHere) && (
        <ClaimForm job={job} shift={shift} permissions={permissions} code={claim?.code} via={claim?.via ?? 'COUNTER'} onClaimed={() => { setClaimedHere(true); void changed(); }} />
      )}
    </Note>
  );
}

function BackToFolding({ busy, onSubmit }: { busy: boolean; onSubmit: (note: string) => void }) {
  const { t } = useT();
  const [note, setNote] = useState('');
  return (
    <form className="grid gap-2 rounded-[5px] border border-hair bg-white p-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (note.trim()) onSubmit(note.trim()); }}>
      <Field id="backNote" label={t('laundry.backWhy')} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} autoFocus />
      <button className="btn sm:mb-[2px]" disabled={busy || !note.trim()}>{t('laundry.backToFolding')}</button>
    </form>
  );
}

/** A drop-off load on a washer or dryer of this branch (ADR-0024 §7); the job moves along if behind. */
function PutOnMachine({ job, branchId, onDone }: { job: JobOrder; branchId: string; onDone: (text: string) => void }) {
  const { t } = useT();
  const [machines, setMachines] = useState<BoardMachine[] | null>(null);
  const [machineId, setMachineId] = useState('');
  const [minutes, setMinutes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kind: MachineKind = job.status === 'DRYING' ? 'DRYER' : 'WASHER';

  useEffect(() => {
    api<MachineBoard>('GET', `/v1/laundry/machines/board?branchId=${branchId}`).then((b) => {
      setMachines(b.data);
      const first = b.data.find((m) => m.kind === kind && m.status === 'FREE') ?? b.data.find((m) => m.status === 'FREE');
      if (first) {
        setMachineId(first.id);
        setMinutes(String(first.cycleMinutes));
      }
    }, (err) => setError(laundryError(err, t)));
  }, [branchId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!machineId || busy) return;
    setBusy(true);
    try {
      await api('POST', `/v1/job-orders/${job.id}/machine-runs`, { machineId, ...(/^\d+$/.test(minutes) && { minutes: Number(minutes) }) });
      const m = machines?.find((x) => x.id === machineId);
      onDone(t('laundry.started', { ref: job.reference, machine: m?.label ?? '' }));
    } catch (err) {
      setError(laundryError(err, t));
    } finally {
      setBusy(false);
    }
  }

  const usable = (machines ?? []).filter((m) => m.status !== 'OUT_OF_ORDER');
  return (
    <form className="grid gap-2 rounded-[5px] border border-hair bg-white p-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end" onSubmit={(e) => void submit(e)} data-testid="machine-form">
      <div className="field">
        <label htmlFor="jobMachine">{t('laundry.machine')}</label>
        <select id="jobMachine" className="input" value={machineId} onChange={(e) => { setMachineId(e.target.value); const m = usable.find((x) => x.id === e.target.value); if (m) setMinutes(String(m.cycleMinutes)); }}>
          {usable.map((m) => (
            <option key={m.id} value={m.id}>{m.label} · {t(m.kind === 'WASHER' ? 'laundry.washer' : 'laundry.dryer')} · {m.status === 'FREE' ? t('laundry.free') : t('laundry.busy')}</option>
          ))}
        </select>
      </div>
      <Field id="jobMinutes" inputMode="numeric" label={t('laundry.minutes')} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      <button className="btn btn-primary sm:mb-[2px]" disabled={busy || !machineId}>{t('laundry.start')}</button>
      {error && <div className="sm:col-span-3"><Callout kind="error">{error}</Callout></div>}
    </form>
  );
}

/**
 * A down payment at this drawer (§5): cash, or card/QR as a payment of purpose JOB_ORDER recorded on the
 * job. Held as a deposit (not a sale) until the claim applies it.
 */
function DepositForm({ job, shift, onDone }: { job: JobOrder; shift: Shift; onDone: (text: string) => void }) {
  const { t } = useT();
  const [amount, setAmount] = useState('');
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const key = useAttemptKey();
  const intentKey = useRef<{ key: string; method: PaymentIntent['method']; amount: string } | null>(null);
  const txId = useRef(uuid());
  const value = parseAmount(amount);
  const ok = value !== null && isPositive(value);

  async function record(body: Record<string, unknown>, shown: string) {
    setBusy(true);
    try {
      await api('POST', `/v1/job-orders/${job.id}/deposits`, { cashierSessionId: shift.sessionId, ...body }, { 'idempotency-key': key.get() });
      key.settle();
      onDone(t('laundry.depositTaken', { amount: peso(shown), ref: job.reference }));
    } catch (err) {
      key.settle(err);
      setNotice(unanswered(err) ? { kind: 'warn', text: t('rooms.unconfirmed') } : { kind: 'error', text: laundryError(err, t) });
    } finally {
      setBusy(false);
    }
  }

  async function takeElectronic(method: PaymentIntent['method']) {
    if (!ok || busy) return;
    setBusy(true);
    try {
      const k = intentKey.current?.method === method && intentKey.current.amount === value ? intentKey.current.key : uuid();
      intentKey.current = { key: k, method, amount: value! };
      const p = await api<PaymentIntent>('POST', '/v1/payment-intents', { cashierSessionId: shift.sessionId, clientTransactionId: txId.current, method, amount: value, purpose: 'JOB_ORDER' }, { 'idempotency-key': k });
      intentKey.current = null;
      setIntent(p);
      setNotice(p.status === 'FAILED' ? { kind: 'warn', text: t('pay.declined') } : null);
      setBusy(false);
      if (p.status === 'SUCCEEDED') await record({ method: 'INTENT', paymentIntentId: p.id }, p.amount);
    } catch (err) {
      if (!unanswered(err)) intentKey.current = null;
      setNotice(unanswered(err) ? { kind: 'warn', text: t('pay.intentUnconfirmed') } : { kind: 'error', text: laundryError(err, t) });
    } finally {
      setBusy(false);
    }
  }

  async function checkIntent() {
    if (!intent) return;
    try {
      const p = await api<PaymentIntent>('POST', `/v1/payment-intents/${intent.id}/reconcile`);
      setIntent(p);
      if (p.status === 'SUCCEEDED') await record({ method: 'INTENT', paymentIntentId: p.id }, p.amount);
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
  }

  const waiting = intent && (intent.status === 'UNKNOWN' || intent.status === 'PROCESSING');
  return (
    <form className="grid gap-2 rounded-[5px] border border-hair bg-white p-3" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) void record({ method: 'CASH', amount: value }, value!); }} data-testid="deposit-form">
      <Field id="jobDeposit" className="input-money" inputMode="decimal" label={t('laundry.depositAmount')} hint={t('laundry.depositHint', { balance: peso(job.balance) })} value={amount} placeholder="0.00" autoFocus onChange={(e) => setAmount(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" data-testid="deposit-cash" disabled={!ok || busy}>{t('laundry.depositCash')}</button>
        <button type="button" className="btn" disabled={!ok || busy || Boolean(waiting)} onClick={() => void takeElectronic('CARD')}><CreditCard className="size-4" aria-hidden /> {t('pay.card')}</button>
        <button type="button" className="btn" disabled={!ok || busy || Boolean(waiting)} onClick={() => void takeElectronic('QR')}><QrCode className="size-4" aria-hidden /> {t('pay.qr')}</button>
      </div>
      {intent && (
        <p className="flex flex-wrap items-center justify-between gap-2 text-[0.9375rem]">
          <span>{t('pay.paidElectronic', { method: intent.method === 'CARD' ? t('pay.card') : t('pay.qr') })} <PaymentTag status={intent.status} /></span>
          {waiting && <button type="button" className="btn btn-sm" onClick={() => void checkIntent()}>{t('pay.check')}</button>}
          {intent.status === 'SUCCEEDED' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void record({ method: 'INTENT', paymentIntentId: intent.id }, intent.amount)}>{t('rooms.recordPayment')}</button>}
        </p>
      )}
      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}
    </form>
  );
}

/**
 * The customer's stub and the bag tag (§4). In the browser both print on one page; a thermal printer
 * prints them as two slips (cut between).
 */
function TicketView({ jobId }: { jobId: string }) {
  const { t } = useT();
  const till = useTill();
  const [ticket, setTicket] = useState<JobTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const both = useRef<HTMLDivElement>(null);
  const stubRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<JobTicket>('GET', `/v1/job-orders/${jobId}/ticket`).then(setTicket, (err) => setError(laundryError(err, t)));
  }, [jobId]);

  async function print() {
    if (!ticket || !both.current || !stubRef.current || !tagRef.current) return;
    setError(null);
    try {
      if (till.printer.kind === 'browser') await till.printer.print(both.current, stubToPrintable(ticket));
      else {
        await till.printer.print(stubRef.current, stubToPrintable(ticket));
        await till.printer.print(tagRef.current, tagToPrintable(ticket));
      }
    } catch (e) {
      setError(`${t('receipt.printFailed')} (${(e as Error).message})`);
    }
  }

  if (!ticket) return error ? <Callout kind="error">{error}</Callout> : null;
  const s = ticket.stub;
  const g = ticket.tag;
  const tz = s.timezone;
  return (
    <div className="grid gap-3" data-testid="ticket">
      <div ref={both} className="printable grid gap-4 sm:grid-cols-2">
        <div ref={stubRef} className="note w-full max-w-[420px] p-5 font-[family-name:var(--font-serial)] text-[0.875rem]" data-testid="claim-stub">
          <header className="text-center">
            <p className="text-[1.0625rem] font-semibold">{s.business}</p>
            <p>{s.legalName}</p>
            <p>{s.branch}{s.branchAddress ? ` · ${s.branchAddress}` : ''}</p>
            <p className="serial mt-2 font-semibold">{s.notice}</p>
          </header>
          <p className="mt-3 flex items-baseline justify-between border-y border-dashed border-hair py-1">
            <span className="serial text-[1.125rem] font-bold">{s.reference}</span>
            <span className="serial">CLAIM CODE <b data-testid="claim-code" className="text-[1.125rem]">{s.claimCode}</b></span>
          </p>
          <p>Received {ticketTime(s.receivedAt, tz)}</p>
          <p className="font-semibold">{s.serviceLevel === 'EXPRESS' ? 'EXPRESS — ready by' : 'Ready by'} {ticketTime(s.promisedAt, tz)}</p>
          {s.customer && <p>Customer: {s.customer}</p>}
          <p>Bags {s.bagCount}{s.weightKg ? ` · ${s.weightKg} kg` : ''}</p>
          <ul className="mt-2 grid gap-1">
            {s.lines.map((l, i) => (
              <li key={i}>
                <p className="flex justify-between gap-3"><span>{l.name}</span><span className="money">{l.amountDue}</span></p>
                <p className="text-muted">{jobQuantity(l)} × {l.unitPrice}{l.packageSession ? ' · Package session' : ''}</p>
              </li>
            ))}
          </ul>
          <dl className="mt-2 grid gap-0.5 border-t border-dashed border-hair pt-2">
            <div className="flex justify-between font-semibold"><dt>TOTAL</dt><dd><Money value={s.amountDue} /></dd></div>
            {!isZero(s.depositHeld) && <div className="flex justify-between"><dt>Down payment</dt><dd><Money value={s.depositHeld} /></dd></div>}
            <div className="flex justify-between font-semibold" data-testid="stub-balance"><dt>BALANCE AT PICKUP</dt><dd><Money value={s.balance} /></dd></div>
          </dl>
          {s.items.length > 0 && <p className="mt-2">Items ({s.pieces} pcs): {s.items.map((i) => `${i.count} × ${i.label}`).join(', ')}</p>}
          {s.conditionNotes && <p className="mt-1">Condition at drop-off: {s.conditionNotes}</p>}
          {s.specialInstructions && <p className="mt-1">Instructions: {s.specialInstructions}</p>}
          {s.claimPolicy && <p className="mt-2 text-[0.8125rem] text-muted">{s.claimPolicy}</p>}
          <p className="mt-2 text-center text-muted">Bring this stub to claim your laundry.</p>
        </div>
        <div ref={tagRef} className="note w-full max-w-[320px] self-start p-5 font-[family-name:var(--font-serial)] text-[0.875rem]" data-testid="bag-tag">
          <p className="text-center text-[1.5rem] font-bold">{g.reference}</p>
          <p className="serial text-center font-semibold">{g.serviceLevel === 'EXPRESS' ? 'EXPRESS' : 'BAG TAG'}</p>
          {g.customer && <p className="mt-2">{g.customer}</p>}
          <p>Bags {g.bagCount} · {g.pieces} pcs</p>
          <p>Ready by {ticketTime(g.promisedAt, tz)}</p>
          {g.specialInstructions && <p className="mt-1 font-semibold">{g.specialInstructions}</p>}
        </div>
      </div>
      {error && <Callout kind="error">{error}</Callout>}
      <button type="button" className="no-print btn justify-self-start" data-testid="print-stub" onClick={() => void print()}>
        <Printer className="size-4" aria-hidden /> {t('laundry.printTicket')}
      </button>
    </div>
  );
}

/** Cancel before the claim (§9): the down payment goes back in cash from this drawer. */
function CancelForm({ job, shift, onDone }: { job: JobOrder; shift: Shift; onDone: (text: string) => void }) {
  const { t } = useT();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useAttemptKey();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim() || busy) return;
    setBusy(true);
    try {
      await api('POST', `/v1/job-orders/${job.id}/cancel`, {
        reason: reason.trim(), deposit: 'refund', ...(isPositive(job.depositHeld) && { refund: { method: 'CASH', cashierSessionId: shift.sessionId } }),
      }, { 'idempotency-key': key.get() });
      key.settle();
      onDone(isPositive(job.depositHeld) ? t('laundry.cancelledRefund', { ref: job.reference, amount: peso(job.depositHeld) }) : t('laundry.cancelled', { ref: job.reference }));
    } catch (err) {
      key.settle(err);
      setError(unanswered(err) ? t('rooms.unconfirmed') : laundryError(err, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="grid gap-2 rounded-[5px] border border-hair bg-white p-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={(e) => void submit(e)}>
      <Field id="cancelReason" label={t('laundry.cancelWhy')} hint={isPositive(job.depositHeld) ? t('laundry.cancelRefundHint', { amount: peso(job.depositHeld) }) : undefined} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus />
      <button className="btn btn-danger sm:mb-[26px]" disabled={busy || !reason.trim()}>{t('laundry.cancelJob')}</button>
      {error && <div className="sm:col-span-2"><Callout kind="error">{error}</Callout></div>}
    </form>
  );
}

// ------------------------------------------------------------------ the claim

/**
 * The claim (§4, §5): the claim code from the stub (or a manager's override with what was checked), the
 * balance after the down payment (plus any storage fee) paid at this drawer, recorded as a sale; the
 * receipt shows the down payment as a tender. At the door (§8) the rider's claim needs no code.
 */
function ClaimForm({ job, shift, permissions, code: given, via, onClaimed }: {
  job: JobOrder;
  shift: Shift;
  permissions: string[];
  code?: string;
  via: 'COUNTER' | 'DELIVERY';
  onClaimed: () => void;
}) {
  const { t } = useT();
  const till = useTill();
  const [code, setCode] = useState(given ?? '');
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [fee, setFee] = useState('0.00');
  const [notice, setNotice] = useState<Notice>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const canOverride = permissions.includes('laundry.release_override');
  const door = via === 'DELIVERY';

  // The storage fee the claim adds (§9): priced like the server will, from the branch's fee item.
  useEffect(() => {
    if (job.storageDays <= 0) return;
    let live = true;
    void (async () => {
      try {
        const s = await api<LaundrySettings>('GET', `/v1/branches/${job.branchId}/laundry-settings`);
        if (!s.storageFeeVariantId) return;
        const q = await api<{ totals: { amountDue: string } }>('POST', '/v1/tax/quote', { branchId: job.branchId, lines: [{ id: 'storage', variantId: s.storageFeeVariantId, quantity: String(job.storageDays) }] });
        if (live) setFee(q.totals.amountDue);
      } catch {
        // Without the estimate the server's answer (TOTAL_CHANGED or short cash) says what is due.
      }
    })();
    return () => {
      live = false;
    };
  }, [job.id, job.storageDays]);

  const due = toDec(job.balance).plus(fee).toFixed(2);
  const pay = usePayment({ shift, due, setNotice });
  const codeOk = door || (override ? overrideReason.trim().length > 0 : /^[A-Za-z0-9]{6}$/.test(code.trim()));

  async function submit() {
    const saleId = await pay.submit(
      (body, key) =>
        api<{ id: string }>('POST', `/v1/job-orders/${job.id}/claim`, {
          cashierSessionId: shift.sessionId, clientTransactionId: body.clientTransactionId, tenders: body.tenders, releasedVia: via,
          ...(!door && (override ? { overrideReason: overrideReason.trim() } : { claimCode: code.trim().toUpperCase() })),
        }, { 'idempotency-key': key }).catch((err: unknown) => {
          // A refusal the counter knows (a wrong claim code…) reads in its words in the payment's notice.
          const own = err instanceof ApiFailure ? LAUNDRY_ERRORS[err.error.code] : undefined;
          throw own ? new ApiFailure({ ...(err as ApiFailure).error, message: t(own) }) : err;
        }),
      undefined,
      () => till.reportUnreachable(),
    );
    if (!saleId) return;
    try {
      setReceipt(await api<ReceiptData>('GET', `/v1/sales/${saleId}/receipt`));
    } catch (e) {
      setNotice({ kind: 'warn', text: errorText(e, t('common.error'), t('pay.unconfirmed')) });
    }
    onClaimed();
  }

  if (receipt) {
    return (
      <div className="grid gap-3" data-testid="claimed">
        <Callout kind="info">{t('laundry.claimedDone', { ref: job.reference })}</Callout>
        <Receipt data={receipt} />
      </div>
    );
  }

  return (
    <div className="grid gap-3 rounded-[5px] border border-hair bg-white p-3" data-testid="claim-form">
      <p className="section-title">{door ? t('laundry.claimAtDoor') : t('laundry.claim')}</p>
      {!door && !override && (
        <Field id="claimCode" label={t('laundry.claimCode')} hint={t('laundry.claimCodeHint')} value={code} maxLength={6} autoComplete="off" spellCheck={false} className="serial uppercase" onChange={(e) => setCode(e.target.value)} />
      )}
      {!door && canOverride && (
        <label className="flex min-h-10 items-center gap-2 text-[0.9375rem]">
          <input type="checkbox" id="claimOverride" className="size-5" checked={override} onChange={(e) => setOverride(e.target.checked)} /> {t('laundry.noStub')}
        </label>
      )}
      {!door && override && <Field id="overrideReason" label={t('laundry.overrideWhy')} hint={t('laundry.overrideHint')} value={overrideReason} maxLength={200} onChange={(e) => setOverrideReason(e.target.value)} />}
      <dl className="grid gap-0.5 text-[0.9375rem]" data-testid="claim-money">
        <div className="flex justify-between"><dt>{t('laundry.total')}</dt><dd><Money value={job.amountDue} /></dd></div>
        {!isZero(job.depositHeld) && <div className="flex justify-between"><dt>{t('laundry.downPaymentApplied')}</dt><dd>−<Money value={job.depositHeld} /></dd></div>}
        {isPositive(fee) && <div className="flex justify-between"><dt>{t('laundry.storageFee', { n: String(job.storageDays) })}</dt><dd><Money value={fee} /></dd></div>}
        <div className="flex justify-between text-[1.25rem] font-semibold"><dt>{t('laundry.toPay')}</dt><dd><Money value={due} /></dd></div>
      </dl>
      {isPositive(due) ? (
        <PaymentPanel pay={pay} priced submitLabel={t('laundry.release')} onSubmit={() => void submit()} canSubmit={codeOk} />
      ) : (
        <button type="button" className="btn btn-primary min-h-14 justify-self-start px-6" id="pay-submit" disabled={!codeOk || pay.submitting} onClick={() => void submit()}>{t('laundry.release')}</button>
      )}
      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}
    </div>
  );
}

/** Find a job by the stub's claim code or its number (J-000123, or just 123). */
function ClaimLookup({ shift, onFound }: { shift: Shift; onFound: (job: JobOrder, code?: string) => void }) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = q.trim().toUpperCase().replace(/\s+/g, '');
    if (!v) return;
    const byNumber = (n: string) => api<JobOrder>('GET', `/v1/job-orders/lookup?branchId=${shift.branch.id}&number=${Number(n)}`);
    const byCode = () => api<JobOrder>('GET', `/v1/job-orders/lookup?claimCode=${encodeURIComponent(v)}`);
    try {
      const numbered = /^J-?(\d{1,9})$/.exec(v);
      if (numbered) return found(await byNumber(numbered[1]!));
      if (/^[A-Z0-9]{6}$/.test(v)) {
        // Six characters are a claim code; six digits may also be a job number.
        try {
          return found(await byCode(), v);
        } catch (err) {
          if (!(/^\d+$/.test(v) && err instanceof ApiFailure && err.error.status === 404)) throw err;
          return found(await byNumber(v));
        }
      }
      if (/^\d{1,9}$/.test(v)) return found(await byNumber(v));
      setError(t('laundry.notFound'));
    } catch (err) {
      setError(err instanceof ApiFailure && err.error.status === 404 ? t('laundry.notFound') : laundryError(err, t));
    }
  }
  function found(job: JobOrder, code?: string) {
    setError(null);
    onFound(job, code);
  }
  return (
    <Note className="grid gap-3 p-4">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => void submit(e)}>
        <div className="min-w-[14rem] flex-1">
          <Field id="claimLookup" label={t('laundry.lookup')} hint={t('laundry.lookupHint')} value={q} autoFocus autoComplete="off" spellCheck={false} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn btn-primary mb-[26px]">{t('laundry.find')}</button>
      </form>
      {error && <Callout kind="error">{error}</Callout>}
    </Note>
  );
}

// ------------------------------------------------------------------ drop-off

interface ServiceOption {
  variantId: string;
  name: string;
  laundry: LaundryInfo;
}

/** The laundry services and add-ons on the list (machine cycles are sold at Sell), read page by page. */
async function loadServices(): Promise<ServiceOption[]> {
  type Variant = { id: string; name: string | null; archivedAt: string | null; laundryUnit?: LaundryInfo['unit']; laundryMinQuantity?: string | null; laundryKgPerLoad?: string | null; laundryAddon?: boolean; machineKind?: MachineKind | null; machineMinutes?: number | null };
  type Product = { name: string; archivedAt: string | null; variants: Variant[] };
  const out: ServiceOption[] = [];
  let cursor: string | null = null;
  const q = (x: string | null | undefined) => (x == null ? null : x.includes('.') ? x.replace(/0+$/, '').replace(/\.$/, '') : x);
  for (let page = 0; page < 10; page++) {
    const r: { data: Product[]; nextCursor: string | null } = await api('GET', `/v1/products?limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    for (const p of r.data) {
      if (p.archivedAt) continue;
      for (const v of p.variants) {
        if (v.archivedAt || v.machineKind || (!v.laundryUnit && !v.laundryAddon)) continue;
        out.push({
          variantId: v.id, name: v.name ? `${p.name} — ${v.name}` : p.name,
          laundry: { unit: v.laundryUnit ?? null, minQuantity: q(v.laundryMinQuantity), kgPerLoad: q(v.laundryKgPerLoad), addon: Boolean(v.laundryAddon), machineKind: null, machineMinutes: null },
        });
      }
    }
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface DraftLine {
  key: string;
  variantId: string;
  name: string;
  laundry: LaundryInfo;
  quantity: string;
  /** Edited by hand: a weight change no longer moves it. */
  touched: boolean;
  packageId?: string;
}

interface TripDraft {
  address: string;
  contactPhone: string;
  riderName: string;
}

const isQty = (v: string) => /^\d{1,6}(\.\d{1,3})?$/.test(v.trim()) && toDec(v.trim()).gt(0);

/**
 * Taking in a job (§3): who it is for (a customer, or a walk-in's name and phone for the notice), the
 * weight and bags, the services (a per-kilo line takes the weight, a per-load line the loads it makes)
 * and add-ons, the items counted and their condition, regular or express, pickup and delivery.
 */
function DropOffForm({ shift, onDone, onCancel }: { shift: Shift; onDone: (job: JobOrder) => void; onCancel: () => void }) {
  const { t } = useT();
  const [services, setServices] = useState<ServiceOption[] | null>(null);
  const [garments, setGarments] = useState<{ id: string; name: string }[]>([]);
  const [customer, setCustomer] = useState<CounterCustomer | null>(null);
  const [picking, setPicking] = useState(false);
  const [packages, setPackages] = useState<CustomerPackage[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [weight, setWeight] = useState('');
  const [bags, setBags] = useState('1');
  const [express, setExpress] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [items, setItems] = useState<{ key: string; garmentTypeId?: string; label: string; count: string }[]>([]);
  const [instructions, setInstructions] = useState('');
  const [condition, setCondition] = useState('');
  const [notify, setNotify] = useState(true);
  const [pickup, setPickup] = useState<TripDraft | null>(null);
  const [delivery, setDelivery] = useState<TripDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useAttemptKey();

  useEffect(() => {
    loadServices().then(setServices, (err) => setError(laundryError(err, t)));
    api<{ data: { id: string; name: string }[] }>('GET', '/v1/laundry/garment-types').then((r) => setGarments(r.data), () => setGarments([]));
  }, []);
  useEffect(() => {
    if (!customer) {
      setPackages([]);
      return;
    }
    api<{ data: CustomerPackage[] }>('GET', `/v1/customers/${customer.id}/packages?open=true`).then((r) => setPackages(r.data), () => setPackages([]));
  }, [customer?.id]);

  // A new weight moves the lines nobody changed by hand: kilos take it, loads follow it.
  function changeWeight(w: string) {
    setWeight(w);
    setLines((ls) => ls.map((l) => (l.touched ? l : { ...l, quantity: quantityFor(l.laundry, w) })));
  }
  const quantityFor = (info: LaundryInfo, w: string) => (info.unit === 'KG' ? (isQty(w) ? w.trim() : '') : info.unit === 'LOAD' ? loadsFor(w, info.kgPerLoad) : '1');

  function addService(s: ServiceOption) {
    setLines((ls) => {
      const existing = ls.find((l) => l.variantId === s.variantId);
      if (existing && s.laundry.unit !== 'KG') return ls.map((l) => (l === existing ? { ...l, quantity: toDec(l.quantity || '0').plus(1).toString(), touched: true } : l));
      if (existing) return ls;
      return [...ls, { key: uuid(), variantId: s.variantId, name: s.name, laundry: s.laundry, quantity: quantityFor(s.laundry, weight), touched: false }];
    });
  }
  const setLine = (k: string, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const packageFor = (l: DraftLine) =>
    l.laundry.unit === 'LOAD' || l.laundry.unit === 'PIECE'
      ? packages.find((p) => !p.expired && p.services.some((x) => x.variantId === l.variantId && x.sessionsLeft >= Number(l.quantity || '0')))
      : undefined;

  const main = (services ?? []).filter((s) => !s.laundry.addon);
  const addons = (services ?? []).filter((s) => s.laundry.addon);
  const tripOk = (d: TripDraft | null) => d === null || (d.address.trim().length > 0 && /^\+?[0-9 ()-]{7,20}$/.test(d.contactPhone.trim()));
  const linesOk = lines.every((l) => isQty(l.quantity) && (!l.packageId || toDec(l.quantity).isInteger()));
  const ok = (customer !== null || name.trim().length > 0) && (phone.trim() === '' || /^\+?[0-9 ()-]{7,20}$/.test(phone.trim())) && (lines.length > 0 || pickup !== null)
    && linesOk && (weight.trim() === '' || isQty(weight)) && /^\d{1,2}$/.test(bags) && Number(bags) >= 1 && tripOk(pickup) && tripOk(delivery)
    && items.every((i) => i.label.trim() && /^\d{1,3}$/.test(i.count) && Number(i.count) >= 1);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    const trip = (d: TripDraft) => ({ address: d.address.trim(), contactPhone: d.contactPhone.trim(), ...(d.riderName.trim() && { riderName: d.riderName.trim() }) });
    try {
      const job = await api<JobOrder>('POST', '/v1/job-orders', {
        branchId: shift.branch.id,
        ...(customer ? { customerId: customer.id } : { customerName: name.trim() }),
        ...(phone.trim() && { customerPhone: phone.trim() }),
        serviceLevel: express ? 'EXPRESS' : 'REGULAR',
        ...(weight.trim() && { weightKg: weight.trim() }),
        bagCount: Number(bags),
        ...(instructions.trim() && { specialInstructions: instructions.trim() }),
        ...(condition.trim() && { conditionNotes: condition.trim() }),
        notify,
        lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity.trim(), ...(l.packageId && { packageId: l.packageId }) })),
        items: items.map((i) => ({ ...(i.garmentTypeId ? { garmentTypeId: i.garmentTypeId } : { label: i.label.trim() }), count: Number(i.count) })),
        ...(pickup && { pickup: trip(pickup) }),
        ...(delivery && { delivery: trip(delivery) }),
      }, { 'idempotency-key': key.get() });
      key.settle();
      onDone(job);
    } catch (err) {
      key.settle(err);
      setError(unanswered(err) ? t('rooms.unconfirmed') : laundryError(err, t));
    } finally {
      setBusy(false);
    }
  }

  const minHint = (l: DraftLine) => (l.laundry.minQuantity ? t(l.laundry.unit === 'KG' ? 'laundry.minKg' : 'laundry.minUnits', { n: l.laundry.minQuantity }) : null);
  const belowMin = (l: DraftLine) => Boolean(l.laundry.minQuantity && isQty(l.quantity) && toDec(l.quantity).lt(l.laundry.minQuantity) && !l.packageId);
  return (
    <form className="grid gap-4" onSubmit={(e) => void submit(e)} data-testid="drop-off" autoComplete="off">
      <Note className="grid gap-3 p-4">
        <h2 className="section-title">{t('laundry.who')}</h2>
        {customer ? (
          <p className="flex flex-wrap items-center gap-2" data-testid="drop-off-customer">
            <span className="font-semibold">{customer.displayName}</span>
            {customer.phone && <span className="serial text-muted">{customer.phone}</span>}
            <button type="button" className="btn btn-sm" onClick={() => setCustomer(null)}>{t('laundry.removeCustomer')}</button>
          </p>
        ) : picking ? (
          <CustomerPanel canAdd={false} onPick={(c) => { setCustomer(c); setPicking(false); if (c.phone && !phone) setPhone(c.phone); }} onCancel={() => setPicking(false)} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field id="walkInName" label={t('laundry.name')} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            <Field id="walkInPhone" type="tel" label={t('laundry.phone')} hint={t('laundry.phoneHint')} value={phone} onChange={(e) => setPhone(e.target.value)} />
            <button type="button" className="btn sm:mb-[26px]" onClick={() => setPicking(true)}>{t('laundry.findCustomer')}</button>
          </div>
        )}
        {customer && <Field id="walkInPhone" type="tel" label={t('laundry.phone')} hint={t('laundry.phoneHint')} value={phone} onChange={(e) => setPhone(e.target.value)} />}
      </Note>

      <Note className="grid gap-3 p-4">
        <h2 className="section-title">{t('laundry.whatToDo')}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[10rem_8rem_1fr] sm:items-end">
          <Field id="weightKg" inputMode="decimal" label={t('laundry.weight')} value={weight} placeholder="0.0" onChange={(e) => changeWeight(e.target.value)} />
          <Field id="bagCount" inputMode="numeric" label={t('laundry.bagCount')} value={bags} onChange={(e) => setBags(e.target.value)} />
          <label className="col-span-2 flex min-h-12 items-center gap-2 sm:col-span-1">
            <input type="checkbox" id="express" className="size-5" checked={express} onChange={(e) => setExpress(e.target.checked)} /> {t('laundry.expressService')}
          </label>
        </div>
        {services === null ? null : main.length === 0 ? (
          <Callout kind="warn">{t('laundry.noServices')}</Callout>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="service-buttons">
            {main.map((s) => (
              <button key={s.variantId} type="button" className="btn btn-sm" data-variant={s.variantId} onClick={() => addService(s)}>{s.name}</button>
            ))}
          </div>
        )}
        {addons.length > 0 && (
          <div className="grid gap-1">
            <p className="text-[0.8125rem] text-muted">{t('laundry.addons')}</p>
            <div className="flex flex-wrap gap-2" data-testid="addon-buttons">
              {addons.map((s) => (
                <button key={s.variantId} type="button" className="btn btn-sm" data-variant={s.variantId} onClick={() => addService(s)}>+ {s.name}</button>
              ))}
            </div>
          </div>
        )}
        {lines.length > 0 && (
          <ul className="grid gap-2" data-testid="drop-off-lines">
            {lines.map((l) => {
              const pkg = packageFor(l);
              return (
                <li key={l.key} className="row-rule grid gap-2 py-2 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
                  <div>
                    <p className="font-semibold">{l.name}</p>
                    <p className={`text-[0.8125rem] ${belowMin(l) ? 'text-ink' : 'text-muted'}`}>
                      {[minHint(l), belowMin(l) ? t('laundry.minCharged') : null, l.laundry.unit === 'LOAD' && l.laundry.kgPerLoad ? t('laundry.perLoad', { kg: l.laundry.kgPerLoad }) : null].filter(Boolean).join(' · ')}
                    </p>
                    {pkg && !l.packageId && <button type="button" className="btn btn-sm mt-1" onClick={() => setLine(l.key, { packageId: pkg.id })}>{t('laundry.usePackage', { name: pkg.name })}</button>}
                    {l.packageId && <p className="text-[0.8125rem]">{t('laundry.packageSession')} <button type="button" className="btn btn-sm ml-1" onClick={() => setLine(l.key, { packageId: undefined })}>{t('common.cancel')}</button></p>}
                  </div>
                  <Field
                    id={`qty-${l.key}`}
                    inputMode="decimal"
                    label={t(l.laundry.unit === 'KG' ? 'laundry.qtyKg' : l.laundry.unit === 'LOAD' ? 'laundry.qtyLoads' : 'laundry.qty')}
                    value={l.quantity}
                    onChange={(e) => setLine(l.key, { quantity: e.target.value, touched: true })}
                  />
                  <button type="button" className="btn btn-sm sm:mb-[2px]" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>{t('laundry.remove')}</button>
                </li>
              );
            })}
          </ul>
        )}
      </Note>

      <Note className="grid gap-3 p-4">
        <h2 className="section-title">{t('laundry.itemsTitle')}</h2>
        <div className="flex flex-wrap gap-2">
          {garments.map((g) => (
            <button key={g.id} type="button" className="btn btn-sm" onClick={() => setItems((xs) => [...xs, { key: uuid(), garmentTypeId: g.id, label: g.name, count: '1' }])}>+ {g.name}</button>
          ))}
          <button type="button" className="btn btn-sm" data-testid="add-item" onClick={() => setItems((xs) => [...xs, { key: uuid(), label: '', count: '1' }])}>{t('laundry.addItem')}</button>
        </div>
        {items.map((i, n) => (
          <div key={i.key} className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
            <Field id={`itemLabel-${n}`} label={t('laundry.itemLabel')} value={i.label} disabled={Boolean(i.garmentTypeId)} maxLength={60} onChange={(e) => setItems((xs) => xs.map((x) => (x.key === i.key ? { ...x, label: e.target.value } : x)))} />
            <Field id={`itemCount-${n}`} inputMode="numeric" label={t('laundry.itemCount')} value={i.count} onChange={(e) => setItems((xs) => xs.map((x) => (x.key === i.key ? { ...x, count: e.target.value } : x)))} />
            <button type="button" className="btn btn-sm mb-[2px]" onClick={() => setItems((xs) => xs.filter((x) => x.key !== i.key))}>{t('laundry.remove')}</button>
          </div>
        ))}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="field">
            <label htmlFor="conditionNotes">{t('laundry.condition')}</label>
            <textarea id="conditionNotes" className="input min-h-20" maxLength={500} value={condition} placeholder={t('laundry.conditionHint')} onChange={(e) => setCondition(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="specialInstructions">{t('laundry.instructions')}</label>
            <textarea id="specialInstructions" className="input min-h-20" maxLength={500} value={instructions} placeholder={t('laundry.instructionsHint')} onChange={(e) => setInstructions(e.target.value)} />
          </div>
        </div>
      </Note>

      <Note className="grid gap-3 p-4">
        <h2 className="section-title">{t('laundry.pickupDelivery')}</h2>
        <TripFields id="pickup" label={t('laundry.wantPickup')} value={pickup} onChange={setPickup} defaultPhone={phone} />
        <TripFields id="delivery" label={t('laundry.wantDelivery')} value={delivery} onChange={setDelivery} defaultPhone={phone} />
        <label className="flex min-h-10 items-center gap-2 text-[0.9375rem]">
          <input type="checkbox" id="notify" className="size-5" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> {t('laundry.notify')}
        </label>
      </Note>

      {error && <Callout kind="error">{error}</Callout>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary min-h-14 px-6 text-[1.0625rem]" data-testid="drop-off-submit" disabled={!ok || busy}>{t('laundry.takeIn')}</button>
        <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

function TripFields({ id, label, value, onChange, defaultPhone }: { id: string; label: string; value: TripDraft | null; onChange: (v: TripDraft | null) => void; defaultPhone: string }) {
  const { t } = useT();
  return (
    <div className="grid gap-2">
      <label className="flex min-h-10 items-center gap-2 text-[0.9375rem]">
        <input type="checkbox" id={`${id}On`} className="size-5" checked={value !== null} onChange={(e) => onChange(e.target.checked ? { address: '', contactPhone: defaultPhone, riderName: '' } : null)} /> {label}
      </label>
      {value && (
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
          <Field id={`${id}Address`} label={t('laundry.address')} value={value.address} maxLength={300} onChange={(e) => onChange({ ...value, address: e.target.value })} />
          <Field id={`${id}Phone`} type="tel" label={t('laundry.contactPhone')} value={value.contactPhone} onChange={(e) => onChange({ ...value, contactPhone: e.target.value })} />
          <Field id={`${id}Rider`} label={t('laundry.rider')} value={value.riderName} maxLength={80} onChange={(e) => onChange({ ...value, riderName: e.target.value })} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ machines

/** Seconds as m:ss (or h:mm:ss). */
export const clock = (s: number) => {
  const v = Math.max(0, Math.round(s));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = String(v % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

/** The branch's washers and dryers (§7): what runs on each and the time left, ticking each second. */
function MachinesView({ branchId, canStop, active }: { branchId: string; canStop: boolean; active: boolean }) {
  const { t } = useT();
  const [board, setBoard] = useState<MachineBoard | null>(null);
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const b = await api<MachineBoard>('GET', `/v1/laundry/machines/board?branchId=${branchId}`);
      // The server's clock, not the device's: time left is counted from the board's own "now".
      setSkew(Date.parse(b.asOf) - Date.now());
      setBoard(b);
      setError(null);
    } catch (err) {
      setError(laundryError(err, t));
    }
  }
  useEffect(() => {
    if (!active) return;
    void load();
    const poll = setInterval(() => void load(), 20_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [active, branchId]);

  async function stop(runId: string) {
    try {
      await api('POST', `/v1/machine-runs/${runId}/stop`);
      await load();
    } catch (err) {
      setError(laundryError(err, t));
    }
  }

  if (!board) return error ? <Callout kind="error">{error}</Callout> : null;
  if (board.data.length === 0) return <Note><Empty>{t('laundry.noMachines')}</Empty></Note>;
  return (
    <div className="grid gap-3">
      {error && <Callout kind="error">{error}</Callout>}
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-testid="machine-board">
        {board.data.map((m) => {
          const left = m.current ? (Date.parse(m.current.endsAt) - (now + skew)) / 1000 : 0;
          const running = m.current !== null && left > 0;
          const state = m.status === 'OUT_OF_ORDER' ? 'OUT_OF_ORDER' : running ? 'RUNNING' : 'FREE';
          const queued = m.nextFreeAt && m.current && Date.parse(m.nextFreeAt) > Date.parse(m.current.endsAt) ? (Date.parse(m.nextFreeAt) - (now + skew)) / 1000 : null;
          return (
            <li key={m.id} className={`grid content-start gap-1 rounded-[6px] border bg-white p-3 ${state === 'RUNNING' ? 'border-blue' : 'border-hair'} ${state === 'OUT_OF_ORDER' ? 'opacity-70' : ''}`} data-testid="machine-card" data-label={m.label} data-state={state}>
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[1.0625rem] font-bold">{m.label}</span>
                <span className="text-[0.75rem] text-muted">{t(m.kind === 'WASHER' ? 'laundry.washer' : 'laundry.dryer')}</span>
              </span>
              {state === 'OUT_OF_ORDER' ? (
                <span className="tag tag-bad justify-self-start">{t('laundry.outOfOrder')}{m.outOfOrderReason ? ` · ${m.outOfOrderReason}` : ''}</span>
              ) : running ? (
                <>
                  <span className="money flex items-center gap-1 text-[1.5rem] font-semibold" data-testid="time-left"><Timer className="size-5" aria-hidden />{clock(left)}</span>
                  <span className="truncate text-[0.8125rem] text-muted">{m.current!.source === 'JOB' ? m.current!.jobReference : t('laundry.selfService', { n: String(m.current!.saleNumber ?? '') })}</span>
                  {queued !== null && <span className="text-[0.8125rem]" data-testid="queued">{t('laundry.freeIn', { time: clock(queued) })}</span>}
                  {canStop && <button type="button" className="btn btn-sm justify-self-start" onClick={() => void stop(m.current!.runId)}>{t('laundry.stop')}</button>}
                </>
              ) : (
                <span className="tag justify-self-start">{t('laundry.free')}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Choosing the machine for a self-service cycle at Sell (§7): free machines of the cycle's kind first;
 * a running one queues the cycle behind what runs on it (a dryer "+10 min"). Without a machine the
 * cycle is sold as an ordinary item.
 */
export function MachinePicker({ branchId, kind, name, onPick, onNone, onCancel }: { branchId: string; kind: MachineKind; name: string; onPick: (m: BoardMachine) => void; onNone: () => void; onCancel: () => void }) {
  const { t } = useT();
  const [machines, setMachines] = useState<BoardMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<MachineBoard>('GET', `/v1/laundry/machines/board?branchId=${branchId}`).then(
      (b) => setMachines(b.data.filter((m) => m.kind === kind).sort((a, c) => (a.status === 'FREE' ? 0 : 1) - (c.status === 'FREE' ? 0 : 1))),
      (err) => setError(laundryError(err, t)),
    );
  }, [branchId, kind]);
  return (
    <Note className="grid gap-3 p-4" data-testid="machine-picker" aria-label={t('laundry.pickMachine')}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="section-title">{t('laundry.pickMachineFor', { name })}</h2>
        <button type="button" className="btn btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      {error && <Callout kind="error">{error}</Callout>}
      {machines && (machines.length === 0 ? <p className="text-muted">{t('laundry.noMachinesOfKind')}</p> : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {machines.map((m) => (
            <li key={m.id}>
              <button type="button" className="grid w-full gap-1 rounded-[6px] border border-hair bg-white p-3 text-left hover:border-blue disabled:opacity-60" data-machine={m.label} disabled={m.status === 'OUT_OF_ORDER'} onClick={() => onPick(m)}>
                <span className="font-semibold">{m.label}</span>
                <span className="text-[0.8125rem] text-muted">
                  {m.status === 'OUT_OF_ORDER' ? t('laundry.outOfOrder') : m.status === 'FREE' ? t('laundry.free') : t('laundry.queuesBehind', { time: m.nextFreeAt ? new Date(m.nextFreeAt).toLocaleTimeString('en-PH', { timeStyle: 'short' }) : '' })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ))}
      <button type="button" className="btn btn-sm justify-self-start" onClick={onNone}>{t('laundry.noMachine')}</button>
    </Note>
  );
}

// ------------------------------------------------------------------ trips

/** The day's pickups and deliveries (§8): the rider leaves, marks a pickup done, a failure, or claims at the door. */
function TripsView({ shift, active, onClaimAtDoor, onNotice }: { shift: Shift; active: boolean; onClaimAtDoor: (jobId: string) => void; onNotice: (n: Notice) => void }) {
  const { t } = useT();
  const [trips, setTrips] = useState<LaundryTrip[] | null>(null);
  const [failing, setFailing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const tz = shift.branch.timezone;

  async function load() {
    try {
      setTrips((await api<{ data: LaundryTrip[] }>('GET', `/v1/laundry/trips?branchId=${shift.branch.id}&status=SCHEDULED`)).data);
    } catch (err) {
      onNotice({ kind: 'error', text: laundryError(err, t) });
    }
  }
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [active, shift.branch.id]);

  async function act(trip: LaundryTrip, action: 'start' | 'done' | 'failed', body?: unknown) {
    try {
      await api('POST', `/v1/laundry/trips/${trip.id}/${action}`, body);
      setFailing(null);
      setReason('');
      onNotice({ kind: 'info', text: t(`laundry.trip.${action}Done` as MessageKey, { ref: trip.jobReference }) });
      await load();
    } catch (err) {
      onNotice({ kind: 'error', text: laundryError(err, t) });
    }
  }

  if (!trips) return null;
  if (trips.length === 0) return <Note><Empty>{t('laundry.noTrips')}</Empty></Note>;
  return (
    <ul className="grid gap-2" data-testid="trips">
      {trips.map((x) => (
        <li key={x.id} className="note grid gap-2 p-3" data-testid="trip" data-ref={x.jobReference} data-kind={x.kind}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="flex items-center gap-2 font-semibold"><Truck className="size-4" aria-hidden /> {t(x.kind === 'PICKUP' ? 'laundry.pickup' : 'laundry.delivery')} · <span className="money">{x.jobReference}</span></span>
            <span className="tag">{t(STATUS_KEY[x.jobStatus])}</span>
          </div>
          <p>{x.customer ?? x.contactName ?? '—'} · <span className="serial">{x.contactPhone}</span></p>
          <p className="text-[0.9375rem]">{x.address}</p>
          <p className="text-[0.8125rem] text-muted">
            {x.windowStart ? `${when(x.windowStart, tz)}${x.windowEnd ? ` – ${when(x.windowEnd, tz)}` : ''} · ` : ''}{t('laundry.bags', { n: String(x.bagCount) })}
            {x.kind === 'DELIVERY' && isPositive(x.balance) ? <> · {t('laundry.collect')} <Money value={x.balance} /></> : null}
            {x.riderName ? ` · ${x.riderName}` : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            {x.kind === 'PICKUP' && <button type="button" className="btn btn-sm btn-primary" onClick={() => void act(x, 'done')}>{t('laundry.trip.pickedUp')}</button>}
            {x.kind === 'DELIVERY' && x.jobStatus === 'READY' && <button type="button" className="btn btn-sm btn-primary" data-testid="trip-start" onClick={() => void act(x, 'start')}>{t('laundry.trip.leave')}</button>}
            {x.kind === 'DELIVERY' && x.jobStatus === 'OUT_FOR_DELIVERY' && <button type="button" className="btn btn-sm btn-primary" data-testid="trip-claim" onClick={() => onClaimAtDoor(x.jobOrderId)}>{t('laundry.claimAtDoor')}</button>}
            <button type="button" className="btn btn-sm" onClick={() => setFailing(failing === x.id ? null : x.id)}>{t('laundry.trip.failed')}</button>
          </div>
          {failing === x.id && (
            <form className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) void act(x, 'failed', { reason: reason.trim() }); }}>
              <Field id={`failReason-${x.id}`} label={t('laundry.trip.why')} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus />
              <button className="btn btn-sm btn-danger sm:mb-[2px]" disabled={!reason.trim()}>{t('laundry.trip.markFailed')}</button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}
