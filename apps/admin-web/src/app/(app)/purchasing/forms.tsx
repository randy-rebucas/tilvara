'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { compact, LineItems, readLines, type VariantOption } from '@/components/line-items';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { Branch, GoodsReceipt, PurchaseOrder, Supplier, SupplierItem } from '@/lib/api';
import { peso, qty, signOf, subtractQty } from '@/lib/format';

function Actions({ pending, general, submitLabel, close }: { pending: boolean; general: string | null; submitLabel: string; close: () => void }) {
  const { t } = useT();
  return (
    <div className="form-actions">
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
/** Add a supplier, or edit one (`supplier` given: PATCH with every field, blanks cleared). */
function SupplierFields({ close, supplier }: { close: () => void; supplier?: Supplier }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const terms = text(f, 'paymentTermsDays');
    const body = {
      code: text(f, 'code'),
      name: text(f, 'name'),
      tin: orNull(text(f, 'tin')),
      phone: orNull(text(f, 'phone')),
      email: orNull(text(f, 'email')),
      ...(terms ? { paymentTermsDays: Number(terms) } : supplier ? { paymentTermsDays: 0 } : {}),
    };
    const r = supplier
      ? await submit('PATCH', `/api/v1/suppliers/${supplier.id}`, body)
      : await submit('POST', '/api/v1/suppliers', body, { idempotent: true });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <TextField span="half" label={t('pur.supplierName')} name="name" required autoFocus defaultValue={supplier?.name} error={fieldError('name')} />
      <TextField span="half" label={t('pur.supplierCode')} name="code" required placeholder="SUP-01" defaultValue={supplier?.code} error={fieldError('code')} />
      <TextField span="half" label={`${t('loc.tin')} (${t('common.optional')})`} name="tin" inputMode="numeric" defaultValue={supplier?.tin ?? ''} error={fieldError('tin')} />
      <TextField span="half" label={`${t('pur.phone')} (${t('common.optional')})`} name="phone" type="tel" defaultValue={supplier?.phone ?? ''} error={fieldError('phone')} />
      <TextField span="half" label={`${t('auth.email')} (${t('common.optional')})`} name="email" type="email" defaultValue={supplier?.email ?? ''} error={fieldError('email')} />
      <TextField span="half" label={t('pur.terms')} name="paymentTermsDays" inputMode="numeric" placeholder="0" defaultValue={supplier ? String(supplier.paymentTermsDays) : undefined} error={fieldError('paymentTermsDays')} />
      <Actions pending={pending} general={general(error)} submitLabel={supplier ? t('common.save') : t('common.create')} close={close} />
    </form>
  );
}

export function AddSupplierForm() {
  const { t } = useT();
  return <Disclosure label={t('pur.addSupplier')}>{(close) => <SupplierFields close={close} />}</Disclosure>;
}

export function EditSupplierForm({ supplier }: { supplier: Supplier }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('pur.editSupplier')}>{(close) => <SupplierFields close={close} supplier={supplier} />}</Disclosure>;
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
      // A blank cost is left out: the supplier's catalog cost is used (session 20).
      lines: readLines(f, ['variantId', 'quantity', 'unitCost']).map(compact),
    }, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      close();
      router.push(`/purchasing/orders/${r.data.id}`);
    }
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <SelectField span="half" label={t('pur.supplierOne')} name="supplierId">
        {suppliers.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
      </SelectField>
      <SelectField span="half" label={t('common.branch')} name="branchId">
        {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
      </SelectField>
      <TextField span="half" label={`${t('pur.expectedOn')} (${t('common.optional')})`} name="expectedOn" type="date" error={fieldError('expectedOn')} />
      <TextField span="half" label={`${t('pur.supplierRef')} (${t('common.optional')})`} name="supplierRef" error={fieldError('supplierRef')} />
      <LineItems
        fields={[
          { name: 'variantId', label: t('common.item'), kind: 'select' },
          { name: 'quantity', label: t('common.quantity'), kind: 'decimal', placeholder: '0' },
          { name: 'unitCost', label: t('common.unitCost'), kind: 'decimal', placeholder: t('pur.catalogCost') },
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
  return <Disclosure wide label={t('pur.newOrder')}>{(close) => <OrderFields close={close} {...props} />}</Disclosure>;
}

/** A draft's supplier, date, reference and lines; the lines sent replace all lines. */
function DraftFields({ close, order, suppliers, variants }: { close: () => void; order: PurchaseOrder; suppliers: Supplier[]; variants: VariantOption[] }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  // An item no longer in the first page of products still shows on its own line.
  const options = [...variants, ...order.lines.filter((l) => !variants.some((v) => v.id === l.variantId)).map((l) => ({ id: l.variantId, label: `${l.sku} · ${l.name}` }))];
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('PATCH', `/api/v1/purchase-orders/${order.id}`, {
      supplierId: f.get('supplierId'),
      expectedOn: orNull(text(f, 'expectedOn')),
      supplierRef: orNull(text(f, 'supplierRef')),
      // A blank cost is left out: the supplier's catalog cost is used (session 20).
      lines: readLines(f, ['variantId', 'quantity', 'unitCost']).map(compact),
    });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <SelectField span="half" label={t('pur.supplierOne')} name="supplierId" defaultValue={order.supplierId}>
        {[...suppliers.filter((s) => s.id !== order.supplierId), order.supplier].map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
      </SelectField>
      <TextField span="quarter" label={`${t('pur.expectedOn')} (${t('common.optional')})`} name="expectedOn" type="date" defaultValue={order.expectedOn ?? ''} error={fieldError('expectedOn')} />
      <TextField span="quarter" label={`${t('pur.supplierRef')} (${t('common.optional')})`} name="supplierRef" defaultValue={order.supplierRef ?? ''} error={fieldError('supplierRef')} />
      <LineItems
        fields={[
          { name: 'variantId', label: t('common.item'), kind: 'select' },
          { name: 'quantity', label: t('common.quantity'), kind: 'decimal', placeholder: '0' },
          { name: 'unitCost', label: t('common.unitCost'), kind: 'decimal', placeholder: t('pur.catalogCost') },
        ]}
        initial={order.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitCost: l.unitCost }))}
        options={options}
        fieldError={fieldError}
        addLabel={t('common.addLine')}
        removeLabel={t('common.removeLine')}
      />
      <Actions pending={pending} general={general(error) ?? fieldError('lines') ?? null} submitLabel={t('common.save')} close={close} />
    </form>
  );
}

export function EditDraftForm(props: { order: PurchaseOrder; suppliers: Supplier[]; variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure wide kind="edit" label={t('pur.editDraft')}>{(close) => <DraftFields close={close} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- supplier return
/** Send back part of a delivery: credited at the receipt's cost; at most what is still returnable. */
function ReturnFields({ close, receipt, names }: { close: () => void; receipt: GoodsReceipt; names: Record<string, { sku: string; name: string }> }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  const open = receipt.lines.filter((l) => signOf(subtractQty(l.quantity, l.returnedQuantity)) > 0);
  const [sent, setSent] = useState<number[]>([]);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const rows = open.map((l, i) => ({ row: i, line: { goodsReceiptLineId: l.id, variantId: l.variantId, quantity: text(f, `lines.${i}.quantity`) } }));
    const kept = rows.filter((r) => !isZero(r.line.quantity || undefined));
    setSent(kept.map((r) => r.row));
    const r = await submit<{ id: string }>('POST', '/api/v1/supplier-returns', {
      branchId: receipt.branchId,
      supplierId: receipt.supplierId,
      goodsReceiptId: receipt.id,
      reason: text(f, 'reason'),
      lines: kept.map((x) => x.line),
    }, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      close();
      router.push(`/purchasing/returns/${r.data.id}`);
    }
  }
  const lineError = (row: number) => (sent.includes(row) ? fieldError(`lines.${sent.indexOf(row)}.quantity`) : undefined);
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <p className="form-lede">{t('pur.returnHint')}</p>
      <TextField label={t('common.reason')} name="reason" required autoFocus error={fieldError('reason')} />
      <ul className="flex flex-col gap-3">
        {open.map((l, i) => (
          <li key={l.id} className="grid gap-2 rounded-[5px] border border-hair-soft p-3 @lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @lg:items-end">
            <div className="min-w-0">
              <div className="font-semibold">{names[l.variantId]?.name ?? '—'}</div>
              <div className="serial text-[0.8125rem] text-muted">
                {names[l.variantId]?.sku} · {t('pur.returnable')} {qty(subtractQty(l.quantity, l.returnedQuantity))} · {peso(l.unitCost)}
              </div>
            </div>
            <TextField label={t('pur.returnQty')} name={`lines.${i}.quantity`} inputMode="decimal" placeholder="0" error={lineError(i)} />
          </li>
        ))}
      </ul>
      <Actions pending={pending} general={general(error) ?? fieldError('lines') ?? null} submitLabel={t('pur.returnToSupplier')} close={close} />
    </form>
  );
}

export function ReturnForm(props: { receipt: GoodsReceipt; names: Record<string, { sku: string; name: string }> }) {
  const { t } = useT();
  return <Disclosure wide label={t('pur.returnToSupplier')}>{(close) => <ReturnFields close={close} {...props} />}</Disclosure>;
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
        ...compact({
          rejectedQuantity: text(f, `lines.${i}.rejectedQuantity`),
          rejectionReason: text(f, `lines.${i}.rejectionReason`),
          expiresOn: text(f, `lines.${i}.expiresOn`),
          lotCode: text(f, `lines.${i}.lotCode`),
        }),
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
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <p className="form-lede">{t('pur.receiveHint')}{open.some((l) => l.tracksExpiry) ? ` ${t('pur.expiresHint')}` : ''}</p>
      <TextField span="half" label={`${t('pur.invoiceRef')} (${t('common.optional')})`} name="supplierInvoiceRef" error={fieldError('supplierInvoiceRef')} />
      <TextField span="half" label={`${t('pur.deliveryRef')} (${t('common.optional')})`} name="supplierDeliveryRef" error={fieldError('supplierDeliveryRef')} />
      <ul className="flex flex-col gap-3">
        {open.map((l, i) => (
          <li key={l.id} className={`grid gap-2 rounded-[5px] border border-hair-soft p-3 @lg:grid-cols-2 @3xl:items-end ${l.tracksExpiry ? '@3xl:grid-cols-[minmax(0,2fr)_repeat(5,minmax(0,1fr))]' : '@3xl:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]'}`}>
            <div className="min-w-0">
              <div className="font-semibold">{l.name}</div>
              <div className="serial text-[0.8125rem] text-muted">{l.sku} · {t('pur.remaining')} {qty(l.remainingQuantity)}</div>
            </div>
            <TextField label={t('pur.accept')} name={`lines.${i}.quantity`} inputMode="decimal" defaultValue={qty(l.remainingQuantity).replaceAll(',', '')} error={lineError(i, 'quantity')} />
            <TextField label={t('pur.reject')} name={`lines.${i}.rejectedQuantity`} inputMode="decimal" placeholder="0" error={lineError(i, 'rejectedQuantity')} />
            <TextField label={t('pur.rejectReason')} name={`lines.${i}.rejectionReason`} error={lineError(i, 'rejectionReason')} />
            {/* ADR-0020: only an item that keeps expiry dates asks for one (required); its lot code is optional. */}
            {l.tracksExpiry && (
              <>
                <TextField label={t('pur.expiresOn')} name={`lines.${i}.expiresOn`} type="date" error={lineError(i, 'expiresOn')} />
                <TextField label={t('inv.adjustLot')} name={`lines.${i}.lotCode`} maxLength={40} error={lineError(i, 'lotCode')} />
              </>
            )}
          </li>
        ))}
      </ul>
      <Actions pending={pending} general={general(error) ?? fieldError('lines') ?? null} submitLabel={t('pur.receive')} close={close} />
    </form>
  );
}

export function ReceiveForm({ order }: { order: PurchaseOrder }) {
  const { t } = useT();
  return <Disclosure wide label={t('pur.receive')}>{(close) => <ReceiveFields close={close} order={order} />}</Disclosure>;
}

/**
 * A delivery that came without a purchase order: every line at the cost typed (the API requires it).
 * The expiry and lot columns show only when some item keeps expiry dates (`dated`); the API asks for
 * the date on exactly those items.
 */
function UnorderedReceiptFields({ close, branches, suppliers, variants, dated }: { close: () => void; branches: Branch[]; suppliers: Supplier[]; variants: VariantOption[]; dated: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit<{ id: string }>('POST', '/api/v1/goods-receipts', {
      branchId: f.get('branchId'),
      supplierId: f.get('supplierId'),
      supplierInvoiceRef: orNull(text(f, 'supplierInvoiceRef')),
      supplierDeliveryRef: orNull(text(f, 'supplierDeliveryRef')),
      lines: readLines(f, dated ? ['variantId', 'quantity', 'unitCost', 'expiresOn', 'lotCode'] : ['variantId', 'quantity', 'unitCost']).map(compact),
    }, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      close();
      router.push(`/purchasing/receipts/${r.data.id}`);
    }
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <p className="form-lede">{t('pur.receiveNoOrderHint')}{dated ? ` ${t('pur.expiresHint')}` : ''}</p>
      <SelectField span="half" label={t('pur.supplierOne')} name="supplierId">
        {suppliers.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
      </SelectField>
      <SelectField span="half" label={t('common.branch')} name="branchId">
        {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
      </SelectField>
      <TextField span="half" label={`${t('pur.invoiceRef')} (${t('common.optional')})`} name="supplierInvoiceRef" error={fieldError('supplierInvoiceRef')} />
      <TextField span="half" label={`${t('pur.deliveryRef')} (${t('common.optional')})`} name="supplierDeliveryRef" error={fieldError('supplierDeliveryRef')} />
      <LineItems
        fields={[
          { name: 'variantId', label: t('common.item'), kind: 'select' },
          { name: 'quantity', label: t('common.quantity'), kind: 'decimal', placeholder: '0' },
          { name: 'unitCost', label: t('common.unitCost'), kind: 'decimal', placeholder: '0.00' },
          ...(dated
            ? [
                { name: 'expiresOn', label: t('pur.expiresOn'), kind: 'date' as const },
                { name: 'lotCode', label: t('inv.adjustLot'), kind: 'text' as const },
              ]
            : []),
        ]}
        options={variants}
        fieldError={fieldError}
        addLabel={t('common.addLine')}
        removeLabel={t('common.removeLine')}
      />
      <Actions pending={pending} general={general(error) ?? fieldError('lines') ?? null} submitLabel={t('pur.receive')} close={close} />
    </form>
  );
}

export function UnorderedReceiptForm(props: { branches: Branch[]; suppliers: Supplier[]; variants: VariantOption[]; dated: boolean }) {
  const { t } = useT();
  return <Disclosure wide label={t('pur.receiveNoOrder')}>{(close) => <UnorderedReceiptFields close={close} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- supplier catalog (session 20)
/** Add an item to a supplier's catalog, or correct one (`item` given). */
function SupplierItemFields({ close, supplierId, variants, item }: { close: () => void; supplierId: string; variants: VariantOption[]; item?: SupplierItem }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const cost = text(f, 'unitCost');
    const body = {
      supplierSku: orNull(text(f, 'supplierSku')),
      supplierItemName: orNull(text(f, 'supplierItemName')),
      unitCost: cost === '' ? null : cost,
      preferred: f.get('preferred') === 'on',
    };
    const r = item
      ? await submit('PATCH', `/api/v1/supplier-items/${item.id}`, body)
      : await submit('POST', `/api/v1/suppliers/${supplierId}/items`, { variantId: f.get('variantId'), ...body });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      {!item && (
        <SelectField label={t('common.item')} name="variantId">
          {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </SelectField>
      )}
      <TextField span="half" label={`${t('pur.supplierSku')} (${t('common.optional')})`} name="supplierSku" maxLength={64} defaultValue={item?.supplierSku ?? ''} error={fieldError('supplierSku')} />
      <TextField span="half" label={`${t('pur.catalogCostLabel')} (${t('common.optional')})`} name="unitCost" inputMode="decimal" placeholder="0.00" defaultValue={item?.unitCost ? item.unitCost.replace(/(\.\d{2})0+$/, '$1') : ''} error={fieldError('unitCost')} />
      <TextField label={`${t('pur.supplierItemName')} (${t('common.optional')})`} name="supplierItemName" maxLength={200} defaultValue={item?.supplierItemName ?? ''} error={fieldError('supplierItemName')} />
      <label className="check">
        <input type="checkbox" name="preferred" defaultChecked={item?.preferred ?? false} /> <span>{t('pur.preferred')}</span>
      </label>
      <Actions pending={pending} general={general(error)} submitLabel={item ? t('common.save') : t('common.add')} close={close} />
    </form>
  );
}

export function AddSupplierItemForm(props: { supplierId: string; variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('pur.addCatalogItem')}>{(close) => <SupplierItemFields close={close} {...props} />}</Disclosure>;
}

export function EditSupplierItemForm({ item, supplierId }: { item: SupplierItem; supplierId: string }) {
  const { t } = useT();
  return <Disclosure label={t('pur.editCatalogItem')} kind="edit">{(close) => <SupplierItemFields close={close} supplierId={supplierId} variants={[]} item={item} />}</Disclosure>;
}
