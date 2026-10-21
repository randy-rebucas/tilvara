'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import { extraFor } from '@/i18n/titles';
import type { MessageKey } from '@/i18n/messages';
import type { Branch, DosageForm, DrugClass, Pharmacist, PharmacySettings, Prescription } from '@/lib/api';
import { DOSAGE_FORMS } from '@/lib/pharmacy';

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const orNull = (s: string) => (s === '' ? null : s);
const RX_CLASSES: readonly DrugClass[] = ['RX', 'ANTIBIOTIC', 'DANGEROUS', 'OTC'];

interface Row {
  key: number;
  genericName: string;
  strength: string;
  dosageForm: DosageForm;
  quantity: string;
  drugClass: DrugClass;
  directions: string;
}

/**
 * A prescription as written (ADR-0025 §6): the patient, the prescriber and their licences, and what it
 * orders in generic names with quantities in pieces. A dangerous drug also needs the S2 licence, the
 * yellow form and the patient's address. New (`prescription` absent) or a change while nothing is
 * dispensed on it (`items` replaces them all).
 */
export function PrescriptionForm({ branchId, prescription, customers = [], customerId }: { branchId: string; prescription?: Prescription; customers?: { id: string; label: string }[]; customerId?: string }) {
  const { t, lang } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  const [next, setNext] = useState(prescription?.items.length ?? 1);
  const [rows, setRows] = useState<Row[]>(() =>
    prescription
      ? prescription.items.map((i, k) => ({ key: k, genericName: i.genericName, strength: i.strength ?? '', dosageForm: i.dosageForm, quantity: i.quantity, drugClass: i.drugClass, directions: i.directions ?? '' }))
      : [{ key: 0, genericName: '', strength: '', dosageForm: 'TABLET', quantity: '', drugClass: 'RX', directions: '' }],
  );
  const dangerous = rows.some((r) => r.drugClass === 'DANGEROUS');
  const set = (k: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...patch } : r)));
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const customer = str(f, 'customerId');
    const body = {
      customerId: orNull(customer),
      patientName: str(f, 'patientName'),
      patientAddress: orNull(str(f, 'patientAddress')),
      prescriberName: str(f, 'prescriberName'),
      prescriberLicenseNo: str(f, 'prescriberLicenseNo'),
      prescriberS2No: orNull(str(f, 'prescriberS2No')),
      yellowFormNo: orNull(str(f, 'yellowFormNo')),
      issuedOn: str(f, 'issuedOn'),
      notes: orNull(str(f, 'notes')),
      items: rows.map((r) => ({
        genericName: r.genericName.trim(),
        strength: orNull(r.strength.trim()),
        dosageForm: r.dosageForm,
        quantity: r.quantity.trim(),
        drugClass: r.drugClass,
        directions: orNull(r.directions.trim()),
      })),
    };
    if (prescription) {
      const r = await submit('PATCH', `/api/v1/prescriptions/${prescription.id}`, body);
      if (r.ok) router.push(`/pharmacy/prescriptions/${prescription.id}`);
    } else {
      const r = await submit<{ id: string }>('POST', '/api/v1/prescriptions', { branchId, ...body }, { idempotencyKey: key, refresh: false });
      if (r.ok) router.push(`/pharmacy/prescriptions/${r.data.id}`);
    }
  }
  const itemError = (i: number, k: string) => fieldError(`items.${i}.${k}`);
  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-2 font-semibold">{t('pha.patientSection')}</legend>
        <TextField label={t('pha.patient')} name="patientName" required maxLength={200} defaultValue={prescription?.patientName ?? ''} error={fieldError('patientName')} />
        <TextField label={dangerous ? t('pha.patientAddress') : `${t('pha.patientAddress')} (${t('common.optional')})`} name="patientAddress" maxLength={300} defaultValue={prescription?.patientAddress ?? ''} hint={t('pha.patientAddressHint')} error={fieldError('patientAddress')} />
        {(customers.length > 0 || prescription?.customerId) && (
          <SelectField label={`${t('pha.customer')} (${t('common.optional')})`} name="customerId" defaultValue={prescription?.customerId ?? customerId ?? ''} hint={t('pha.customerHint')} error={fieldError('customerId')}>
            <option value="">{t('pha.noCustomer')}</option>
            {prescription?.customerId && !customers.some((c) => c.id === prescription.customerId) && <option value={prescription.customerId}>{prescription.customerName ?? '—'}</option>}
            {customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </SelectField>
        )}
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-2 font-semibold">{t('pha.prescriberSection')}</legend>
        <TextField label={t('pha.prescriber')} name="prescriberName" required maxLength={200} defaultValue={prescription?.prescriberName ?? ''} placeholder={extraFor(lang, 'example.prescriber')} error={fieldError('prescriberName')} />
        <TextField label={t('pha.prcNo')} name="prescriberLicenseNo" required maxLength={30} defaultValue={prescription?.prescriberLicenseNo ?? ''} placeholder="0123456" error={fieldError('prescriberLicenseNo')} />
        <TextField label={t('pha.issuedOn')} name="issuedOn" type="date" required defaultValue={prescription?.issuedOn ?? ''} error={fieldError('issuedOn')} />
        <TextField label={dangerous ? t('pha.s2No') : `${t('pha.s2No')} (${t('pha.ddOnly')})`} name="prescriberS2No" maxLength={30} defaultValue={prescription?.prescriberS2No ?? ''} error={fieldError('prescriberS2No')} />
        <TextField label={dangerous ? t('pha.yellowForm') : `${t('pha.yellowForm')} (${t('pha.ddOnly')})`} name="yellowFormNo" maxLength={40} defaultValue={prescription?.yellowFormNo ?? ''} error={fieldError('yellowFormNo') ?? (error?.code === 'YELLOW_FORM_USED' ? error.message : undefined)} />
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 font-semibold">{t('pha.itemsSection')}</legend>
        <p className="-mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('pha.itemsHint')}</p>
        {rows.map((r, i) => (
          <div key={r.key} className="grid gap-2 rounded-[5px] border border-hair-soft p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_auto]" data-rx-item={i}>
            <TextField label={t('drug.generic')} name={`items.${i}.genericName`} required maxLength={200} value={r.genericName} onChange={(e) => set(r.key, { genericName: e.target.value })} placeholder={extraFor(lang, 'example.genericRx')} error={itemError(i, 'genericName')} />
            <TextField label={`${t('drug.strength')} (${t('common.optional')})`} name={`items.${i}.strength`} maxLength={60} value={r.strength} onChange={(e) => set(r.key, { strength: e.target.value })} placeholder="500 mg" error={itemError(i, 'strength')} />
            <SelectField label={t('drug.form')} name={`items.${i}.dosageForm`} value={r.dosageForm} onChange={(e) => set(r.key, { dosageForm: e.target.value as DosageForm })} error={itemError(i, 'dosageForm')}>
              {DOSAGE_FORMS.map((d) => <option key={d} value={d}>{t(`drug.form.${d}` as MessageKey)}</option>)}
            </SelectField>
            <TextField label={t('pha.qtyPieces')} name={`items.${i}.quantity`} required inputMode="decimal" value={r.quantity} onChange={(e) => set(r.key, { quantity: e.target.value })} placeholder="21" error={itemError(i, 'quantity')} />
            <SelectField label={t('drug.class')} name={`items.${i}.drugClass`} value={r.drugClass} onChange={(e) => set(r.key, { drugClass: e.target.value as DrugClass })} error={itemError(i, 'drugClass')}>
              {RX_CLASSES.map((c) => <option key={c} value={c}>{t(`drug.class.${c}` as MessageKey)}</option>)}
            </SelectField>
            <div className="flex items-end">
              <button type="button" className="btn h-[2.4rem] px-2.5" aria-label={`${t('common.removeLine')} ${i + 1}`} disabled={rows.length <= 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                <Trash2 aria-hidden className="size-4" />
              </button>
            </div>
            <div className="sm:col-span-2 lg:col-span-6">
              <TextField label={`${t('pha.directions')} (${t('common.optional')})`} name={`items.${i}.directions`} maxLength={300} value={r.directions} onChange={(e) => set(r.key, { directions: e.target.value })} placeholder={t('pha.directionsHint')} error={itemError(i, 'directions')} />
            </div>
          </div>
        ))}
        <div>
          <button type="button" className="btn" disabled={rows.length >= 20} onClick={() => { setRows((rs) => [...rs, { key: next, genericName: '', strength: '', dosageForm: 'TABLET', quantity: '', drugClass: 'RX', directions: '' }]); setNext(next + 1); }}>
            <Plus aria-hidden className="size-4" /> {t('pha.addItem')}
          </button>
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor="rx-notes">{`${t('common.notes')} (${t('common.optional')})`}</label>
        <textarea id="rx-notes" name="notes" className="input min-h-[4.5rem]" maxLength={1000} defaultValue={prescription?.notes ?? ''} />
      </div>
      <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('pha.healthData')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{prescription ? t('common.save') : t('pha.saveRx')}</button>
        <a href={prescription ? `/pharmacy/prescriptions/${prescription.id}` : `/pharmacy?branch=${branchId}`} className="btn">{t('common.cancel')}</a>
        <FormError message={error?.code === 'YELLOW_FORM_USED' ? null : (general(error) ?? fieldError('items') ?? null)} />
      </div>
    </form>
  );
}

/** Place a hold on a batch (recall, FDA advisory): one branch or every branch (ADR-0025 §5). */
export function PlaceHold({ variants, branches, initial }: { variants: { id: string; label: string }[]; branches: Branch[]; initial?: { variantId?: string; lotCode?: string } }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('pha.placeHold')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const branchId = str(f, 'holdBranchId');
            const r = await submit('POST', '/api/v1/stock/lot-holds', {
              variantId: str(f, 'variantId'),
              lotCode: str(f, 'lotCode'),
              ...(branchId && { branchId }),
              reason: str(f, 'reason'),
              reference: orNull(str(f, 'reference')),
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
          <SelectField label={t('pha.holdWhere')} name="holdBranchId" defaultValue="" hint={t('pha.holdWhereHint')} error={fieldError('branchId')}>
            <option value="">{t('rep.allBranches')}</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
          </SelectField>
          <div className="sm:col-span-2">
            <TextField label={t('common.reason')} name="reason" required maxLength={200} placeholder={t('pha.holdReasonHint')} error={fieldError('reason')} />
          </div>
          <TextField label={`${t('pha.holdReference')} (${t('common.optional')})`} name="reference" maxLength={100} placeholder="FDA Advisory 2026-123" error={fieldError('reference')} />
          <div className="col-span-full flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('pha.placeHold')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** The business's pharmacy rules: whether an SC/PWD discount on medicine needs the purchase booklet. */
export function PharmacySettingsForm({ settings, canEdit }: { settings: PharmacySettings; canEdit: boolean }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [saved, setSaved] = useState(false);
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(false);
        const r = await submit('PUT', '/api/v1/pharmacy/settings', { requirePurchaseBooklet: new FormData(e.currentTarget).get('requirePurchaseBooklet') === 'on' });
        if (r.ok) setSaved(true);
      }}
    >
      <label className="flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" name="requirePurchaseBooklet" defaultChecked={settings.requirePurchaseBooklet} disabled={!canEdit} className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>{t('pha.booklet')}<span className="block text-[0.8125rem] text-muted">{t('pha.bookletHint')}</span></span>
      </label>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
          {saved && <span role="status" className="text-[0.875rem]">{t('common.saved')}</span>}
          <FormError message={error?.message} />
        </div>
      )}
    </form>
  );
}

/** A member's pharmacist licence (PRC) number and its validity; dangerous drugs need one in force. */
export function PharmacistLicence({ pharmacist }: { pharmacist: Pharmacist }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure kind="edit" label={pharmacist.licenseNo ? t('pha.editLicence') : t('pha.addLicence')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await submit('PUT', `/api/v1/pharmacy/pharmacists/${pharmacist.membershipId}`, { licenseNo: str(f, 'licenseNo'), validUntil: orNull(str(f, 'validUntil')) });
            if (r.ok) close();
          }}
        >
          <TextField label={t('pha.licenceNo')} name="licenseNo" required maxLength={30} defaultValue={pharmacist.licenseNo ?? ''} error={fieldError('licenseNo')} />
          <TextField label={`${t('pha.validUntil')} (${t('common.optional')})`} name="validUntil" type="date" defaultValue={pharmacist.validUntil ?? ''} error={fieldError('validUntil')} />
          <div className="col-span-full flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}
