'use client';

import { useRouter } from 'next/navigation';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { LineItems, readLines, type VariantOption } from '@/components/line-items';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { Branch, Transfer } from '@/lib/api';
import { qty } from '@/lib/format';

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
