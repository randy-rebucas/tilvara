'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { CountSheet, InventorySettings, NegativeStockPolicy } from '@/lib/api';
import { qty, signed } from '@/lib/format';

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);

// ---------------------------------------------------------------- start a sheet

function StartSheetFields({ close, branchId }: { close: () => void; branchId: string }) {
  const { t } = useT();
  const router = useRouter();
  const { pending, submit, error, fieldError } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const notes = String(f.get('notes') ?? '').trim();
    const r = await submit<{ id: string }>('POST', '/api/v1/stock/count-sheets', { branchId, blind: f.get('blind') === 'on', ...(notes ? { notes } : {}) }, { refresh: false });
    if (r.ok) {
      close();
      router.push(`/inventory/count-sheets/${r.data.id}`);
    }
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      <p className="-mt-2 text-[0.875rem] text-muted">{t('sheet.startHint')}</p>
      <label className="flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" name="blind" defaultChecked className="mt-1" />
        <span>
          {t('sheet.blind')}
          <span className="block text-[0.8125rem] text-muted">{t('sheet.blindHint')}</span>
        </span>
      </label>
      <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="notes" error={fieldError('notes')} />
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('sheet.start')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

export function StartSheetForm({ branchId }: { branchId: string }) {
  const { t } = useT();
  return <Disclosure label={t('sheet.start')}>{(close) => <StartSheetFields close={close} branchId={branchId} />}</Disclosure>;
}

// ---------------------------------------------------------------- counting

/**
 * One field per item. Counts are saved for the changed lines only, so two people counting
 * different shelves do not overwrite each other. Frozen quantities appear only when the API sends
 * them; on a blind sheet an adjuster still has to ask to see them.
 */
export function SheetCounter({ sheet, canPost }: { sheet: CountSheet; canPost: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const save = useSubmit();
  const post = useSubmit();
  const cancel = useSubmit();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(sheet.lines.map((l) => [l.variantId, l.countedQuantity ?? ''])));
  const [reveal, setReveal] = useState(!sheet.blind);
  const [filter, setFilter] = useState('');
  const open = sheet.status === 'OPEN';
  const changed = sheet.lines.filter((l) => (values[l.variantId] ?? '').trim() !== (l.countedQuantity ?? ''));
  const showExpected = sheet.expectedShown && (reveal || !open);
  const shown = sheet.lines.filter((l) => !filter || `${l.sku} ${l.name} ${l.location ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const counted = sheet.lines.filter((l) => l.countedQuantity !== null).length;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (changed.length === 0) return;
    await save.submit('PUT', `/api/v1/stock/count-sheets/${sheet.id}/lines`, {
      lines: changed.map((l) => ({ variantId: l.variantId, countedQuantity: (values[l.variantId] ?? '').trim() === '' ? null : values[l.variantId]!.trim() })),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[0.9375rem]" data-testid="sheet-progress">{t('sheet.progress', { counted, lines: sheet.lines.length })}</p>
        <div className="flex flex-wrap items-center gap-3">
          {open && sheet.blind && sheet.expectedShown && (
            <label className="flex items-center gap-2 text-[0.875rem]">
              <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
              {t('sheet.showExpected')}
            </label>
          )}
          <div className="field">
            <label htmlFor="sheet-filter" className="sr-only">{t('sheet.filter')}</label>
            <input id="sheet-filter" className="input h-9" placeholder={t('sheet.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        </div>
      </div>
      {!sheet.expectedShown && <p className="text-[0.875rem] text-muted">{t('sheet.blindNote')}</p>}

      <form onSubmit={onSave} noValidate className="flex flex-col gap-3">
        <ul className="flex flex-col">
          {shown.map((l) => {
            const moved = l.movedSinceFreeze && l.movedSinceFreeze !== '0' ? l.movedSinceFreeze : null;
            return (
              <li key={l.id} className="grid gap-2 border-b border-hair-soft py-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="font-semibold">
                    {/* Shelf location (ADR-0021 §5): the sheet runs in shelf order. */}
                    {l.location && <span className="tag serial mr-2 align-middle text-ink!" title={t('shelf.location')}>{l.location}</span>}
                    {l.name}
                  </div>
                  <div className="serial text-[0.8125rem] text-muted">
                    {l.sku}
                    {showExpected && l.expectedQuantity !== undefined && <> · {t('sheet.frozen')} {qty(l.expectedQuantity)}</>}
                    {showExpected && l.varianceQuantity && <> · {t('inv.variance')} <b className="text-ink">{signed(l.varianceQuantity, qty)}</b></>}
                    {showExpected && moved && <> · {t('sheet.moved', { n: signed(moved, qty) })}</>}
                    {l.countedBy && <> · {l.countedBy}</>}
                  </div>
                </div>
                {open ? (
                  <div className="field w-full sm:w-36">
                    <label htmlFor={`c-${l.id}`} className="sr-only">{t('inv.counted')}: {l.name}</label>
                    <input
                      id={`c-${l.id}`}
                      name={`counted-${l.variantId}`}
                      className="input text-right"
                      inputMode="decimal"
                      placeholder={t('sheet.notCounted')}
                      value={values[l.variantId] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [l.variantId]: e.target.value }))}
                    />
                  </div>
                ) : (
                  <b className="text-right">{l.countedQuantity === null ? <span className="text-muted">{t('sheet.notCounted')}</span> : qty(l.countedQuantity)}</b>
                )}
              </li>
            );
          })}
        </ul>
        {open && (
          <div className="sticky bottom-0 -mx-2 flex flex-wrap items-center gap-2 border-t border-hair-soft bg-paper px-2 py-3">
            <button className="btn btn-primary" disabled={save.pending || changed.length === 0}>
              {changed.length ? t('sheet.save', { n: changed.length }) : t('sheet.saved')}
            </button>
            <FormError message={save.error?.code === 'VALIDATION_FAILED' ? t('sheet.badNumber') : save.error?.message} />
          </div>
        )}
      </form>

      {open && canPost && (
        <div className="flex flex-col gap-3 border-t border-hair-soft pt-4">
          <p className="text-[0.875rem] text-muted">{t('sheet.postHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={post.pending || changed.length > 0 || counted === 0}
              onClick={async () => {
                const r = await post.submit<{ count: { id: string } }>('POST', `/api/v1/stock/count-sheets/${sheet.id}/post`, undefined, { idempotencyKey: key, refresh: false });
                if (r.ok) router.push(`/inventory/counts/${r.data.count.id}`);
              }}
            >
              {t('sheet.post', { n: counted })}
            </button>
            <Disclosure label={t('sheet.cancel')}>
              {(close) => (
                <form
                  className="flex flex-col gap-3"
                  noValidate
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
                    const r = await cancel.submit('POST', `/api/v1/stock/count-sheets/${sheet.id}/cancel`, { reason });
                    if (r.ok) close();
                  }}
                >
                  <TextField label={t('sheet.cancelReason')} name="reason" error={cancel.fieldError('reason')} />
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="btn btn-danger" disabled={cancel.pending}>{t('sheet.cancel')}</button>
                    <button type="button" className="btn" onClick={close}>{t('sheet.keepCounting')}</button>
                    <FormError message={general(cancel.error)} />
                  </div>
                </form>
              )}
            </Disclosure>
            <FormError message={post.error?.message} />
          </div>
          {changed.length > 0 && <p className="text-[0.875rem] text-gold">{t('sheet.saveFirst')}</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings

const POLICIES: NegativeStockPolicy[] = ['ALLOW', 'ALLOW_WITH_FLAG', 'BLOCK'];

export function InventorySettingsForm({ settings, canEdit }: { settings: InventorySettings; canEdit: boolean }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const [done, setDone] = useState(false);
  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setDone(false);
        const r = await submit('PUT', `/api/v1/branches/${settings.branchId}/inventory-settings`, {
          negativeStockPolicy: f.get('negativeStockPolicy'),
          lowStockAlerts: f.get('lowStockAlerts') === 'on',
          ...(String(f.get('expiryAlertDays') ?? '').trim() !== '' ? { expiryAlertDays: Number(f.get('expiryAlertDays')) } : {}),
          // ADR-0025 §4: '' = the business type's default (Never sell expired for a pharmacy).
          ...(settings.expiredStockRule ? { expiredStock: f.get('expiredStock') === 'BLOCK' ? 'BLOCK' : f.get('expiredStock') === 'ALLOW' ? 'ALLOW' : null } : {}),
        });
        if (r.ok) setDone(true);
      }}
    >
      <fieldset className="flex flex-col gap-3" disabled={!canEdit}>
        <legend className="mb-1 font-semibold">{t('invset.policy')}</legend>
        {POLICIES.map((p) => (
          <label key={p} className="flex items-start gap-2">
            <input type="radio" name="negativeStockPolicy" value={p} defaultChecked={settings.negativeStockPolicy === p} className="mt-1" />
            <span>
              {t(`invset.${p}`)}
              <span className="block text-[0.8125rem] text-muted">{t(`invset.${p}.hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset disabled={!canEdit}>
        <label className="flex items-start gap-2">
          <input type="checkbox" name="lowStockAlerts" defaultChecked={settings.lowStockAlerts} className="mt-1" />
          <span>
            {t('invset.alerts')}
            <span className="block text-[0.8125rem] text-muted">{t('invset.alertsHint')}</span>
          </span>
        </label>
      </fieldset>
      {settings.expiredStockRule && (
        <fieldset className="flex flex-col gap-3" disabled={!canEdit}>
          <legend className="mb-1 font-semibold">{t('invset.expired')}</legend>
          {(['', 'BLOCK', 'ALLOW'] as const).map((v) => (
            <label key={v || 'DEFAULT'} className="flex items-start gap-2">
              <input type="radio" name="expiredStock" value={v} defaultChecked={(settings.expiredStock ?? '') === v} className="mt-1" />
              <span>
                {t(`invset.expired.${v || 'DEFAULT'}`)}
                <span className="block text-[0.8125rem] text-muted">{t(`invset.expired.${v || 'DEFAULT'}.hint`)}</span>
              </span>
            </label>
          ))}
          <p className="text-[0.875rem]" data-testid="expired-rule">{t('invset.expiredInForce', { rule: t(`invset.expired.${settings.expiredStockRule}`) })}</p>
        </fieldset>
      )}
      <fieldset disabled={!canEdit} className="max-w-[320px]">
        <TextField label={t('invset.expiryDays')} name="expiryAlertDays" type="number" min={0} max={365} inputMode="numeric" defaultValue={String(settings.expiryAlertDays ?? 30)} hint={t('invset.expiryDaysHint')} error={fieldError('expiryAlertDays')} />
      </fieldset>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
          {done && <span role="status" className="text-[0.875rem] text-green">{t('invset.saved')}</span>}
          <FormError message={error?.message} />
        </div>
      ) : (
        <p className="text-[0.875rem] text-muted">{t('invset.ownerOnly')}</p>
      )}
    </form>
  );
}
