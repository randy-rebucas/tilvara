'use client';

import { Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Callout } from '@/components/note';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import type { GarmentType, JobOrder, LaundryUnit } from '@/lib/api';
import { send } from '@/lib/client-api';
import { billedQuantity, isKilos, loadsFor, minimumApplies } from '@/lib/laundry';
import { CustomerSearch } from '../../appointments/booking-form';

/** A laundry service or add-on the form can put on a line (from the catalogue's laundry fields). */
export interface LaundryOption {
  variantId: string;
  label: string;
  unit: LaundryUnit | null;
  min: string | null;
  kgPerLoad: string | null;
  addon: boolean;
}

interface Line { key: string; variantId: string; quantity: string }
interface Item { key: string; garmentTypeId: string; label: string; count: string }
const money = (s: string) => /^\d{1,16}(\.\d{1,4})?$/.test(s);
const newKey = () => crypto.randomUUID();

/**
 * Take in laundry (ADR-0024 §3): the customer (searched) or a walk-in's name and phone, regular or
 * express, the weight and bags, the services by kilo, load or piece (loads suggested from the weight,
 * the minimum shown), add-ons from quick buttons, items and their condition, instructions, a pickup
 * or delivery, and a down payment by bank transfer. The server prices and freezes the lines.
 */
export function JobOrderForm({
  branchId,
  services,
  garmentTypes,
  canSearchCustomers,
}: {
  branchId: string;
  services: LaundryOption[];
  garmentTypes: GarmentType[];
  canSearchCustomers: boolean;
}) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const depositKey = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  const main = services.filter((s) => s.unit !== null && !s.addon);
  const addons = services.filter((s) => s.addon);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [weight, setWeight] = useState('');
  const [level, setLevel] = useState<'REGULAR' | 'EXPRESS'>('REGULAR');
  const [lines, setLines] = useState<Line[]>(main[0] ? [{ key: newKey(), variantId: main[0].variantId, quantity: '' }] : []);
  const [items, setItems] = useState<Item[]>([]);
  const [pickup, setPickup] = useState(false);
  const [delivery, setDelivery] = useState(false);
  const [depositIssue, setDepositIssue] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; depositError: string } | null>(null);
  const option = (id: string) => services.find((s) => s.variantId === id);

  /** What a line counts when its quantity is left empty: the weight for a kilo service, the loads for a load service. */
  const suggested = (l: Line) => {
    const o = option(l.variantId);
    if (!o || !isKilos(weight)) return null;
    if (o.unit === 'KG') return weight.trim();
    if (o.unit === 'LOAD') return loadsFor(weight, o.kgPerLoad);
    return null;
  };
  const quantityOf = (l: Line) => l.quantity.trim() || suggested(l) || '';
  const setLine = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  /** An add-on per kilo takes the weight, per load the loads of the first per-load line, else one. */
  const addAddon = (o: LaundryOption) => {
    const loadLine = lines.find((l) => option(l.variantId)?.unit === 'LOAD');
    const loads = loadLine ? quantityOf(loadLine) : '';
    const quantity = o.unit === 'KG' && isKilos(weight) ? weight.trim() : o.unit === 'LOAD' && loads ? loads : '1';
    setLines((ls) => [...ls, { key: newKey(), variantId: o.variantId, quantity }]);
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const deposit = s('depositAmount');
    setDepositIssue(null);
    if (deposit && (!money(deposit) || !s('depositReference'))) {
      setDepositIssue(t('lau.depositNeedsReference'));
      return;
    }
    const trip = (prefix: string) => ({
      address: s(`${prefix}Address`),
      contactPhone: s(`${prefix}Phone`),
      ...(s(`${prefix}Contact`) && { contactName: s(`${prefix}Contact`) }),
      ...(s(`${prefix}Start`) && { windowStart: new Date(s(`${prefix}Start`)).toISOString() }),
      ...(s(`${prefix}End`) && { windowEnd: new Date(s(`${prefix}End`)).toISOString() }),
      ...(s(`${prefix}Rider`) && { riderName: s(`${prefix}Rider`) }),
    });
    const r = await submit<JobOrder>('POST', '/api/v1/job-orders', {
      branchId,
      ...(customer ? { customerId: customer.id } : { customerName: s('customerName'), ...(s('customerPhone') && { customerPhone: s('customerPhone') }) }),
      serviceLevel: level,
      ...(isKilos(weight) && { weightKg: weight.trim() }),
      bagCount: Number.parseInt(s('bagCount') || '1', 10),
      ...(s('specialInstructions') && { specialInstructions: s('specialInstructions') }),
      ...(s('conditionNotes') && { conditionNotes: s('conditionNotes') }),
      notify: f.get('notify') === 'on',
      lines: lines.filter((l) => l.variantId).map((l) => ({ variantId: l.variantId, quantity: quantityOf(l) })),
      items: items.filter((i) => i.count.trim()).map((i) => ({
        ...(i.garmentTypeId ? { garmentTypeId: i.garmentTypeId } : { label: i.label.trim() }),
        count: Number.parseInt(i.count, 10),
      })),
      ...(pickup && { pickup: trip('pickup') }),
      ...(delivery && { delivery: trip('delivery') }),
    }, { idempotencyKey: key, refresh: false });
    if (!r.ok) return;
    if (deposit) {
      // The job is taken in; the down payment is its own record (bank transfer: no drawer in the back office).
      const d = await send('POST', `/api/v1/job-orders/${r.data.id}/deposits`, { method: 'BANK_TRANSFER', amount: deposit, reference: s('depositReference') }, { idempotencyKey: depositKey });
      if (!d.ok) {
        setMade({ id: r.data.id, depositError: d.error.message });
        return;
      }
    }
    router.push(`/laundry/jobs/${r.data.id}`);
  }

  if (made) {
    return (
      <div className="flex flex-col gap-3">
        <Callout tone="warn">{t('lau.madeDepositFailed', { message: made.depositError })}</Callout>
        <div><Link href={`/laundry/jobs/${made.id}`} className="btn btn-primary">{t('lau.openJob')}</Link></div>
      </div>
    );
  }

  const unitWord = (u: LaundryUnit | null) => (u ? t(`lau.unit.${u}` as MessageKey) : t('lau.unit.ITEM'));
  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5" data-testid="job-form">
      <fieldset className="grid gap-3">
        <legend className="mb-1 font-semibold">{t('lau.customer')}</legend>
        {customer ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="tag" data-testid="picked-customer">{customer.name}</span>
            <button type="button" className="btn btn-sm" onClick={() => setCustomer(null)}><X aria-hidden className="size-3.5" /> {t('lau.changeCustomer')}</button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {canSearchCustomers && <CustomerSearch onPick={(c) => setCustomer({ id: c.id, name: c.name })} />}
            <TextField label={canSearchCustomers ? t('lau.orWalkIn') : t('lau.walkInName')} name="customerName" maxLength={120} error={fieldError('customerName')} />
            <TextField label={`${t('lau.phone')} (${t('common.optional')})`} name="customerPhone" inputMode="tel" maxLength={20} hint={t('lau.phoneHint')} error={fieldError('customerPhone')} />
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-1 font-semibold">{t('lau.dropOff')}</legend>
        <div className="field">
          <span className="text-[0.8125rem] font-semibold">{t('lau.serviceLevel')}</span>
          <div className="flex flex-wrap gap-3 pt-1.5">
            {(['REGULAR', 'EXPRESS'] as const).map((l) => (
              <label key={l} className="flex items-center gap-1.5 text-[0.9375rem]">
                <input type="radio" name="serviceLevel" value={l} checked={level === l} onChange={() => setLevel(l)} className="accent-[var(--color-blue)]" />
                {t(`lau.level.${l}` as MessageKey)}
              </label>
            ))}
          </div>
        </div>
        <TextField label={t('lau.weightKg')} name="weightKg" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="5.250" hint={t('lau.weightHint')} error={fieldError('weightKg')} />
        <TextField label={t('lau.bags')} name="bagCount" type="number" min={1} max={99} defaultValue="1" error={fieldError('bagCount')} />
      </fieldset>
      {level === 'EXPRESS' && <p className="-mt-3 text-[0.8125rem] text-muted">{t('lau.expressHint')}</p>}

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-semibold">{t('lau.services')}</legend>
        {main.length === 0 && addons.length === 0 ? (
          <Callout>{t('lau.noServices')} <Link href="/products" className="font-semibold underline">{t('nav.products')}</Link></Callout>
        ) : (
          <>
            <ul className="flex flex-col gap-2" data-testid="job-lines">
              {lines.map((l, i) => {
                const o = option(l.variantId);
                const q = quantityOf(l);
                const billed = q ? billedQuantity(q, o?.min) : '';
                return (
                  <li key={l.key} className="grid items-end gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]" data-line={i}>
                    <SelectField label={i === 0 ? t('lau.service') : `${t('lau.service')} ${i + 1}`} name={`line-${i}`} value={l.variantId} onChange={(e) => setLine(l.key, { variantId: e.target.value, quantity: '' })} error={fieldError(`lines.${i}.variantId`)}>
                      {services.map((s) => <option key={s.variantId} value={s.variantId}>{s.label}</option>)}
                    </SelectField>
                    <TextField
                      label={`${t('lau.quantity')} (${unitWord(o?.unit ?? null)})`}
                      name={`qty-${i}`}
                      inputMode="decimal"
                      value={l.quantity}
                      placeholder={suggested(l) ?? ''}
                      onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                      hint={o?.unit === 'LOAD' && suggested(l) ? t('lau.loadsSuggested', { n: suggested(l)!, kg: o.kgPerLoad ?? '' }) : o?.unit === 'KG' && !l.quantity && suggested(l) ? t('lau.fromWeight') : undefined}
                      error={fieldError(`lines.${i}.quantity`)}
                    />
                    <button type="button" className="btn btn-sm mb-0.5" aria-label={`${t('lau.removeLine')} ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><X aria-hidden className="size-4" /></button>
                    {billed && o?.min && minimumApplies(q, billed) && (
                      <p className="text-[0.8125rem] text-[#6b4a12] sm:col-span-3" data-testid="minimum-applies">{t('lau.minimumApplies', { min: billed, unit: unitWord(o.unit) })}</p>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => [...ls, { key: newKey(), variantId: main[0]?.variantId ?? services[0]!.variantId, quantity: '' }])}>
                <Plus aria-hidden className="size-3.5" /> {t('lau.addService')}
              </button>
              {addons.length > 0 && <span className="text-[0.8125rem] text-muted">{t('lau.addOns')}:</span>}
              {addons.map((o) => (
                <button key={o.variantId} type="button" className="btn btn-sm" data-addon={o.label} onClick={() => addAddon(o)}>+ {o.label}</button>
              ))}
            </div>
            <FormError message={fieldError('lines')} />
          </>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-semibold">{t('lau.itemsAndCondition')}</legend>
        {items.length > 0 && (
          <ul className="flex flex-col gap-2">
            {items.map((it, i) => (
              <li key={it.key} className="grid items-end gap-2 sm:grid-cols-[minmax(0,2fr)_8rem_auto]">
                {it.garmentTypeId ? (
                  <p className="pb-2 font-semibold">{it.label}</p>
                ) : (
                  <TextField label={t('lau.garment')} name={`item-${i}`} value={it.label} maxLength={60} onChange={(e) => setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, label: e.target.value } : x)))} error={fieldError(`items.${i}.label`)} />
                )}
                <TextField label={t('lau.count')} name={`count-${i}`} type="number" min={1} max={999} value={it.count} onChange={(e) => setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, count: e.target.value } : x)))} error={fieldError(`items.${i}.count`)} />
                <button type="button" className="btn btn-sm mb-0.5" aria-label={`${t('lau.removeLine')} ${it.label}`} onClick={() => setItems((xs) => xs.filter((x) => x.key !== it.key))}><X aria-hidden className="size-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          {garmentTypes.filter((g) => !items.some((i) => i.garmentTypeId === g.id)).map((g) => (
            <button key={g.id} type="button" className="btn btn-sm" data-garment={g.name} onClick={() => setItems((xs) => [...xs, { key: newKey(), garmentTypeId: g.id, label: g.name, count: '1' }])}>+ {g.name}</button>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setItems((xs) => [...xs, { key: newKey(), garmentTypeId: '', label: '', count: '1' }])}>+ {t('lau.otherGarment')}</button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={`${t('lau.conditionNotes')} (${t('common.optional')})`} name="conditionNotes" maxLength={500} hint={t('lau.conditionHint')} error={fieldError('conditionNotes')} />
          <TextField label={`${t('lau.instructions')} (${t('common.optional')})`} name="specialInstructions" maxLength={500} hint={t('lau.instructionsHint')} error={fieldError('specialInstructions')} />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-semibold">{t('lau.pickupDelivery')}</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-[0.9375rem]"><input type="checkbox" checked={pickup} onChange={(e) => setPickup(e.target.checked)} className="size-4 accent-[var(--color-blue)]" /> {t('lau.wantPickup')}</label>
          <label className="flex items-center gap-2 text-[0.9375rem]"><input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} className="size-4 accent-[var(--color-blue)]" /> {t('lau.wantDelivery')}</label>
        </div>
        {(['pickup', 'delivery'] as const).filter((k) => (k === 'pickup' ? pickup : delivery)).map((k) => (
          <div key={k} className="grid gap-3 rounded-[5px] border border-hair-soft p-3 sm:grid-cols-2 lg:grid-cols-3" data-trip={k}>
            <p className="font-semibold sm:col-span-2 lg:col-span-3">{t(k === 'pickup' ? 'lau.trip.PICKUP' : 'lau.trip.DELIVERY')}</p>
            <div className="sm:col-span-2"><TextField label={t('lau.address')} name={`${k}Address`} required maxLength={300} error={fieldError(`${k}.address`)} /></div>
            <TextField label={t('lau.contactPhone')} name={`${k}Phone`} inputMode="tel" required maxLength={20} error={fieldError(`${k}.contactPhone`)} />
            <TextField label={`${t('lau.contactName')} (${t('common.optional')})`} name={`${k}Contact`} maxLength={120} error={fieldError(`${k}.contactName`)} />
            <TextField label={`${t('lau.windowStart')} (${t('common.optional')})`} name={`${k}Start`} type="datetime-local" error={fieldError(`${k}.windowStart`)} />
            <TextField label={`${t('lau.windowEnd')} (${t('common.optional')})`} name={`${k}End`} type="datetime-local" error={fieldError(`${k}.windowEnd`)} />
            <TextField label={`${t('lau.rider')} (${t('common.optional')})`} name={`${k}Rider`} maxLength={80} error={fieldError(`${k}.riderName`)} />
          </div>
        ))}
        {delivery && <p className="text-[0.8125rem] text-muted">{t('lau.deliveryFeeHint')}</p>}
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-1 font-semibold">{t('lau.downPayment')}</legend>
        <TextField label={`${t('lau.depositAmount')} (${t('common.optional')})`} name="depositAmount" inputMode="decimal" placeholder="0.00" />
        <TextField label={t('lau.bankReference')} name="depositReference" maxLength={64} />
        <p className="text-[0.8125rem] text-muted sm:col-span-2 lg:col-span-3">{t('lau.depositAdminHint')}</p>
        <FormError message={depositIssue} />
      </fieldset>

      <label className="flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" name="notify" defaultChecked className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>{t('lau.notify')}<span className="block text-[0.8125rem] text-muted">{t('lau.notifyHint')}</span></span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('lau.takeIn')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : fieldError('customerName')} />
      </div>
    </form>
  );
}
