'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { CountSheet, InventorySettings, NegativeStockPolicy } from '@/lib/api';
import { qty, sameDecimal, signed } from '@/lib/format';

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);

// ---------------------------------------------------------------- start a sheet

function StartSheetFields({ close, branchId }: { close: () => void; branchId: string }) {
  const { t } = useT();
  const router = useRouter();
  const { pending, submit, error, fieldError } = useSubmit();
  // One Idempotency-Key per open form, so a retry after no answer is the same request (replayed by the API, not done twice).
  const formKey = useFormKey();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const notes = String(f.get('notes') ?? '').trim();
    const r = await submit<{ id: string }>('POST', '/api/v1/stock/count-sheets', { branchId, blind: f.get('blind') === 'on', ...(notes ? { notes } : {}) }, { refresh: false, idempotencyKey: formKey });
    if (r.ok) {
      close();
      router.push(`/inventory/count-sheets/${r.data.id}`);
    }
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <p className="form-lede">{t('sheet.startHint')}</p>
      <label className="check">
        <input type="checkbox" name="blind" defaultChecked />
        <span>
          {t('sheet.blind')}
          <span className="hint">{t('sheet.blindHint')}</span>
        </span>
      </label>
      <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="notes" error={fieldError('notes')} />
      <div className="form-actions">
        <button className="btn btn-primary" disabled={pending}>{t('sheet.start')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error?.code === 'SHEET_OPEN' ? t('sheet.oneOpen') : general(error)} />
      </div>
    </form>
  );
}

export function StartSheetForm({ branchId }: { branchId: string }) {
  const { t } = useT();
  return <Disclosure label={t('sheet.start')}>{(close) => <StartSheetFields close={close} branchId={branchId} />}</Disclosure>;
}

// ---------------------------------------------------------------- counting

/** Count lines per save request: the API's cap (`countSheetLinesSchema`, packages/validation). */
const SAVE_CHUNK = 1000;

/**
 * One field per item. Only the fields this person typed in are kept here (`edits`); every other field
 * shows what the server has, so a colleague's counts appear after a refresh and are never sent back.
 * A save sends only the edited lines that differ from the server (as decimals: "5.0" is "5"), then hands
 * those lines back to the server's values. Frozen quantities appear only when the API sends them; on a
 * blind sheet an adjuster still has to ask to see them.
 */
export function SheetCounter({ sheet, canPost }: { sheet: CountSheet; canPost: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const save = useSubmit();
  const post = useSubmit();
  const cancel = useSubmit();
  const [edits, setEdits] = useState<Record<string, string>>({});
  // True through every part of a save (each part is its own request; `save.pending` drops between them).
  const [saving, setSaving] = useState(false);
  // What the last save answered, shown until the refreshed sheet arrives (then the sheet itself is newer).
  const [saved, setSaved] = useState<{ base: CountSheet; lines: Record<string, string | null> } | null>(null);
  const justSaved = saved && saved.base === sheet ? saved.lines : {};
  const serverValue = (variantId: string, fallback: string | null) => (variantId in justSaved ? justSaved[variantId] : fallback) ?? '';
  const values: Record<string, string> = Object.fromEntries(sheet.lines.map((l) => [l.variantId, edits[l.variantId] ?? serverValue(l.variantId, l.countedQuantity)]));
  const [reveal, setReveal] = useState(!sheet.blind);
  const [filter, setFilter] = useState('');
  const open = sheet.status === 'OPEN';
  const changed = sheet.lines.filter((l) => edits[l.variantId] !== undefined && !sameDecimal(edits[l.variantId]!, serverValue(l.variantId, l.countedQuantity)));
  const showExpected = sheet.expectedShown && (reveal || !open);
  const shown = sheet.lines.filter((l) => !filter || `${l.sku} ${l.name} ${l.location ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const counted = sheet.lines.filter((l) => l.countedQuantity !== null).length;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (changed.length === 0 || saving) return;
    const sent = changed.map((l) => ({ variantId: l.variantId, countedQuantity: (edits[l.variantId] ?? '').trim() === '' ? null : edits[l.variantId]!.trim() }));
    setSaving(true);
    try {
      // The API takes at most 1,000 lines a request (countSheetLinesSchema) and a sheet holds up to 5,000:
      // one request per 1,000, one after the other. Each line sets a count outright, so a part that was
      // saved before a later part failed stays saved, and saving again resends only what still differs.
      for (let i = 0; i < sent.length; i += SAVE_CHUNK) {
        const part = sent.slice(i, i + SAVE_CHUNK);
        const last = i + SAVE_CHUNK >= sent.length;
        const r = await save.submit<CountSheet>('PUT', `/api/v1/stock/count-sheets/${sheet.id}/lines`, { lines: part }, { refresh: last });
        if (!r.ok) {
          if (i > 0) router.refresh(); // the parts already saved show the server's numbers
          return;
        }
        const typed = new Map(part.map((x) => [x.variantId, edits[x.variantId]]));
        // The saved lines show the server's numbers again (and pick up later counts by others).
        const answered = new Map(r.data.lines.map((l) => [l.variantId, l.countedQuantity]));
        setSaved((s) => ({ base: sheet, lines: { ...(s && s.base === sheet ? s.lines : {}), ...Object.fromEntries(part.map((x) => [x.variantId, answered.get(x.variantId) ?? null])) } }));
        // A count retyped while the save was on its way is kept: it is newer than what was sent.
        setEdits((e) => Object.fromEntries(Object.entries(e).filter(([v, value]) => !typed.has(v) || value !== typed.get(v))));
      }
    } finally {
      setSaving(false);
    }
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
                      onChange={(e) => {
                        const typed = e.target.value;
                        setEdits((v) => ({ ...v, [l.variantId]: typed }));
                      }}
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
            <button className="btn btn-primary" disabled={saving || save.pending || changed.length === 0}>
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
                  className="form-grid"
                  noValidate
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
                    const r = await cancel.submit('POST', `/api/v1/stock/count-sheets/${sheet.id}/cancel`, { reason });
                    if (r.ok) close();
                  }}
                >
                  <TextField label={t('sheet.cancelReason')} name="reason" error={cancel.fieldError('reason')} />
                  <div className="form-actions">
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

/** `dated`: the shop uses expiry dates; else the expired-stock rule and expiry alerts are hidden and left as they are. */
export function InventorySettingsForm({ settings, canEdit, dated }: { settings: InventorySettings; canEdit: boolean; dated: boolean }) {
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
          ...(dated && String(f.get('expiryAlertDays') ?? '').trim() !== '' ? { expiryAlertDays: Number(f.get('expiryAlertDays')) } : {}),
          // Two choices; a branch never set reads as Allow (`expiredStockRule`) and is saved as such.
          ...(dated ? { expiredStock: f.get('expiredStock') === 'BLOCK' ? 'BLOCK' : 'ALLOW' } : {}),
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
      {dated && (
        <>
          <fieldset className="flex flex-col gap-3" disabled={!canEdit}>
            <legend className="mb-1 font-semibold">{t('invset.expired')}</legend>
            {(['ALLOW', 'BLOCK'] as const).map((v) => (
              <label key={v} className="flex items-start gap-2">
                <input type="radio" name="expiredStock" value={v} defaultChecked={(settings.expiredStockRule ?? 'ALLOW') === v} className="mt-1" />
                <span>
                  {t(`invset.expired.${v}`)}
                  <span className="block text-[0.8125rem] text-muted">{t(`invset.expired.${v}.hint`)}</span>
                </span>
              </label>
            ))}
            <p className="text-[0.875rem] text-muted">{t('invset.expiredHolds')}</p>
          </fieldset>
          <fieldset disabled={!canEdit} className="max-w-[320px]">
            <TextField label={t('invset.expiryDays')} name="expiryAlertDays" type="number" min={0} max={365} inputMode="numeric" defaultValue={String(settings.expiryAlertDays ?? 30)} hint={t('invset.expiryDaysHint')} error={fieldError('expiryAlertDays')} />
          </fieldset>
        </>
      )}
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
