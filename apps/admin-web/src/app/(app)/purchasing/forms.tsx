'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { compact, LineItems, readLines, type VariantOption } from '@/components/line-items';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { Branch, PurchaseOrder, Supplier } from '@/lib/api';
import { qty, signOf } from '@/lib/format';

function Actions({ pending, general, submitLabel, close }: { pending: boolean; general: string | null; submitLabel: string; close: () => void }) {
  const { t } = useT();
  return (
    <div className="col-span-full flex flex-wrap items-center gap-2">
      <button className="btn btn-primary" disabled={pending}>{submitLabel}</button>
      <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
      <FormError message={general} />
    </div>
  );
}

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const orNull = (s: string) => (s === '' ? null : s);
const isZero = (s: string | undefined) => s === undefined || /^0*(\.0*)?$/.test(s);

// ---------------------------------------------------------------- supplier
function SupplierFields({ close }: { close: () => void }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const terms = text(f, 'paymentTermsDays');
    const r = await submit('POST', '/api/v1/suppliers', {
      code: text(f, 'code'),
      name: text(f, 'name'),
      tin: orNull(text(f, 'tin')),
      phone: orNull(text(f, 'phone')),
      email: orNull(text(f, 'email')),
      ...(terms ? { paymentTermsDays: Number(terms) } : {}),
    }, { idempotent: true });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <TextField label={t('pur.supplierName')} name="name" required autoFocus error={fieldError('name')} />
      <TextField label={t('pur.supplierCode')} name="code" required placeholder="SUP-01" error={fieldError('code')} />
      <TextField label={`${t('loc.tin')} (${t('common.optional')})`} name="tin" inputMode="numeric" error={fieldError('tin')} />
      <TextField label={`${t('pur.phone')} (${t('common.optional')})`} name="phone" type="tel" error={fieldError('phone')} />
      <TextField label={`${t('auth.email')} (${t('common.optional')})`} name="email" type="email" error={fieldError('email')} />
      <TextField label={t('pur.terms')} name="paymentTermsDays" inputMode="numeric" placeholder="0" error={fieldError('paymentTermsDays')} />
      <Actions pending={pending} general={general(error)} submitLabel={t('common.create')} close={close} />
    </form>
  );
}

export function AddSupplierForm() {
  const { t } = useT();
  return <Disclosure label={t('pur.addSupplier')}>{(close) => <SupplierFields close={close} />}</Disclosure>;
}

// ---------------------------------------------------------------- purchase order
function OrderFields({ close, branches, suppliers, variants }: { close: () => void; branches: Branch[]; suppliers: Supplier[]; variants: VariantOption[] }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const expectedOn = text(f, 'expectedOn');
    const r = await submit<{ id: string }>('POST', '/api/v1/purchase-orders', {
      branchId: f.get('branchId'),
      supplierId: f.get('supplierId'),
      ...(expectedOn ? { expectedOn } : {}),
      supplierRef: orNull(text(f, 'supplierRef')),
      lines: readLines(f, ['variantId', 'quantity', 'unitCost']),
    }, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      close();
      router.push(`/purchasing/orders/${r.data.id}`);
    }
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <SelectField label={t('pur.supplierOne')} name="supplierId">
        {suppliers.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
      </SelectField>
      <SelectField label={t('common.branch')} name="branchId">
        {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
      </SelectField>
      <TextField label={`${t('pur.expectedOn')} (${t('common.optional')})`} name="expectedOn" type="date" error={fieldError('expectedOn')} />
      <TextField label={`${t('pur.supplierRef')} (${t('common.optional')})`} name="supplierRef" error={fieldError('supplierRef')} />
      <LineItems
        fields={[
          { name: 'variantId', label: t('common.item'), kind: 'select' },
          { name: 'quantity', label: t('common.quantity'), kind: 'decimal', placeholder: '0' },
          { name: 'unitCost', label: t('common.unitCost'), kind: 'decimal', placeholder: '0.00' },
        ]}
        options={variants}
        fieldError={fieldError}
        addLabel={t('common.addLine')}
        removeLabel={t('common.removeLine')}
      />
      <Actions pending={pending} general={general(error) ?? fieldError('lines') ?? null} submitLabel={t('pur.createOrder')} close={close} />
    </form>
  );
}

export function NewOrderForm(props: { branches: Branch[]; suppliers: Supplier[]; variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('pur.newOrder')}>{(close) => <OrderFields close={close} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- receiving
function ReceiveFields({ close, order }: { close: () => void; order: PurchaseOrder }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  const open = order.lines.filter((l) => signOf(l.remainingQuantity) > 0);
  // Rows left at zero are not part of this delivery; `sent[k]` = the row the API's `lines.k` refers to.
  const [sent, setSent] = useState<number[]>([]);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const rows = open.map((l, i) => ({
      row: i,
      line: {
        purchaseOrderLineId: l.id,
        variantId: l.variantId,
        quantity: text(f, `lines.${i}.quantity`) || '0',
        ...compact({ rejectedQuantity: text(f, `lines.${i}.rejectedQuantity`), rejectionReason: text(f, `lines.${i}.rejectionReason`) }),
      },
    }));
    const kept = rows.filter((r) => !(isZero(r.line.quantity) && isZero(r.line.rejectedQuantity)));
    setSent(kept.map((r) => r.row));
    const lines = kept.map((r) => r.line);
    const r = await submit('POST', '/api/v1/goods-receipts', {
      branchId: order.branchId,
      supplierId: order.supplierId,
      purchaseOrderId: order.id,
      supplierInvoiceRef: orNull(text(f, 'supplierInvoiceRef')),
      supplierDeliveryRef: orNull(text(f, 'supplierDeliveryRef')),
      lines,
    }, { idempotencyKey: key });
    if (r.ok) close();
  }
  const lineError = (row: number, field: string) => (sent.includes(row) ? fieldError(`lines.${sent.indexOf(row)}.${field}`) : undefined);
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <p className="-mt-2 text-[0.875rem] text-muted">{t('pur.receiveHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={`${t('pur.invoiceRef')} (${t('common.optional')})`} name="supplierInvoiceRef" error={fieldError('supplierInvoiceRef')} />
        <TextField label={`${t('pur.deliveryRef')} (${t('common.optional')})`} name="supplierDeliveryRef" error={fieldError('supplierDeliveryRef')} />
      </div>
      <ul className="flex flex-col gap-3">
        {open.map((l, i) => (
          <li key={l.id} className="grid gap-2 rounded-[5px] border border-hair-soft p-3 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] sm:items-end">
            <div className="min-w-0">
              <div className="font-semibold">{l.name}</div>
              <div className="serial text-[0.8125rem] text-muted">{l.sku} · {t('pur.remaining')} {qty(l.remainingQuantity)}</div>
            </div>
            <TextField label={t('pur.accept')} name={`lines.${i}.quantity`} inputMode="decimal" defaultValue={qty(l.remainingQuantity).replaceAll(',', '')} error={lineError(i, 'quantity')} />
            <TextField label={t('pur.reject')} name={`lines.${i}.rejectedQuantity`} inputMode="decimal" placeholder="0" error={lineError(i, 'rejectedQuantity')} />
            <TextField label={t('pur.rejectReason')} name={`lines.${i}.rejectionReason`} error={lineError(i, 'rejectionReason')} />
          </li>
        ))}
      </ul>
      <Actions pending={pending} general={general(error) ?? fieldError('lines') ?? null} submitLabel={t('pur.receive')} close={close} />
    </form>
  );
}

export function ReceiveForm({ order }: { order: PurchaseOrder }) {
  const { t } = useT();
  return <Disclosure label={t('pur.receive')}>{(close) => <ReceiveFields close={close} order={order} />}</Disclosure>;
}
