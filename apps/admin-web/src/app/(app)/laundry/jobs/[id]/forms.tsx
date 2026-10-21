'use client';

import { Copy, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import type { GarmentType, JobOrder, LaundryMachine } from '@/lib/api';
import { nextSteps } from '@/lib/laundry';
import type { LaundryOption } from '../../new/job-form';

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const newKey = () => crypto.randomUUID();
/** A datetime-local value for an instant, in the viewer's own clock (the branch is local to them). */
const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Move a job along (§3): every step ahead may be pressed (skipping is allowed); READY back to folding needs a note. */
export function StatusButtons({ jobId, status }: { jobId: string; status: string }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const [back, setBack] = useState(false);
  const steps = nextSteps(status);
  if (!steps.length) return null;
  if (back) {
    return (
      <form
        noValidate
        className="grid w-full gap-2 rounded-[5px] border border-hair bg-white p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await submit('POST', `/api/v1/job-orders/${jobId}/status`, { status: 'FOLDING', note: str(new FormData(e.currentTarget), 'note') });
          if (r.ok) setBack(false);
        }}
      >
        <TextField label={t('lau.backWhy')} name="note" required autoFocus maxLength={200} error={fieldError('note')} />
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={pending}>{t('lau.backToFolding')}</button>
          <button type="button" className="btn" onClick={() => setBack(false)}>{t('common.cancel')}</button>
        </div>
        <FormError message={general(error)} />
      </form>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="status-buttons">
      {steps.map((s) => (
        <button
          key={s}
          type="button"
          className={`btn ${s === 'READY' ? 'btn-primary' : ''}`}
          disabled={pending}
          data-step={s}
          onClick={() => (status === 'READY' ? setBack(true) : void submit('POST', `/api/v1/job-orders/${jobId}/status`, { status: s }))}
        >
          {status === 'READY' ? t('lau.backToFolding') : t(`lau.step.${s}` as MessageKey)}
        </button>
      ))}
      <FormError message={error?.message} />
    </div>
  );
}

/** The "ready for pickup" text for a shop that texts from its own phone (§6). */
export function CopyMessage({ jobId }: { jobId: string }) {
  const { t } = useT();
  const [msg, setMsg] = useState<{ text: string; phone: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="btn"
        onClick={async () => {
          setFailed(null);
          const r = await fetch(`/api/v1/job-orders/${jobId}/message`);
          const body = await r.json().catch(() => null);
          if (!r.ok) return setFailed((body as { error?: { message?: string } } | null)?.error?.message ?? '');
          const m = body as { text: string; phone: string | null };
          setMsg(m);
          try {
            await navigator.clipboard.writeText(m.text);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        <Copy aria-hidden className="size-4" /> {t('lau.copyMessage')}
      </button>
      {msg && (
        <div className="rounded-[5px] border border-hair-soft bg-white p-3 text-[0.9375rem]" data-testid="ready-message">
          <p>{msg.text}</p>
          <p className="mt-1 text-[0.8125rem] text-muted">{copied ? t('lau.copied') : t('lau.copyByHand')}{msg.phone && ` · ${msg.phone}`}</p>
        </div>
      )}
      <FormError message={failed} />
    </div>
  );
}

/** Names, phone, promised time, bags, notes and notices (PATCH; audited). */
export function EditJob({ job }: { job: JobOrder }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure kind="edit" label={t('lau.editJob')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const promised = str(f, 'promisedAt');
            const body: Record<string, unknown> = {
              ...(!job.customerId && { customerName: str(f, 'customerName') || null }),
              customerPhone: str(f, 'customerPhone') || null,
              ...(promised && { promisedAt: new Date(promised).toISOString() }),
              bagCount: Number.parseInt(str(f, 'bagCount') || '1', 10),
              specialInstructions: str(f, 'specialInstructions') || null,
              conditionNotes: str(f, 'conditionNotes') || null,
              notify: f.get('notify') === 'on',
            };
            for (const [k, v] of Object.entries(body)) if (v === (job as unknown as Record<string, unknown>)[k]) delete body[k];
            if (body.promisedAt && new Date(body.promisedAt as string).getTime() === new Date(job.promisedAt).getTime()) delete body.promisedAt;
            if (Object.keys(body).length === 0) return close();
            const r = await submit('PATCH', `/api/v1/job-orders/${job.id}`, body);
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {!job.customerId && <TextField label={t('lau.walkInName')} name="customerName" maxLength={120} defaultValue={job.customerName ?? ''} error={fieldError('customerName')} />}
            <TextField label={t('lau.phone')} name="customerPhone" inputMode="tel" maxLength={20} defaultValue={job.customerPhone ?? ''} error={fieldError('customerPhone')} />
            <TextField label={t('lau.promised')} name="promisedAt" type="datetime-local" defaultValue={localInput(job.promisedAt)} error={fieldError('promisedAt')} />
            <TextField label={t('lau.bags')} name="bagCount" type="number" min={1} max={99} defaultValue={String(job.bagCount)} error={fieldError('bagCount')} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label={t('lau.conditionNotes')} name="conditionNotes" maxLength={500} defaultValue={job.conditionNotes ?? ''} error={fieldError('conditionNotes')} />
            <TextField label={t('lau.instructions')} name="specialInstructions" maxLength={500} defaultValue={job.specialInstructions ?? ''} error={fieldError('specialInstructions')} />
          </div>
          <label className="flex items-start gap-2 text-[0.9375rem]">
            <input type="checkbox" name="notify" defaultChecked={job.notify} className="mt-1 size-4 accent-[var(--color-blue)]" />
            <span>{t('lau.notify')}</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** Re-weigh or change the services (PUT lines): the server prices and freezes them again (§3). */
export function EditLines({ job, services }: { job: JobOrder; services: LaundryOption[] }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const own = job.lines.filter((l) => !l.auto);
  const [rows, setRows] = useState(own.map((l) => ({ key: newKey(), variantId: l.variantId, quantity: l.measuredQuantity, packageId: l.customerPackageId })));
  const [weight, setWeight] = useState(job.weightKg ?? '');
  const known = new Map(services.map((s) => [s.variantId, s.label]));
  for (const l of job.lines) if (!known.has(l.variantId)) known.set(l.variantId, l.name);
  const choices = [...known.entries()];
  return (
    <Disclosure kind="edit" label={t('lau.changeLines')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await submit('PUT', `/api/v1/job-orders/${job.id}/lines`, {
              lines: rows.map((x) => ({ variantId: x.variantId, quantity: x.quantity.trim(), ...(x.packageId && { packageId: x.packageId }) })),
              ...(weight.trim() && { weightKg: weight.trim() }),
            });
            if (r.ok) close();
          }}
        >
          <TextField label={t('lau.weightKg')} name="weightKg" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} error={fieldError('weightKg')} />
          <ul className="flex flex-col gap-2">
            {rows.map((x, i) => (
              <li key={x.key} className="grid items-end gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
                <SelectField label={`${t('lau.service')} ${i + 1}`} name={`edit-line-${i}`} value={x.variantId} onChange={(e) => setRows((rs) => rs.map((r) => (r.key === x.key ? { ...r, variantId: e.target.value, packageId: null } : r)))}>
                  {choices.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </SelectField>
                <TextField label={t('lau.quantity')} name={`edit-qty-${i}`} inputMode="decimal" value={x.quantity} onChange={(e) => setRows((rs) => rs.map((r) => (r.key === x.key ? { ...r, quantity: e.target.value } : r)))} error={fieldError(`lines.${i}.quantity`)} />
                <button type="button" className="btn btn-sm mb-0.5" aria-label={`${t('lau.removeLine')} ${i + 1}`} onClick={() => setRows((rs) => rs.filter((r) => r.key !== x.key))}><X aria-hidden className="size-4" /></button>
              </li>
            ))}
          </ul>
          <div>
            <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, { key: newKey(), variantId: choices[0]?.[0] ?? '', quantity: '1', packageId: null }])}>
              <Plus aria-hidden className="size-3.5" /> {t('lau.addService')}
            </button>
          </div>
          <p className="text-[0.8125rem] text-muted">{t('lau.changeLinesHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending || rows.length === 0}>{t('lau.reprice')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error) ?? fieldError('lines')} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** The pieces counted at drop-off (PUT items). */
export function EditItems({ job, garmentTypes }: { job: JobOrder; garmentTypes: GarmentType[] }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const [rows, setRows] = useState(job.items.map((i) => ({ key: newKey(), garmentTypeId: i.garmentTypeId ?? '', label: i.label, count: String(i.count) })));
  return (
    <Disclosure kind="edit" label={t('lau.changeItems')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await submit('PUT', `/api/v1/job-orders/${job.id}/items`, {
              items: rows.map((x) => ({ ...(x.garmentTypeId ? { garmentTypeId: x.garmentTypeId } : { label: x.label.trim() }), count: Number.parseInt(x.count || '0', 10) })),
            });
            if (r.ok) close();
          }}
        >
          <ul className="flex flex-col gap-2">
            {rows.map((x, i) => (
              <li key={x.key} className="grid items-end gap-2 sm:grid-cols-[minmax(0,2fr)_8rem_auto]">
                {x.garmentTypeId ? <p className="pb-2 font-semibold">{x.label}</p> : <TextField label={t('lau.garment')} name={`it-${i}`} value={x.label} maxLength={60} onChange={(e) => setRows((rs) => rs.map((r) => (r.key === x.key ? { ...r, label: e.target.value } : r)))} error={fieldError(`items.${i}.label`)} />}
                <TextField label={t('lau.count')} name={`ic-${i}`} type="number" min={1} max={999} value={x.count} onChange={(e) => setRows((rs) => rs.map((r) => (r.key === x.key ? { ...r, count: e.target.value } : r)))} error={fieldError(`items.${i}.count`)} />
                <button type="button" className="btn btn-sm mb-0.5" aria-label={`${t('lau.removeLine')} ${x.label}`} onClick={() => setRows((rs) => rs.filter((r) => r.key !== x.key))}><X aria-hidden className="size-4" /></button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {garmentTypes.filter((g) => !rows.some((r) => r.garmentTypeId === g.id)).map((g) => (
              <button key={g.id} type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, { key: newKey(), garmentTypeId: g.id, label: g.name, count: '1' }])}>+ {g.name}</button>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, { key: newKey(), garmentTypeId: '', label: '', count: '1' }])}>+ {t('lau.otherGarment')}</button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** A drop-off load on a washer or dryer (§7); 409 when the machine is busy then. */
export function RunLoad({ jobId, machines }: { jobId: string; machines: LaundryMachine[] }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const usable = machines.filter((m) => !m.outOfOrderReason && !m.archivedAt);
  return (
    <Disclosure label={t('lau.runLoad')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const minutes = str(f, 'minutes');
            const r = await submit('POST', `/api/v1/job-orders/${jobId}/machine-runs`, { machineId: str(f, 'machineId'), ...(minutes && { minutes: Number.parseInt(minutes, 10) }) });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label={t('lau.machine')} name="machineId" error={fieldError('machineId')}>
              {usable.map((m) => <option key={m.id} value={m.id}>{t(`lau.kind.${m.kind}` as MessageKey)} · {m.label} · {t('lau.minutesN', { n: m.cycleMinutes })}</option>)}
            </SelectField>
            <TextField label={`${t('lau.minutes')} (${t('common.optional')})`} name="minutes" type="number" min={1} max={240} hint={t('lau.minutesHint')} error={fieldError('minutes')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending || usable.length === 0}>{t('lau.start')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** A down payment by bank transfer (§5); cash and card are taken at the till's drawer. */
export function ReceiveDownPayment({ jobId }: { jobId: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lau.receiveDeposit')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await submit('POST', `/api/v1/job-orders/${jobId}/deposits`, { method: 'BANK_TRANSFER', amount: str(f, 'depositAmount'), reference: str(f, 'depositReference') }, { idempotencyKey: key });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label={t('lau.depositAmount')} name="depositAmount" inputMode="decimal" required error={fieldError('amount')} />
            <TextField label={t('lau.bankReference')} name="depositReference" required maxLength={64} error={fieldError('reference')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lau.receiveDeposit')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** Give back (part of) the down payment by bank transfer (§5). */
export function RefundDownPayment({ jobId }: { jobId: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lau.refundDeposit')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const amount = str(f, 'refundAmount');
            const r = await submit('POST', `/api/v1/job-orders/${jobId}/deposits/refund`, { ...(amount && { amount }), reason: str(f, 'refundReason'), refund: { method: 'BANK_TRANSFER', reference: str(f, 'refundReference') } }, { idempotencyKey: key });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label={`${t('lau.depositAmount')} (${t('lau.allIfEmpty')})`} name="refundAmount" inputMode="decimal" error={fieldError('amount')} />
            <TextField label={t('common.reason')} name="refundReason" required maxLength={200} error={fieldError('reason')} />
            <TextField label={t('lau.bankReference')} name="refundReference" required maxLength={64} error={fieldError('refund.reference')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lau.refundDeposit')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** Cancel before the claim (§9): the down payment back by bank transfer, or kept (`laundry.dispose`). */
export function CancelJob({ jobId, held, canForfeit }: { jobId: string; held: boolean; canForfeit: boolean }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  const [deposit, setDeposit] = useState<'refund' | 'forfeit'>('refund');
  return (
    <Disclosure label={t('lau.cancelJob')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await submit('POST', `/api/v1/job-orders/${jobId}/cancel`, {
              reason: str(f, 'cancelReason'),
              deposit,
              ...(held && deposit === 'refund' && { refund: { method: 'BANK_TRANSFER', reference: str(f, 'cancelReference') } }),
            }, { idempotencyKey: key });
            if (r.ok) close();
          }}
        >
          <TextField label={t('common.reason')} name="cancelReason" required maxLength={200} autoFocus error={fieldError('reason')} />
          {held && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-[0.8125rem] font-semibold">{t('lau.downPayment')}</legend>
              <label className="flex items-center gap-2 text-[0.9375rem]"><input type="radio" name="deposit" checked={deposit === 'refund'} onChange={() => setDeposit('refund')} className="accent-[var(--color-blue)]" /> {t('lau.giveBack')}</label>
              {canForfeit && <label className="flex items-center gap-2 text-[0.9375rem]"><input type="radio" name="deposit" checked={deposit === 'forfeit'} onChange={() => setDeposit('forfeit')} className="accent-[var(--color-blue)]" /> {t('lau.keep')}</label>}
              {deposit === 'refund' && <TextField label={t('lau.bankReference')} name="cancelReference" required maxLength={64} hint={t('lau.cancelRefundHint')} error={fieldError('refund.reference')} />}
            </fieldset>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-danger" disabled={pending}>{t('lau.cancelJob')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

const DISPOSAL = ['DONATED', 'DISCARDED', 'OTHER'] as const;

/** Dispose of unclaimed laundry (§9): only after the unclaimed days and the final notice; the down payment is kept. */
export function DisposeJob({ jobId, held }: { jobId: string; held: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  const [unreachable, setUnreachable] = useState(false);
  return (
    <Disclosure label={t('lau.dispose')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const note = str(f, 'disposeNote');
            const why = str(f, 'unreachableReason');
            const r = await submit(
              'POST',
              `/api/v1/job-orders/${jobId}/dispose`,
              { reason: str(f, 'disposeReason'), ...(note && { note }), ...(unreachable && { customerUnreachable: true, ...(why && { unreachableReason: why }) }) },
              { idempotencyKey: key },
            );
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label={t('common.reason')} name="disposeReason" error={fieldError('reason')}>
              {DISPOSAL.map((d) => <option key={d} value={d}>{t(`lau.disposal.${d}` as MessageKey)}</option>)}
            </SelectField>
            <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="disposeNote" maxLength={200} error={fieldError('note')} />
          </div>
          <label className="flex items-start gap-2 text-[0.9375rem]">
            <input type="checkbox" name="customerUnreachable" checked={unreachable} onChange={(e) => setUnreachable(e.target.checked)} className="mt-1 size-4 accent-[var(--color-blue)]" />
            <span>{t('lau.customerUnreachable')}</span>
          </label>
          {unreachable && (
            <TextField label={t('lau.unreachableReason')} name="unreachableReason" required maxLength={200} hint={t('lau.unreachableHint')} error={fieldError('unreachableReason')} />
          )}
          <p className="text-[0.8125rem] text-muted">{t('lau.disposeHint', { held })}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-danger" disabled={pending}>{t('lau.dispose')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** Schedule a pickup or a delivery for this job (§8). */
export function AddTrip({ jobId, kinds }: { jobId: string; kinds: ('PICKUP' | 'DELIVERY')[] }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  if (!kinds.length) return null;
  return (
    <Disclosure label={t('lau.addTrip')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const s = (k: string) => str(f, k);
            const r = await submit('POST', `/api/v1/job-orders/${jobId}/trips`, {
              kind: s('kind'),
              address: s('address'),
              contactPhone: s('contactPhone'),
              ...(s('contactName') && { contactName: s('contactName') }),
              ...(s('windowStart') && { windowStart: new Date(s('windowStart')).toISOString() }),
              ...(s('windowEnd') && { windowEnd: new Date(s('windowEnd')).toISOString() }),
              ...(s('riderName') && { riderName: s('riderName') }),
            }, { idempotent: true });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField label={t('lau.tripKind')} name="kind">
              {kinds.map((k) => <option key={k} value={k}>{t(`lau.trip.${k}` as MessageKey)}</option>)}
            </SelectField>
            <div className="sm:col-span-2"><TextField label={t('lau.address')} name="address" required maxLength={300} error={fieldError('address')} /></div>
            <TextField label={t('lau.contactPhone')} name="contactPhone" inputMode="tel" required maxLength={20} error={fieldError('contactPhone')} />
            <TextField label={`${t('lau.contactName')} (${t('common.optional')})`} name="contactName" maxLength={120} error={fieldError('contactName')} />
            <TextField label={`${t('lau.rider')} (${t('common.optional')})`} name="riderName" maxLength={80} error={fieldError('riderName')} />
            <TextField label={`${t('lau.windowStart')} (${t('common.optional')})`} name="windowStart" type="datetime-local" error={fieldError('windowStart')} />
            <TextField label={`${t('lau.windowEnd')} (${t('common.optional')})`} name="windowEnd" type="datetime-local" error={fieldError('windowEnd')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lau.addTrip')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/**
 * Change a scheduled trip (§8): address, contact, rider, time window and notes. Only changed fields
 * are sent; a cleared optional field becomes null. The API refuses a trip that is done, failed or cancelled.
 */
export function EditTrip({ trip }: { trip: JobOrder['trips'][number] }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  if (trip.status !== 'SCHEDULED') return null;
  return (
    <Disclosure kind="edit" label={t('lau.editTrip')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          data-edit-trip={trip.id}
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body: Record<string, unknown> = {};
            for (const k of ['address', 'contactPhone'] as const) {
              const v = str(f, k);
              if (v !== (trip[k] ?? '')) body[k] = v;
            }
            for (const k of ['contactName', 'riderName', 'notes'] as const) {
              const v = str(f, k);
              if (v !== (trip[k] ?? '')) body[k] = v || null;
            }
            for (const k of ['windowStart', 'windowEnd'] as const) {
              const v = str(f, k);
              const was = trip[k] ? localInput(trip[k]) : '';
              if (v !== was) body[k] = v ? new Date(v).toISOString() : null;
            }
            if (Object.keys(body).length === 0) return close();
            const r = await submit('PATCH', `/api/v1/laundry/trips/${trip.id}`, body);
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2"><TextField label={t('lau.address')} name="address" required maxLength={300} defaultValue={trip.address ?? ''} autoFocus error={fieldError('address')} /></div>
            <TextField label={t('lau.contactPhone')} name="contactPhone" inputMode="tel" required maxLength={20} defaultValue={trip.contactPhone ?? ''} error={fieldError('contactPhone')} />
            <TextField label={`${t('lau.contactName')} (${t('common.optional')})`} name="contactName" maxLength={120} defaultValue={trip.contactName ?? ''} error={fieldError('contactName')} />
            <TextField label={`${t('lau.rider')} (${t('common.optional')})`} name="riderName" maxLength={80} defaultValue={trip.riderName ?? ''} error={fieldError('riderName')} />
            <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="notes" maxLength={300} defaultValue={trip.notes ?? ''} error={fieldError('notes')} />
            <TextField label={`${t('lau.windowStart')} (${t('common.optional')})`} name="windowStart" type="datetime-local" defaultValue={trip.windowStart ? localInput(trip.windowStart) : ''} error={fieldError('windowStart')} />
            <TextField label={`${t('lau.windowEnd')} (${t('common.optional')})`} name="windowEnd" type="datetime-local" defaultValue={trip.windowEnd ? localInput(trip.windowEnd) : ''} error={fieldError('windowEnd')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/**
 * A trip's actions (§8): a delivery starts (the job goes out with the rider) and fails or is cancelled
 * here; it is done only with the claim at the door (the till). A pickup is marked done or failed.
 */
export function TripActions({ trip }: { trip: { id: string; kind: 'PICKUP' | 'DELIVERY'; status: string; jobStatus?: string } }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const [ask, setAsk] = useState<'failed' | 'cancel' | null>(null);
  if (trip.status !== 'SCHEDULED') return null;
  if (ask) {
    return (
      <form
        noValidate
        className="grid w-full gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await submit('POST', `/api/v1/laundry/trips/${trip.id}/${ask}`, { reason: str(new FormData(e.currentTarget), 'reason') });
          if (r.ok) setAsk(null);
        }}
      >
        <TextField label={t('common.reason')} name="reason" required autoFocus maxLength={200} error={fieldError('reason')} />
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary btn-sm" disabled={pending}>{t(ask === 'failed' ? 'lau.tripFailed' : 'lau.tripCancel')}</button>
          <button type="button" className="btn btn-sm" onClick={() => setAsk(null)}>{t('common.cancel')}</button>
        </div>
        <FormError message={general(error)} />
      </form>
    );
  }
  const outNow = trip.kind === 'DELIVERY' && trip.jobStatus === 'OUT_FOR_DELIVERY';
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-trip-actions={trip.id}>
      {trip.kind === 'PICKUP' && <button type="button" className="btn btn-sm" disabled={pending} onClick={() => void submit('POST', `/api/v1/laundry/trips/${trip.id}/done`, {})}>{t('lau.tripDone')}</button>}
      {trip.kind === 'DELIVERY' && !outNow && trip.jobStatus === 'READY' && <button type="button" className="btn btn-sm" disabled={pending} data-start-trip onClick={() => void submit('POST', `/api/v1/laundry/trips/${trip.id}/start`, {})}>{t('lau.tripStart')}</button>}
      <button type="button" className="btn btn-sm" onClick={() => setAsk('failed')}>{t('lau.tripFailed')}</button>
      <button type="button" className="btn btn-sm" onClick={() => setAsk('cancel')}>{t('lau.tripCancel')}</button>
      <FormError message={error?.message} />
    </div>
  );
}

/** Stop a run early (a machine stopped by hand, or the wrong one started). */
/** Call off a self-service cycle still waiting for its machine (it never runs). */
export function CancelQueuedRun({ runId }: { runId: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-sm" disabled={pending} onClick={() => { if (window.confirm(t('lau.callOffConfirm'))) void submit('POST', `/api/v1/machine-runs/${runId}/stop`, {}); }}>{t('lau.callOff')}</button>
      <FormError message={error?.message} />
    </span>
  );
}

export function StopRun({ runId }: { runId: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-sm" disabled={pending} onClick={() => { if (window.confirm(t('lau.stopConfirm'))) void submit('POST', `/api/v1/machine-runs/${runId}/stop`, {}); }}>{t('lau.stop')}</button>
      <FormError message={error?.message} />
    </span>
  );
}
