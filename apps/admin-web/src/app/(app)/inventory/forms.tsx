'use client';

import { useRouter } from 'next/navigation';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { LineItems, readLines, type VariantOption } from '@/components/line-items';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { Branch, Transfer } from '@/lib/api';
import { qty } from '@/lib/format';

const orNull = (s: string) => (s === '' ? null : s);

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

function Actions({ pending, general, submitLabel, close }: { pending: boolean; general: string | null | undefined; submitLabel: string; close: () => void }) {
  const { t } = useT();
  return (
    <div className="col-span-full flex flex-wrap items-center gap-2">
      <button className="btn btn-primary" disabled={pending}>{submitLabel}</button>
      <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
      <FormError message={general} />
    </div>
  );
}

// ---------------------------------------------------------------- adjustment / waste
/**
 * Correct stock by hand (ADJUSTMENT: a signed change) or write off spoiled stock (WASTE: the
 * quantity thrown away, sent negative). One document, one journal entry, one key per open form.
 */
function AdjustFields({ close, branchId, variants, dated }: { close: () => void; branchId: string; variants: VariantOption[]; dated: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError: apiFieldError, error } = useSubmit();
  // The API's paths are `items.<i>.<field>`; the rows are named `lines.<i>.<field>`.
  const fieldError = (path: string) => apiFieldError(path.replace(/^lines\./, 'items.'));
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const kind = f.get('kind') === 'WASTE' ? 'WASTE' : 'ADJUSTMENT';
    const items = readLines(f, ['variantId', 'quantity', 'expiresOn', 'lotCode']).map((l) => {
      const quantity = kind === 'WASTE' && l.quantity && !l.quantity.startsWith('-') ? `-${l.quantity}` : l.quantity;
      // A date only on stock coming in (ADR-0020): it makes an expiry lot, with its lot code when one is given.
      const inbound = l.expiresOn && !quantity?.startsWith('-');
      return { variantId: l.variantId, quantity, ...(inbound ? { expiresOn: l.expiresOn, ...(l.lotCode && { lotCode: l.lotCode }) } : {}) };
    });
    const r = await submit<{ id: string }>('POST', '/api/v1/stock/adjustments', { branchId, kind, reason: text(f, 'reason'), items }, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      close();
      router.push(`/inventory/adjustments/${r.data.id}`);
    }
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <p className="col-span-full -mt-2 text-[0.875rem] text-muted">{t('inv.adjustHint')}</p>
      <SelectField label={t('inv.adjustKind')} name="kind">
        <option value="ADJUSTMENT">{t('inv.adjustKind.ADJUSTMENT')}</option>
        <option value="WASTE">{t('inv.adjustKind.WASTE')}</option>
      </SelectField>
      <TextField label={t('common.reason')} name="reason" required error={fieldError('reason')} />
      <LineItems
        fields={[
          { name: 'variantId', label: t('common.item'), kind: 'select' },
          { name: 'quantity', label: t('inv.adjustQty'), kind: 'decimal', placeholder: '-1' },
          // Only a shop with items that keep expiry dates sees the date and lot (ADR-0020).
          ...(dated
            ? [
                { name: 'expiresOn', label: `${t('inv.adjustExpires')} (${t('common.optional')})`, kind: 'date' as const },
                { name: 'lotCode', label: t('inv.adjustLot'), kind: 'text' as const },
              ]
            : []),
        ]}
        options={variants}
        fieldError={fieldError}
        addLabel={t('common.addLine')}
        removeLabel={t('common.removeLine')}
      />
      <Actions pending={pending} general={general(error) ?? apiFieldError('items')} submitLabel={t('inv.adjustSave')} close={close} />
    </form>
  );
}

export function AdjustStockForm(props: { branchId: string; variants: VariantOption[]; dated: boolean }) {
  const { t } = useT();
  return <Disclosure label={t('inv.adjust')}>{(close) => <AdjustFields close={close} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- reorder point
function ReorderFields({ close, branchId, variants }: { close: () => void; branchId: string; variants: VariantOption[] }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const point = text(f, 'reorderPoint');
    const amount = text(f, 'reorderQuantity');
    const r = await submit('PUT', '/api/v1/stock/reorder-points', {
      branchId,
      items: [{ variantId: f.get('variantId'), reorderPoint: point === '' ? null : point, ...(point && amount ? { reorderQuantity: amount } : {}) }],
    });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <div className="sm:col-span-2">
        <SelectField label={t('common.item')} name="variantId">
          {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </SelectField>
      </div>
      <TextField label={t('inv.reorderPoint')} name="reorderPoint" inputMode="decimal" hint={t('inv.reorderHint')} error={fieldError('items.0.reorderPoint')} />
      <TextField label={`${t('inv.reorderQty')} (${t('common.optional')})`} name="reorderQuantity" inputMode="decimal" error={fieldError('items.0.reorderQuantity')} />
      <Actions pending={pending} general={general(error)} submitLabel={t('common.save')} close={close} />
    </form>
  );
}

export function ReorderForm(props: { branchId: string; variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('inv.setReorder')}>{(close) => <ReorderFields close={close} {...props} />}</Disclosure>;
}

/** Stop watching an item's stock level at this branch (the point is removed, not set to zero). */
export function RemoveReorderPoint({ branchId, variantId, name }: { branchId: string; variantId: string; name: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn h-8 px-2.5 text-[0.8125rem]"
        disabled={pending}
        aria-label={`${t('inv.removeReorder')}: ${name}`}
        onClick={() => void submit('PUT', '/api/v1/stock/reorder-points', { branchId, items: [{ variantId, reorderPoint: null }] })}
      >
        {t('inv.removeReorder')}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}

// ---------------------------------------------------------------- transfer
function TransferFields({ close, from, destinations, variants }: { close: () => void; from: Branch; destinations: Branch[]; variants: VariantOption[] }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const notes = text(f, 'notes');
    const r = await submit<{ id: string }>('POST', '/api/v1/stock/transfers', {
      fromBranchId: from.id,
      toBranchId: f.get('toBranchId'),
      ...(notes ? { notes } : {}),
      lines: readLines(f, ['variantId', 'quantity']),
    }, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      close();
      router.push(`/inventory/transfers/${r.data.id}?branch=${from.id}`);
    }
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      {/* The source is the branch picked above the list; name it so stock never leaves the wrong branch. */}
      <p className="serial col-span-full -mt-2 text-[0.8125rem] text-muted">
        {t('inv.sendFrom')} <span className="font-semibold text-violet">{from.code}</span> · {from.name}
      </p>
      <SelectField label={t('inv.toBranch')} name="toBranchId">
        {destinations.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
      </SelectField>
      <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="notes" error={fieldError('notes')} />
      <LineItems
        fields={[
          { name: 'variantId', label: t('common.item'), kind: 'select' },
          { name: 'quantity', label: t('common.quantity'), kind: 'decimal', placeholder: '0' },
        ]}
        options={variants}
        fieldError={fieldError}
        addLabel={t('common.addLine')}
        removeLabel={t('common.removeLine')}
      />
      <Actions pending={pending} general={general(error) ?? fieldError('lines')} submitLabel={t('inv.dispatch')} close={close} />
    </form>
  );
}

export function TransferForm(props: { from: Branch; destinations: Branch[]; variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('inv.newTransfer')}>{(close) => <TransferFields close={close} {...props} />}</Disclosure>;
}

function ReceiveTransferFields({ close, transfer }: { close: () => void; transfer: Transfer }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const notes = text(f, 'notes');
    const r = await submit('POST', `/api/v1/stock/transfers/${transfer.id}/receive`, {
      ...(notes ? { notes } : {}),
      // Every line is sent in UI order, so `lines.<i>` errors land on the row shown.
      lines: transfer.lines.map((l, i) => {
        const reason = text(f, `lines.${i}.discrepancyReason`);
        return { transferLineId: l.id, receivedQuantity: text(f, `lines.${i}.receivedQuantity`), ...(reason ? { discrepancyReason: reason } : {}) };
      }),
    }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <p className="-mt-2 text-[0.875rem] text-muted">{t('inv.receiveHint')}</p>
      <ul className="flex flex-col gap-3">
        {transfer.lines.map((l, i) => (
          <li key={l.id} className="grid gap-2 rounded-[5px] border border-hair-soft p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)] sm:items-end">
            <div className="min-w-0">
              <div className="font-semibold">{l.name}</div>
              <div className="serial text-[0.8125rem] text-muted">{l.sku} · {t('inv.sent')} {qty(l.quantity)}</div>
            </div>
            <TextField label={t('inv.arrived')} name={`lines.${i}.receivedQuantity`} inputMode="decimal" defaultValue={qty(l.quantity).replaceAll(',', '')} error={fieldError(`lines.${i}.receivedQuantity`)} />
            <TextField label={t('inv.shortReason')} name={`lines.${i}.discrepancyReason`} error={fieldError(`lines.${i}.discrepancyReason`)} />
          </li>
        ))}
      </ul>
      <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="notes" error={fieldError('notes')} />
      <Actions pending={pending} general={general(error)} submitLabel={t('inv.receiveTransfer')} close={close} />
    </form>
  );
}

export function ReceiveTransferForm({ transfer }: { transfer: Transfer }) {
  const { t } = useT();
  return <Disclosure label={t('inv.receiveTransfer')}>{(close) => <ReceiveTransferFields close={close} transfer={transfer} />}</Disclosure>;
}

// ---------------------------------------------------------------- count
function CountFields({ close, branchId, variants }: { close: () => void; branchId: string; variants: VariantOption[] }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const notes = text(f, 'notes');
    const r = await submit<{ id: string }>('POST', '/api/v1/stock/counts', {
      branchId,
      ...(notes ? { notes } : {}),
      lines: readLines(f, ['variantId', 'countedQuantity']),
    }, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      close();
      router.push(`/inventory/counts/${r.data.id}?branch=${branchId}`);
    }
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <p className="col-span-full -mt-2 text-[0.875rem] text-muted">{t('inv.countHint')}</p>
      <LineItems
        fields={[
          { name: 'variantId', label: t('common.item'), kind: 'select' },
          { name: 'countedQuantity', label: t('inv.counted'), kind: 'decimal', placeholder: '0' },
        ]}
        options={variants}
        fieldError={fieldError}
        addLabel={t('common.addLine')}
        removeLabel={t('common.removeLine')}
      />
      <div className="col-span-full">
        <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="notes" error={fieldError('notes')} />
      </div>
      <Actions pending={pending} general={general(error) ?? fieldError('lines')} submitLabel={t('inv.newCount')} close={close} />
    </form>
  );
}

export function CountForm(props: { branchId: string; variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('inv.newCount')}>{(close) => <CountFields close={close} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- reservations (session 20)
/** Set stock aside for a customer or a reason; never more than is available. */
function ReserveFields({ close, branchId, variants }: { close: () => void; branchId: string; variants: VariantOption[] }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const until = text(f, 'expiresOn');
    const r = await submit('POST', '/api/v1/stock/reservations', {
      branchId,
      variantId: f.get('variantId'),
      quantity: text(f, 'quantity'),
      note: text(f, 'note'),
      // Until the end of that day in Manila.
      ...(until ? { expiresAt: `${until}T23:59:59+08:00` } : {}),
    }, { idempotent: true });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <div className="sm:col-span-2">
        <SelectField label={t('common.item')} name="variantId">
          {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </SelectField>
      </div>
      <TextField label={t('common.quantity')} name="quantity" inputMode="decimal" required error={fieldError('quantity')} />
      <TextField label={`${t('inv.reserveUntil')} (${t('common.optional')})`} name="expiresOn" type="date" error={fieldError('expiresAt')} />
      <div className="sm:col-span-2 lg:col-span-4">
        <TextField label={t('inv.reserveFor')} name="note" required maxLength={200} placeholder={t('inv.reserveForHint')} error={fieldError('note')} />
      </div>
      <Actions pending={pending} general={general(error)} submitLabel={t('inv.reserve')} close={close} />
    </form>
  );
}

export function ReserveForm(props: { branchId: string; variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('inv.reserve')}>{(close) => <ReserveFields close={close} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- expiry and packs (ADR-0020)
/** Write off what is left of one lot as waste: a WASTE adjustment that names the lot. */
export function WriteOffLot({ branchId, lot, confirmText }: { branchId: string; lot: { lotId: string; variantId: string; quantity: string }; confirmText: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(confirmText)) return;
          void submit('POST', '/api/v1/stock/adjustments', {
            branchId,
            kind: 'WASTE',
            reason: t('exp.reason'),
            items: [{ variantId: lot.variantId, quantity: `-${lot.quantity}`, lotId: lot.lotId }],
          }, { idempotencyKey: key });
        }}
      >
        {t('exp.writeOff')}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}

function OpenPackFields({ close, branchId, links }: { close: () => void; branchId: string; links: { id: string; label: string }[] }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/v1/stock/pack-openings', { branchId, conversionId: f.get('conversionId'), packs: text(f, 'packs'), reason: text(f, 'reason') }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <div className="sm:col-span-2">
        <SelectField label={t('packs.link')} name="conversionId">
          {links.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </SelectField>
      </div>
      <TextField label={t('packs.count')} name="packs" inputMode="numeric" defaultValue="1" required error={fieldError('packs')} />
      <TextField label={t('common.reason')} name="reason" required error={fieldError('reason')} />
      <Actions pending={pending} general={general(error)} submitLabel={t('packs.open')} close={close} />
    </form>
  );
}

export function OpenPackForm(props: { branchId: string; links: { id: string; label: string }[] }) {
  const { t } = useT();
  return <Disclosure label={t('packs.title')}>{(close) => <OpenPackFields close={close} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- holds on a lot
/** Place a hold on a lot (a recall, a supplier or FDA advisory): one branch or every branch (ADR-0025 §5). */
export function PlaceHold({ variants, branches, initial }: { variants: { id: string; label: string }[]; branches: Branch[]; initial?: { variantId?: string; lotCode?: string } }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lot.placeHold')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const branchId = text(f, 'holdBranchId');
            const r = await submit('POST', '/api/v1/stock/lot-holds', {
              variantId: text(f, 'variantId'),
              lotCode: text(f, 'lotCode'),
              ...(branchId && { branchId }),
              reason: text(f, 'reason'),
              reference: orNull(text(f, 'reference')),
            }, { idempotencyKey: key });
            if (r.ok) close();
          }}
        >
          <div className="sm:col-span-2">
            <SelectField label={t('common.item')} name="variantId" defaultValue={initial?.variantId ?? ''} error={fieldError('variantId')}>
              <option value="" disabled>—</option>
              {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </SelectField>
          </div>
          <TextField label={t('exp.lot')} name="lotCode" required maxLength={64} defaultValue={initial?.lotCode ?? ''} error={fieldError('lotCode')} />
          <SelectField label={t('lot.holdWhere')} name="holdBranchId" defaultValue="" hint={t('lot.holdWhereHint')} error={fieldError('branchId')}>
            <option value="">{t('rep.allBranches')}</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
          </SelectField>
          <div className="sm:col-span-2">
            <TextField label={t('common.reason')} name="reason" required maxLength={200} placeholder={t('lot.holdReasonHint')} error={fieldError('reason')} />
          </div>
          <TextField label={`${t('lot.holdReference')} (${t('common.optional')})`} name="reference" maxLength={100} placeholder="FDA Advisory 2026-123" error={fieldError('reference')} />
          <div className="col-span-full flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lot.placeHold')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}
