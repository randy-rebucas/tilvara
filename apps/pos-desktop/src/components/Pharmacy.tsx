import { drugLabel, type OfflineEngine, type OfflinePrescription } from '@1pos/pos-offline';
import { toDec } from '@1pos/money';
import { useEffect, useState, type FormEvent } from 'react';
import { useT, type MessageKey } from '../i18n';
import { api, ApiFailure } from '../lib/api';
import type { CounterCustomer, DosageForm, DrugClass, DrugInfo, Equivalents, PrescriptionDetail, PrescriptionSummary } from '../types';
import { errorText } from './Payment';
import { Callout, Field, Money, Note } from './ui';

/**
 * Pharmacies and drugstores at the counter (ADR-0025): the class badge and generic label of a medicine,
 * the prescription a line fills, the pharmacist's approval, equivalents, and the server's refusals in
 * the cashier's words. The server checks everything again; the till only asks for it in good time.
 */

export const DOSAGE_FORMS: readonly DosageForm[] = ['TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'DROPS', 'CREAM', 'OINTMENT', 'INJECTION', 'INHALER', 'SACHET', 'OTHER'];
const RX_CLASSES: readonly DrugClass[] = ['RX', 'ANTIBIOTIC', 'DANGEROUS'];

/** A line whose medicine needs a prescription (Rx, antibiotic, dangerous drug). */
export const needsRx = (drug: Pick<DrugInfo, 'drugClass'> | null | undefined) => Boolean(drug && RX_CLASSES.includes(drug.drugClass));

/** A prescription recorded with this sale (client refs), as the sale and the offline envelope take it. */
export type NewPrescription = OfflinePrescription;

/** Which prescription item a cart line fills: one on record (online), or one recorded with this sale. */
export type LinePrescription =
  | { kind: 'record'; itemId: string; prescriptionId: string; patientName: string; left: string }
  | { kind: 'new'; prescriptionRef: string; itemRef: string };

/** The line's `prescription` as the API takes it. */
export const linePrescriptionBody = (p: LinePrescription) => (p.kind === 'record' ? { itemId: p.itemId } : { prescriptionRef: p.prescriptionRef, itemRef: p.itemRef });

/** A pharmacist's approval at the till (POST /v1/pharmacy/dispense-approvals): used once, by the next sale. */
export interface DispenseApproval {
  id: string;
  approvedByName: string;
  allowsDangerous: boolean;
}

/** Rx, Antibiotic or DD next to a medicine; nothing for an over-the-counter one. */
export function DrugBadge({ drugClass }: { drugClass: DrugClass | null | undefined }) {
  const { t } = useT();
  if (!drugClass || drugClass === 'OTC') return null;
  const tone = drugClass === 'DANGEROUS' ? 'tag-bad' : drugClass === 'ANTIBIOTIC' ? 'tag-warn' : '';
  return (
    <span className={`tag ${tone}`} title={t(`rx.badgeTitle.${drugClass}` as MessageKey)} data-testid="drug-badge" data-class={drugClass}>
      {t(`rx.badge.${drugClass}` as MessageKey)}
    </span>
  );
}

/** "Amoxicillin 500 mg capsule" under the brand, with its badge. */
export function DrugLine({ drug }: { drug: Pick<DrugInfo, 'drugClass' | 'genericName' | 'strength' | 'dosageForm'> }) {
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted" data-testid="drug-generic">
      <span>{drugLabel(drug)}</span>
      <DrugBadge drugClass={drug.drugClass} />
    </p>
  );
}

const sameMedicine = (a: { genericName: string; strength: string | null; dosageForm: string }, b: { genericName: string; strength: string | null; dosageForm: string }) =>
  drugLabel(a).toLowerCase().replace(/\s+/g, ' ') === drugLabel(b).toLowerCase().replace(/\s+/g, ' ');

/** A cart line as the prescription panel needs it. */
export interface RxLine {
  id: string;
  name: string;
  quantity: string;
  drug: DrugInfo;
  prescription?: LinePrescription | undefined;
}

type Mode = 'record' | 'sale' | 'new';

/**
 * The prescription for one medicine line: one of the customer's open prescriptions (online), one
 * recorded with this sale (several lines may share it), or a new one written in generic names. Offline
 * only a new one: the till has no patient data, so a refill needs the connection.
 */
export function PrescriptionPanel({ line, others, customer, branchId, offline, prescriptions, today, onPick, onRecord, onAddItem, onCancel }: {
  line: RxLine;
  /** The cart's other medicine lines without a prescription: offered on a new one too. */
  others: RxLine[];
  customer: CounterCustomer | null;
  branchId: string;
  offline: boolean;
  /** Prescriptions recorded with this sale so far. */
  prescriptions: NewPrescription[];
  /** The branch's calendar date (YYYY-MM-DD): the default date issued. */
  today: string;
  onPick: (p: LinePrescription) => void;
  /** A new prescription, and the lines (by id) it fills with which of its items. */
  onRecord: (p: NewPrescription, fills: Record<string, string>) => void;
  /** This line fills an item to add to a prescription recorded with this sale. */
  onAddItem: (prescriptionRef: string, item: NewPrescription['items'][number]) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [mode, setMode] = useState<Mode>(prescriptions.length ? 'sale' : !offline && customer ? 'record' : 'new');
  const modes: [Mode, MessageKey][] = [
    ...(!offline ? ([['record', 'rx.fromRecord']] as [Mode, MessageKey][]) : []),
    ...(prescriptions.length ? ([['sale', 'rx.fromSale']] as [Mode, MessageKey][]) : []),
    ['new', 'rx.new'],
  ];
  return (
    <div className="mt-3 grid gap-3 rounded-[5px] border border-hair bg-white p-4" data-testid="rx-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">{t('rx.panelTitle', { name: line.name })}</p>
        <button type="button" className="btn btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      <p className="text-[0.8125rem] text-muted">{drugLabel(line.drug)} · {t('rx.lineQty', { qty: line.quantity })}</p>
      {modes.length > 1 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('rx.panelTitle', { name: line.name })}>
          {modes.map(([m, label]) => (
            <button key={m} type="button" className="btn btn-sm" aria-pressed={mode === m} data-mode={m} onClick={() => setMode(m)}>{t(label)}</button>
          ))}
        </div>
      )}
      {offline && <Callout kind="info">{t('rx.offlineNoRefill')}</Callout>}
      {mode === 'record' && !offline && <OnRecord line={line} customer={customer} branchId={branchId} onPick={onPick} />}
      {mode === 'sale' && <FromSale line={line} prescriptions={prescriptions} onPick={onPick} onAddItem={onAddItem} />}
      {mode === 'new' && <NewPrescriptionForm line={line} others={others} customer={customer} offline={offline} count={prescriptions.length} today={today} onRecord={onRecord} />}
    </div>
  );
}

/** The customer's open prescriptions at this branch's company, then an item with something left. */
function OnRecord({ line, customer, branchId, onPick }: { line: RxLine; customer: CounterCustomer | null; branchId: string; onPick: (p: LinePrescription) => void }) {
  const { t } = useT();
  const [list, setList] = useState<PrescriptionSummary[] | null>(null);
  const [open, setOpen] = useState<PrescriptionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!customer) return;
    let live = true;
    api<{ data: PrescriptionSummary[] }>('GET', `/v1/customers/${customer.id}/prescriptions?branchId=${branchId}`)
      .then((r) => live && setList(r.data))
      .catch((err) => live && setError(errorText(err, t('common.error'), t('common.network'))));
    return () => {
      live = false;
    };
  }, [customer?.id, branchId]);
  async function show(id: string) {
    try {
      setOpen(await api<PrescriptionDetail>('GET', `/v1/prescriptions/${id}`));
      setError(null);
    } catch (err) {
      setError(errorText(err, t('common.error'), t('common.network')));
    }
  }
  if (!customer) return <p className="text-[0.875rem] text-muted">{t('rx.noCustomer')}</p>;
  if (error) return <Callout kind="error">{error}</Callout>;
  if (!list) return <p className="text-[0.875rem] text-muted">{t('rx.loading')}</p>;
  if (open) {
    const items = open.items.filter((i) => toDec(i.left).gt(0));
    const matching = items.filter((i) => sameMedicine(i, line.drug));
    return (
      <div className="grid gap-2" data-testid="rx-record">
        <p className="text-[0.875rem]"><span className="font-semibold">{open.patientName}</span> · {open.prescriberName} · {open.issuedOn}</p>
        {matching.length === 0 && <p className="text-[0.875rem] text-muted">{t('rx.noItemMatch', { generic: drugLabel(line.drug) })}</p>}
        <ul className="grid gap-1">
          {items.map((i) => {
            const fits = sameMedicine(i, line.drug);
            return (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-hair-soft px-2 py-2">
                <span className="min-w-0">
                  <span className="block">{drugLabel(i)}</span>
                  <span className="block text-[0.8125rem] text-muted">{t('rx.left', { left: i.left, quantity: i.quantity })}{i.directions ? ` · ${i.directions}` : ''}</span>
                </span>
                <button type="button" className="btn btn-sm btn-primary" disabled={!fits} data-testid="rx-use-item" onClick={() => onPick({ kind: 'record', itemId: i.id, prescriptionId: open.id, patientName: open.patientName, left: i.left })}>
                  {t('rx.pick')}
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" className="btn btn-sm justify-self-start" onClick={() => setOpen(null)}>{t('common.back')}</button>
      </div>
    );
  }
  if (!list.length) return <p className="text-[0.875rem] text-muted">{t('rx.noneOpen')}</p>;
  return (
    <ul className="grid gap-1" data-testid="rx-list">
      {list.map((p) => (
        <li key={p.id}>
          <button type="button" className="btn h-auto min-h-11 w-full justify-between gap-3 py-2 text-left" data-testid="rx-open" onClick={() => void show(p.id)}>
            <span className="min-w-0">
              <span className="block font-semibold">{p.patientName}</span>
              <span className="block text-[0.8125rem] text-muted">{p.prescriberName} · {p.issuedOn}</span>
            </span>
            <span className="tag shrink-0">{t(p.status === 'PARTLY_FILLED' ? 'rx.status.partly' : 'rx.status.open')}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A prescription recorded with this sale: use one of its items, or add this medicine to it. */
function FromSale({ line, prescriptions, onPick, onAddItem }: { line: RxLine; prescriptions: NewPrescription[]; onPick: (p: LinePrescription) => void; onAddItem: (ref: string, item: NewPrescription['items'][number]) => void }) {
  const { t } = useT();
  const [qty, setQty] = useState(() => linePieces(line));
  return (
    <ul className="grid gap-2" data-testid="rx-sale">
      {prescriptions.map((p) => {
        const fits = p.items.filter((i) => sameMedicine({ genericName: i.genericName, strength: i.strength ?? null, dosageForm: i.dosageForm }, line.drug));
        return (
          <li key={p.ref} className="grid gap-2 rounded border border-hair-soft p-3">
            <p className="text-[0.875rem]"><span className="font-semibold">{p.patientName}</span> · {p.prescriberName}</p>
            {fits.map((i) => (
              <button key={i.ref} type="button" className="btn btn-sm justify-self-start" onClick={() => onPick({ kind: 'new', prescriptionRef: p.ref, itemRef: i.ref })}>
                {t('rx.useItem', { generic: drugLabel({ genericName: i.genericName, strength: i.strength ?? null, dosageForm: i.dosageForm }), quantity: i.quantity })}
              </button>
            ))}
            {fits.length === 0 && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-36">
                  <Field id={`rx-add-qty-${p.ref}`} label={t('rx.quantity')} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
                </div>
                <button
                  type="button"
                  className="btn btn-sm mb-[2px]"
                  disabled={!validPieces(qty)}
                  onClick={() => onAddItem(p.ref, { ref: nextRef(p.items.map((i) => i.ref), 'i'), genericName: line.drug.genericName, strength: line.drug.strength, dosageForm: line.drug.dosageForm as DosageForm, quantity: qty.trim(), drugClass: line.drug.drugClass })}
                >
                  {t('rx.addToThis', { generic: drugLabel(line.drug) })}
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const validPieces = (v: string) => /^\d{1,9}(\.\d{1,3})?$/.test(v.trim()) && toDec(v.trim()).gt(0);
/** "i3": the next free client ref with this prefix (refs are letters, digits, - or _). */
const nextRef = (taken: string[], prefix: string) => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
};

interface ItemRow {
  key: string;
  /** The cart line this row fills (prefilled from it), or none for an item bought another time. */
  lineId: string | null;
  lineName: string | null;
  include: boolean;
  genericName: string;
  strength: string;
  dosageForm: DosageForm;
  drugClass: DrugClass;
  quantity: string;
  directions: string;
}

/**
 * A prescription item counts pieces (ADR-0025 §6), the line counts units of the item sold: a line of
 * 2 boxes of 10 strips of 10 fills 200 pieces. The pieces per unit come with the medicine's details.
 */
export function linePieces(l: Pick<RxLine, 'quantity' | 'drug'>): string {
  try {
    return toDec(l.quantity).times(l.drug.piecesPerUnit ?? '1').toString();
  } catch {
    return l.quantity;
  }
}

const rowFor = (l: RxLine, include: boolean): ItemRow => ({
  key: l.id, lineId: l.id, lineName: l.name, include, genericName: l.drug.genericName, strength: l.drug.strength ?? '',
  dosageForm: (DOSAGE_FORMS.includes(l.drug.dosageForm as DosageForm) ? l.drug.dosageForm : 'OTHER') as DosageForm,
  drugClass: l.drug.drugClass, quantity: linePieces(l), directions: '',
});

/** A new prescription, written as the doctor wrote it: patient, prescriber, PRC licence, date, items in generic names. */
function NewPrescriptionForm({ line, others, customer, offline, count, today, onRecord }: { line: RxLine; others: RxLine[]; customer: CounterCustomer | null; offline: boolean; count: number; today: string; onRecord: (p: NewPrescription, fills: Record<string, string>) => void }) {
  const { t } = useT();
  const [rows, setRows] = useState<ItemRow[]>(() => [rowFor(line, true), ...others.filter((o) => o.id !== line.id).map((o) => rowFor(o, true))]);
  const [error, setError] = useState<string | null>(null);
  const included = rows.filter((r) => r.include);
  const dangerous = included.some((r) => r.drugClass === 'DANGEROUS');
  const patch = (key: string, p: Partial<ItemRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    const head = { patientName: get('rxPatient'), patientAddress: get('rxAddress'), prescriberName: get('rxPrescriber'), prescriberLicenseNo: get('rxLicence'), prescriberS2No: get('rxS2'), yellowFormNo: get('rxYellow'), issuedOn: get('rxIssued'), notes: get('rxNotes') };
    if (!head.patientName || !head.prescriberName || head.prescriberLicenseNo.length < 3 || !/^\d{4}-\d{2}-\d{2}$/.test(head.issuedOn) || !included.length || included.some((r) => !r.genericName.trim() || !validPieces(r.quantity))) {
      return setError(t('rx.invalid'));
    }
    if (dangerous && (!head.prescriberS2No || !head.yellowFormNo || !head.patientAddress)) return setError(t('rx.dangerousMissing'));
    const ref = `rx${count + 1}`;
    const fills: Record<string, string> = {};
    const items = included.map((r, i) => {
      const itemRef = `i${i + 1}`;
      if (r.lineId) fills[r.lineId] = itemRef;
      return {
        ref: itemRef, genericName: r.genericName.trim(), strength: r.strength.trim() || null, dosageForm: r.dosageForm, quantity: r.quantity.trim(), drugClass: r.drugClass,
        ...(r.directions.trim() && { directions: r.directions.trim() }),
      };
    });
    onRecord({
      ref, ...(!offline && customer && { customerId: customer.id }),
      patientName: head.patientName, prescriberName: head.prescriberName, prescriberLicenseNo: head.prescriberLicenseNo, issuedOn: head.issuedOn,
      ...(head.patientAddress && { patientAddress: head.patientAddress }),
      ...(head.prescriberS2No && { prescriberS2No: head.prescriberS2No }),
      ...(head.yellowFormNo && { yellowFormNo: head.yellowFormNo }),
      ...(head.notes && { notes: head.notes }),
      items,
    }, fills);
  }

  return (
    <form className="grid gap-3" onSubmit={submit} autoComplete="off" data-testid="rx-new">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="rxPatient" name="rxPatient" required maxLength={200} label={t('rx.patientName')} defaultValue={customer?.displayName ?? ''} />
        <Field id="rxAddress" name="rxAddress" maxLength={300} required={dangerous} label={t('rx.patientAddress')} />
        <Field id="rxPrescriber" name="rxPrescriber" required maxLength={200} label={t('rx.prescriber')} />
        <Field id="rxLicence" name="rxLicence" required minLength={3} maxLength={30} label={t('rx.licence')} />
        <Field id="rxIssued" name="rxIssued" type="date" required max={today} defaultValue={today} label={t('rx.issuedOn')} />
        <Field id="rxNotes" name="rxNotes" maxLength={1000} label={t('rx.notes')} />
      </div>
      {dangerous && (
        <div className="grid gap-3 rounded-[5px] border border-dashed border-hair p-3">
          <p className="text-[0.8125rem] text-muted">{t('rx.dangerousHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="rxS2" name="rxS2" required maxLength={30} label={t('rx.s2')} />
            <Field id="rxYellow" name="rxYellow" required maxLength={40} label={t('rx.yellowForm')} />
          </div>
        </div>
      )}
      <div className="grid gap-2">
        <p className="font-semibold">{t('rx.items')}</p>
        <p className="text-[0.8125rem] text-muted">{t('rx.itemsHint')}</p>
        {rows.map((r, n) => (
          <fieldset key={r.key} className="grid gap-2 rounded border border-hair-soft p-3" data-testid="rx-item">
            <legend className="sr-only">{r.lineName ?? r.genericName}</legend>
            {r.lineId ? (
              <label className="flex items-start gap-2 text-[0.875rem]">
                <input type="checkbox" className="mt-1" checked={r.include} disabled={r.lineId === line.id} onChange={(e) => patch(r.key, { include: e.target.checked })} />
                <span><span className="font-semibold">{drugLabel({ genericName: r.genericName, strength: r.strength || null, dosageForm: r.dosageForm })}</span> · {t('rx.forLine', { name: r.lineName ?? '' })}</span>
              </label>
            ) : (
              <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
                <Field id={`rxGeneric-${n}`} label={t('rx.generic')} value={r.genericName} maxLength={200} onChange={(e) => patch(r.key, { genericName: e.target.value })} />
                <Field id={`rxStrength-${n}`} label={t('rx.strength')} value={r.strength} maxLength={60} onChange={(e) => patch(r.key, { strength: e.target.value })} />
                <div className="field">
                  <label htmlFor={`rxForm-${n}`}>{t('rx.form')}</label>
                  <select id={`rxForm-${n}`} className="input" value={r.dosageForm} onChange={(e) => patch(r.key, { dosageForm: e.target.value as DosageForm })}>
                    {DOSAGE_FORMS.map((d) => <option key={d} value={d}>{t(`rx.formName.${d}` as MessageKey)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`rxClass-${n}`}>{t('rx.class')}</label>
                  <select id={`rxClass-${n}`} className="input" value={r.drugClass} onChange={(e) => patch(r.key, { drugClass: e.target.value as DrugClass })}>
                    {(['OTC', ...RX_CLASSES.filter((c) => !offline || c !== 'DANGEROUS')] as DrugClass[]).map((c) => <option key={c} value={c}>{t(`rx.className.${c}` as MessageKey)}</option>)}
                  </select>
                </div>
              </div>
            )}
            {r.include && (
              <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
                <Field id={`rxQty-${n}`} label={t('rx.quantity')} inputMode="decimal" value={r.quantity} onChange={(e) => patch(r.key, { quantity: e.target.value })} />
                <Field id={`rxDirections-${n}`} label={t('rx.directions')} maxLength={300} value={r.directions} onChange={(e) => patch(r.key, { directions: e.target.value })} />
              </div>
            )}
            {!r.lineId && <button type="button" className="btn btn-sm btn-danger justify-self-start" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>{t('rx.removeItem')}</button>}
          </fieldset>
        ))}
        <button
          type="button"
          className="btn btn-sm justify-self-start"
          onClick={() => setRows((rs) => [...rs, { key: `extra-${rs.length}-${Date.now()}`, lineId: null, lineName: null, include: true, genericName: '', strength: '', dosageForm: 'TABLET', drugClass: 'RX', quantity: '', directions: '' }])}
        >
          {t('rx.addItem')}
        </button>
      </div>
      {error && <Callout kind="error">{error}</Callout>}
      <button className="btn btn-primary justify-self-start" data-testid="rx-save">{t('rx.save')}</button>
    </form>
  );
}

/**
 * A pharmacist approves dispensing at the till for a cashier who may not (ADR-0025 §6): their own email
 * and password (and code with two-step sign-in), checked once by the server and never kept.
 */
export function ApprovalPanel({ branchId, needsDangerous, onApproved, onCancel }: { branchId: string; needsDangerous: boolean; onApproved: (a: DispenseApproval) => void; onCancel: () => void }) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const code = String(f.get('pharmacistCode') ?? '').trim();
    setBusy(true);
    try {
      const a = await api<{ id: string; approvedByName: string | null; allowsDangerous: boolean }>('POST', '/v1/pharmacy/dispense-approvals', {
        branchId, email: String(f.get('pharmacistEmail') ?? '').trim(), password: String(f.get('pharmacistPassword') ?? ''), ...(code && { code }),
      });
      const name = a.approvedByName ?? '';
      if (needsDangerous && !a.allowsDangerous) return setError(t('rx.notDangerous', { name }));
      onApproved({ id: a.id, approvedByName: name, allowsDangerous: a.allowsDangerous });
    } catch (err) {
      const c = err instanceof ApiFailure ? err.error.code : undefined;
      if (c === 'APPROVER_CODE_REQUIRED') setNeedsCode(true);
      setError(c === 'APPROVER_CODE_REQUIRED' ? t('rx.needCode') : c === 'APPROVER_NOT_ALLOWED' ? t('rx.notPharmacist') : c === 'APPROVER_INVALID_CREDENTIALS' ? t('rx.wrongCredentials') : errorText(err, t('common.error'), t('common.network')));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="no-print grid gap-3 rounded-[5px] border border-hair bg-white p-4" onSubmit={submit} autoComplete="off" data-testid="rx-approval">
      <p className="font-semibold">{t('rx.approvalTitle')}</p>
      <p className="text-[0.8125rem] text-muted">{t('rx.approvalHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="pharmacistEmail" name="pharmacistEmail" type="email" required autoFocus label={t('rx.pharmacistEmail')} autoComplete="off" />
        <Field id="pharmacistPassword" name="pharmacistPassword" type="password" required label={t('rx.pharmacistPassword')} autoComplete="new-password" />
      </div>
      {needsCode && <Field id="pharmacistCode" name="pharmacistCode" inputMode="numeric" required label={t('rx.pharmacistCode')} autoComplete="one-time-code" />}
      {error && <Callout kind="error">{error}</Callout>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy}>{t('rx.approve')}</button>
        <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

/** One item of the same medicine, as the panel shows it (online with stock, offline price only). */
interface Equivalent {
  variantId: string;
  sku: string;
  name: string;
  drugClass: DrugClass | null;
  unitPrice: string | null;
  sellable: string | null;
}

/**
 * Other brands of the line's medicine (same generic, strength and form), cheapest first, to swap the
 * line for (RA 6675). Online from the server with what is sellable here; offline from the till's list.
 */
export function EquivalentsPanel({ branchId, variantId, drug, offline, engine, onSwap, onCancel }: {
  branchId: string;
  variantId: string;
  drug: DrugInfo;
  offline: boolean;
  engine: OfflineEngine | null;
  onSwap: (e: { variantId: string; sku: string }) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [list, setList] = useState<Equivalent[] | null>(null);
  const [generic, setGeneric] = useState<string>(drugLabel(drug));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load: Promise<{ generic: string | null; data: Equivalent[] }> = offline && engine
      ? engine.equivalents(variantId).then((xs) => ({ generic: null, data: xs.map((x) => ({ variantId: x.variantId, sku: x.sku, name: x.name, drugClass: x.drug?.drugClass ?? null, unitPrice: x.unitPrice, sellable: null })) }))
      : api<Equivalents>('GET', `/v1/catalog/equivalents?branchId=${branchId}&variantId=${variantId}`);
    load
      .then((r) => {
        if (!live) return;
        setList(r.data.filter((x) => x.variantId !== variantId));
        if (r.generic) setGeneric(r.generic);
      })
      .catch((err) => live && setError(errorText(err, t('common.error'), t('common.network'))));
    return () => {
      live = false;
    };
  }, [variantId, offline, branchId]);
  return (
    <Note className="mt-3 grid gap-2 p-4" data-testid="equivalents">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">{t('rx.equivTitle', { generic })}</p>
        <button type="button" className="btn btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      {offline && <p className="text-[0.8125rem] text-muted">{t('rx.equivOffline')}</p>}
      {error && <Callout kind="error">{error}</Callout>}
      {list && list.length === 0 && <p className="text-[0.875rem] text-muted">{t('rx.equivNone')}</p>}
      {list && list.length > 0 && (
        <ul className="grid gap-1">
          {list.map((x) => {
            const none = x.sellable !== null && !toDec(x.sellable).gt(0);
            return (
              <li key={x.variantId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-hair-soft px-2 py-2" data-testid="equivalent" data-sku={x.sku}>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2"><span className="font-semibold">{x.name}</span><DrugBadge drugClass={x.drugClass} /></span>
                  <span className="block text-[0.8125rem] text-muted">
                    <span className="serial">{x.sku}</span>
                    {x.sellable !== null && <> · {none ? t('rx.outOfStock') : t('rx.inStock', { n: x.sellable })}</>}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {x.unitPrice ? <Money value={x.unitPrice} /> : <span className="text-muted">{t('rx.noPrice')}</span>}
                  <button type="button" className="btn btn-sm btn-primary" disabled={none || !x.unitPrice} onClick={() => onSwap({ variantId: x.variantId, sku: x.sku })}>{t('rx.swap')}</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Note>
  );
}

/** Pharmacy refusals (ADR-0025) in the cashier's words; null when the error is not one of them. */
export function pharmacyErrorText(err: unknown, t: (k: MessageKey, v?: Record<string, string>) => string, lineName: (index: number) => string): string | null {
  if (!(err instanceof ApiFailure)) return null;
  const d = err.error.details ?? {};
  const name = typeof d.line === 'number' ? lineName(d.line) : '';
  switch (err.error.code) {
    case 'PRESCRIPTION_REQUIRED': return t('rx.err.required', { name });
    case 'PRESCRIPTION_MISMATCH': return t('rx.err.mismatch', { name });
    case 'PRESCRIPTION_EXCEEDED': return t('rx.err.exceeded', { left: String(d.left ?? '0') });
    case 'PRESCRIPTION_VOIDED': return t('rx.err.voided');
    case 'WRONG_LEGAL_ENTITY': return t('rx.err.entity');
    case 'DANGEROUS_DRUG_FULL_FILL': return t('rx.err.fullFill', { prescribed: String(d.prescribed ?? '') });
    case 'YELLOW_FORM_USED': return t('rx.err.yellowUsed');
    case 'PRESCRIPTION_UNUSED': return t('rx.err.unused');
    case 'PURCHASE_BOOKLET_REQUIRED': return t('rx.err.booklet');
    case 'DANGEROUS_DRUG_OFFLINE': return t('rx.err.offline');
    case 'DISPENSE_APPROVAL_REQUIRED': return t('rx.approvalNeeded');
    case 'DISPENSE_APPROVAL_INVALID': return t('rx.err.approvalInvalid');
    case 'EXPIRED_STOCK': {
      const lines = Array.isArray(d.lines) ? (d.lines as { name?: string; sellable?: string }[]) : [];
      return t('rx.err.expired', { items: lines.map((l) => (l.sellable && toDec(l.sellable).gt(0) ? `${l.name ?? ''} (${t('rx.sellableN', { n: l.sellable })})` : (l.name ?? ''))).join(', ') });
    }
    default:
      return err.error.code.startsWith('LOT_') ? err.error.message : null;
  }
}
