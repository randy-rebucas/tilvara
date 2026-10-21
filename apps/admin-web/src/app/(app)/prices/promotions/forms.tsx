'use client';

import { Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { ItemPicker, variantLabel, type PickProduct } from '@/components/item-picker';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import type { Promotion, PromotionKind } from '@/lib/api';
import { percentFromRate, rateFromPercent } from '@/lib/format';
import { describePromotion, isFree } from '@/lib/promotions';

const KINDS: PromotionKind[] = ['MULTI_BUY', 'BUY_X_GET_Y', 'QUANTITY_BREAK'];

/** datetime-local is read as Manila wall-clock time (UTC+08:00, no DST). */
const manilaToIso = (local: string) => new Date(`${local}:00+08:00`).toISOString();
const wholeNumber = (s: string) => (/^\d{1,4}$/.test(s.trim()) ? Number(s.trim()) : NaN);

export function StateMark({ state }: { state: Promotion['state'] }) {
  const { t } = useT();
  if (state === 'RUNNING') return <span className="chip bg-blue">{t('promo.state.RUNNING')}</span>;
  return <span className="tag">{t(`promo.state.${state}` as MessageKey)}</span>;
}

interface Tier {
  min: string;
  pct: string;
}

function PromotionFields({ close, products, branches, copyOf }: { close: () => void; products: PickProduct[]; branches: { id: string; code: string; name: string }[]; copyOf: Promotion | null }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError, error, setError } = useSubmit();
  const [kind, setKind] = useState<PromotionKind>(copyOf?.kind ?? 'MULTI_BUY');
  const [name, setName] = useState(copyOf?.name ?? '');
  const [quantity, setQuantity] = useState(String(copyOf?.quantity ?? '3'));
  const [price, setPrice] = useState(copyOf?.price ?? '');
  const [buy, setBuy] = useState(String(copyOf?.buyQuantity ?? '2'));
  const [get, setGet] = useState(String(copyOf?.getQuantity ?? '1'));
  const [free, setFree] = useState(copyOf?.getRate ? isFree(copyOf.getRate) : true);
  const [getPct, setGetPct] = useState(copyOf?.getRate && !isFree(copyOf.getRate) ? percentFromRate(copyOf.getRate) : '50');
  const [tiers, setTiers] = useState<Tier[]>(copyOf?.tiers?.map((x) => ({ min: x.minQuantity, pct: percentFromRate(x.rate) })) ?? [{ min: '6', pct: '10' }]);
  const [items, setItems] = useState<string[]>(() => copyOf?.items.map((i) => i.variantId) ?? []);
  const [everywhere, setEverywhere] = useState(copyOf ? copyOf.allBranches : true);
  const [chosenBranches, setChosenBranches] = useState<string[]>(copyOf?.branchIds ?? []);
  const [startLater, setStartLater] = useState(false);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  const chosen = useMemo(() => new Set(items), [items]);
  const byId = useMemo(() => new Map(products.flatMap((p) => p.variants.map((v) => [v.id, { label: variantLabel(p, v), sku: v.sku }] as const))), [products]);
  // Items of a copied promotion that are no longer in the catalogue (archived) still show by their saved name.
  const savedName = useMemo(() => new Map(copyOf?.items.map((i) => [i.variantId, { label: i.name, sku: i.sku }]) ?? []), [copyOf]);

  /** The terms as the API takes them, or a message about the first thing to fix. */
  function terms(): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
    if (kind === 'MULTI_BUY') {
      const n = wholeNumber(quantity);
      if (!(n >= 2)) return { ok: false, message: t('promo.err.quantity') };
      if (!/^\d{1,16}(\.\d{1,4})?$/.test(price.trim())) return { ok: false, message: t('promo.err.price') };
      return { ok: true, body: { quantity: n, price: price.trim() } };
    }
    if (kind === 'BUY_X_GET_Y') {
      const b = wholeNumber(buy);
      const g = wholeNumber(get);
      if (!(b >= 1) || !(g >= 1)) return { ok: false, message: t('promo.err.buyGet') };
      const rate = free ? '1' : rateFromPercent(getPct);
      if (!rate || rate === '0') return { ok: false, message: t('promo.err.percent') };
      return { ok: true, body: { buyQuantity: b, getQuantity: g, getRate: rate } };
    }
    const out: { minQuantity: string; rate: string }[] = [];
    for (const tier of tiers) {
      const rate = rateFromPercent(tier.pct);
      if (!/^\d{1,14}(\.\d{1,4})?$/.test(tier.min.trim()) || /^0+(\.0*)?$/.test(tier.min.trim())) return { ok: false, message: t('promo.err.tierMin') };
      if (!rate || rate === '0') return { ok: false, message: t('promo.err.percent') };
      out.push({ minQuantity: tier.min.trim(), rate });
    }
    return { ok: true, body: { tiers: out } };
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLocal(null);
    setError(null);
    const tr = terms();
    if (!tr.ok) return setLocal(tr.message);
    if (items.length === 0) return setLocal(t('promo.err.items'));
    if (!everywhere && chosenBranches.length === 0) return setLocal(t('promo.err.branches'));
    if (startLater && !startsAt) return setLocal(t('promo.err.start'));
    const body = {
      name: name.trim(),
      kind,
      variantIds: items,
      ...(everywhere ? {} : { branchIds: chosenBranches }),
      ...(startLater && startsAt ? { startsAt: manilaToIso(startsAt) } : {}),
      ...(endsAt ? { endsAt: manilaToIso(endsAt) } : {}),
      ...tr.body,
    };
    const r = await submit<Promotion>('POST', '/api/v1/promotions', body, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      close();
      router.push(`/prices/promotions/${r.data.id}`);
      router.refresh();
    }
  }

  const preview = terms();
  const termsPreview = preview.ok
    ? describePromotion(
        {
          kind,
          quantity: (preview.body.quantity as number) ?? null,
          price: (preview.body.price as string) ?? null,
          buyQuantity: (preview.body.buyQuantity as number) ?? null,
          getQuantity: (preview.body.getQuantity as number) ?? null,
          getRate: (preview.body.getRate as string) ?? null,
          tiers: (preview.body.tiers as Promotion['tiers']) ?? null,
        },
        t,
      )
    : null;
  const apiMessage = error && error.code !== 'VALIDATION_FAILED' ? error.message : error ? t('promo.err.check') : null;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('promo.name')} name="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('promo.nameHint')} error={fieldError('name')} />
        <SelectField label={t('promo.kind')} value={kind} onChange={(e) => setKind(e.target.value as PromotionKind)}>
          {KINDS.map((k) => <option key={k} value={k}>{t(`promo.kind.${k}` as MessageKey)}</option>)}
        </SelectField>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-semibold">{t('promo.terms')}</legend>
        <p className="-mt-1 text-[0.875rem] text-muted">{t(`promo.explain.${kind}` as MessageKey)}</p>
        {kind === 'MULTI_BUY' && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextField label={t('promo.quantity')} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} error={fieldError('quantity')} />
            <TextField label={t('promo.price')} inputMode="decimal" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} hint={t('promo.priceHint')} error={fieldError('price')} />
          </div>
        )}
        {kind === 'BUY_X_GET_Y' && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextField label={t('promo.buy')} inputMode="numeric" value={buy} onChange={(e) => setBuy(e.target.value)} error={fieldError('buyQuantity')} />
            <TextField label={t('promo.get')} inputMode="numeric" value={get} onChange={(e) => setGet(e.target.value)} error={fieldError('getQuantity')} />
            <SelectField label={t('promo.getAt')} value={free ? 'free' : 'off'} onChange={(e) => setFree(e.target.value === 'free')}>
              <option value="free">{t('promo.getFree')}</option>
              <option value="off">{t('promo.getOff')}</option>
            </SelectField>
            {!free && <TextField label={t('promo.percentOff')} inputMode="decimal" value={getPct} onChange={(e) => setGetPct(e.target.value)} error={fieldError('getRate')} />}
          </div>
        )}
        {kind === 'QUANTITY_BREAK' && (
          <div className="flex flex-col gap-2">
            {tiers.map((tier, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2 sm:max-w-[520px]">
                <TextField label={t('promo.tierMin')} labelClassName={i > 0 ? 'sr-only' : undefined} inputMode="decimal" value={tier.min} onChange={(e) => setTiers((all) => all.map((x, k) => (k === i ? { ...x, min: e.target.value } : x)))} error={fieldError(`tiers.${i}.minQuantity`)} />
                <TextField label={t('promo.percentOff')} labelClassName={i > 0 ? 'sr-only' : undefined} inputMode="decimal" value={tier.pct} onChange={(e) => setTiers((all) => all.map((x, k) => (k === i ? { ...x, pct: e.target.value } : x)))} error={fieldError(`tiers.${i}.rate`)} />
                <button type="button" className="btn h-[2.4rem] px-2.5" aria-label={t('promo.removeTier', { n: i + 1 })} disabled={tiers.length <= 1} onClick={() => setTiers((all) => all.filter((_, k) => k !== i))}>
                  <X aria-hidden className="size-4" />
                </button>
              </div>
            ))}
            {tiers.length < 5 && (
              <div>
                <button type="button" className="btn" onClick={() => setTiers((all) => [...all, { min: '', pct: '' }])}>
                  <Plus aria-hidden className="size-4" /> {t('promo.addTier')}
                </button>
              </div>
            )}
            {fieldError('tiers') && <p className="hint text-red!">{fieldError('tiers')}</p>}
          </div>
        )}
        {termsPreview && (
          <p className="text-[0.9375rem]" role="status">
            {t('promo.reads')} <b className="money">{termsPreview}</b>
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-semibold">{t('promo.items')}</legend>
        <p className="-mt-1 text-[0.875rem] text-muted">{t('promo.itemsHint')}</p>
        <ItemPicker products={products} chosen={chosen} onAdd={(ids) => setItems((all) => [...all, ...ids.filter((x) => !all.includes(x))].slice(0, 500))} />
        {items.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[0.875rem]">{t('promo.itemCount', { n: items.length })}</span>
              <button type="button" className="btn h-8 px-2.5 text-[0.8125rem]" onClick={() => setItems([])}>{t('promo.clearItems')}</button>
            </div>
            <ul className="flex flex-wrap gap-1.5">
              {items.map((id) => {
                const v = byId.get(id) ?? savedName.get(id);
                return (
                  <li key={id} className="tag inline-flex items-center gap-1">
                    <span className="serial">{v?.sku ?? '—'}</span>
                    <span>{v?.label ?? ''}</span>
                    <button type="button" className="rounded-[3px] p-0.5 text-muted hover:text-red" aria-label={t('promo.removeItem', { name: v?.label ?? '' })} onClick={() => setItems((all) => all.filter((x) => x !== id))}>
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="text-[0.875rem] text-muted">{t('promo.noItems')}</p>
        )}
        {fieldError('variantIds') && <p className="hint text-red!">{fieldError('variantIds')}</p>}
      </fieldset>

      {branches.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">{t('promo.where')}</legend>
          <label className="flex items-center gap-2 text-[0.9375rem]">
            <input type="radio" name="where" checked={everywhere} onChange={() => setEverywhere(true)} className="size-4 accent-[var(--color-blue)]" /> {t('promo.allBranches')}
          </label>
          <label className="flex items-center gap-2 text-[0.9375rem]">
            <input type="radio" name="where" checked={!everywhere} onChange={() => setEverywhere(false)} className="size-4 accent-[var(--color-blue)]" /> {t('promo.someBranches')}
          </label>
          {!everywhere && (
            <div className="flex flex-wrap gap-x-4 gap-y-2 pl-6">
              {branches.map((b) => (
                <label key={b.id} className="flex items-center gap-2 text-[0.9375rem]">
                  <input
                    type="checkbox"
                    checked={chosenBranches.includes(b.id)}
                    onChange={(e) => setChosenBranches((all) => (e.target.checked ? [...all, b.id] : all.filter((x) => x !== b.id)))}
                    className="size-4 accent-[var(--color-blue)]"
                  />
                  <span className="serial font-semibold text-violet">{b.code}</span> {b.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-1 font-semibold">{t('promo.when')}</legend>
        <SelectField label={t('promo.starts')} value={startLater ? 'later' : 'now'} onChange={(e) => setStartLater(e.target.value === 'later')}>
          <option value="now">{t('promo.startNow')}</option>
          <option value="later">{t('promo.startLater')}</option>
        </SelectField>
        {startLater && (
          <TextField
            label={`${t('promo.starts')} (Asia/Manila)`}
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            error={fieldError('startsAt') ?? (error?.code === 'BACKDATED_PROMOTION' ? error.message : undefined)}
          />
        )}
        <TextField label={`${t('promo.ends')} (${t('common.optional')})`} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} hint={t('promo.endsHint')} error={fieldError('endsAt')} />
      </fieldset>

      <p className="max-w-[80ch] text-[0.8125rem] text-muted">{t('promo.rules')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('promo.create')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={local ?? (error?.code === 'BACKDATED_PROMOTION' ? null : apiMessage)} />
      </div>
    </form>
  );
}

/** "New promotion", or a copy of one to change its terms (open from the start). */
export function NewPromotion({ products, branches, copyOf }: { products: PickProduct[]; branches: { id: string; code: string; name: string }[]; copyOf: Promotion | null }) {
  const { t } = useT();
  const [open, setOpen] = useState(!!copyOf);
  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <Plus aria-hidden className="size-4" /> {t('promo.new')}
      </button>
    );
  }
  return (
    <div className="w-full rounded-[5px] border border-hair bg-white p-4">
      <p className="mb-3 font-semibold">{copyOf ? t('promo.copyTitle', { name: copyOf.name }) : t('promo.new')}</p>
      <PromotionFields close={() => setOpen(false)} products={products} branches={branches} copyOf={copyOf} />
    </div>
  );
}

/** Rename only: the terms of a promotion never change. */
export function RenamePromotion({ promotion }: { promotion: { id: string; name: string } }) {
  const { t } = useT();
  return (
    <Disclosure kind="edit" label={t('promo.rename')}>
      {(close) => <RenameFields close={close} promotion={promotion} />}
    </Disclosure>
  );
}

function RenameFields({ close, promotion }: { close: () => void; promotion: { id: string; name: string } }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
        const r = await submit('PATCH', `/api/v1/promotions/${promotion.id}`, { name });
        if (r.ok) close();
      }}
    >
      <TextField label={t('promo.name')} name="name" required autoFocus defaultValue={promotion.name} error={fieldError('name')} />
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      </div>
    </form>
  );
}
