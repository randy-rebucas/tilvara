'use client';

import { Archive, ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { LineItems, readLines, type VariantOption } from '@/components/line-items';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { Menu, MenuVersion, ModifierGroup, RestaurantSettings } from '@/lib/api';
import { percentFromRate, rateFromPercent } from '@/lib/format';

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

function Actions({ pending, general, submitLabel, close }: { pending: boolean; general: string | null | undefined; submitLabel: string; close?: () => void }) {
  const { t } = useT();
  return (
    <div className="col-span-full flex flex-wrap items-center gap-2">
      <button className="btn btn-primary" disabled={pending}>{submitLabel}</button>
      {close && <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>}
      <FormError message={general} />
    </div>
  );
}

/** A one-click change on a row (archive, make default, back in stock), with optional confirmation. */
export function RowAction({ method = 'POST', url, body, label, danger = false, confirmText, icon = false }: {
  method?: 'POST' | 'PATCH' | 'PUT';
  url: string;
  body?: unknown;
  label: string;
  danger?: boolean;
  confirmText?: string;
  /** A small icon-only archive button (with its label for screen readers), for dense tiles. */
  icon?: boolean;
}) {
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        className={icon ? 'grid size-9 place-items-center rounded-[4px] text-muted hover:bg-[#fff6f5] hover:text-red' : `btn h-[2.4rem] px-3 text-[0.875rem] ${danger ? 'btn-danger' : ''}`}
        disabled={pending}
        aria-label={icon ? label : undefined}
        title={icon ? label : undefined}
        onClick={() => {
          if (!confirmText || window.confirm(confirmText)) void submit(method, url, body ?? {});
        }}
      >
        {icon ? <Archive aria-hidden className="size-4" /> : label}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}

// ---------------------------------------------------------------- edits (PATCH)

type EditField = { name: string; label: string; value: string; numeric?: boolean; hint?: string };

/** Change a record's fields in place (rename a station or area, a choice group's bounds); only changed fields are sent. */
function PatchFields({ url, fields, close }: { url: string; fields: EditField[]; close: () => void }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {};
    for (const x of fields) {
      const v = text(f, x.name);
      if (v !== x.value) body[x.name] = x.numeric && /^\d+$/.test(v) ? Number(v) : v;
    }
    if (Object.keys(body).length === 0) return close();
    const r = await submit('PATCH', url, body);
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3" noValidate>
      {fields.map((x, i) => (
        <TextField key={x.name} label={x.label} name={x.name} defaultValue={x.value} autoFocus={i === 0} inputMode={x.numeric ? 'numeric' : undefined} hint={x.hint} error={fieldError(x.name)} />
      ))}
      <Actions pending={pending} general={general(error) ?? fieldError('')} submitLabel={t('common.save')} close={close} />
    </form>
  );
}

export function EditRecord({ label, url, fields }: { label: string; url: string; fields: EditField[] }) {
  return <Disclosure kind="edit" label={label}>{(close) => <PatchFields url={url} fields={fields} close={close} />}</Disclosure>;
}

/** Rename tables and change their seats, all tables of an area in one panel; each changed table is saved. */
function TablesFields({ tables, close }: { tables: { id: string; code: string; seats: number }[]; close: () => void }) {
  const { t } = useT();
  const router = useRouter();
  const { pending, submit, error } = useSubmit();
  const [failed, setFailed] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setFailed(null);
    for (const tb of tables) {
      const code = text(f, `code.${tb.id}`);
      const seats = text(f, `seats.${tb.id}`);
      const body: Record<string, unknown> = {};
      if (code !== tb.code) body.code = code;
      if (seats !== String(tb.seats)) body.seats = /^\d+$/.test(seats) ? Number(seats) : seats;
      if (Object.keys(body).length === 0) continue;
      const r = await submit('PATCH', `/api/v1/restaurant-tables/${tb.id}`, body, { refresh: false });
      if (!r.ok) {
        setFailed(tb.code);
        router.refresh();
        return;
      }
    }
    router.refresh();
    close();
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
      {tables.map((tb, i) => (
        <div key={tb.id} className="grid grid-cols-2 gap-2">
          <TextField label={t('rest.tableCode')} name={`code.${tb.id}`} defaultValue={tb.code} labelClassName={i > 0 ? 'sr-only' : undefined} />
          <TextField label={t('rest.seats')} name={`seats.${tb.id}`} defaultValue={String(tb.seats)} inputMode="numeric" labelClassName={i > 0 ? 'sr-only' : undefined} />
        </div>
      ))}
      <Actions pending={pending} general={failed ? `${failed}: ${error?.message ?? ''}` : null} submitLabel={t('common.save')} close={close} />
    </form>
  );
}

export function EditTablesForm({ tables }: { tables: { id: string; code: string; seats: number }[] }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('rest.editTables')}>{(close) => <TablesFields tables={tables} close={close} />}</Disclosure>;
}

// ---------------------------------------------------------------- floor

export function StationForm({ branchId }: { branchId: string }) {
  const { t } = useT();
  return (
    <Disclosure label={t('rest.addStation')}>
      {(close) => <StationFields branchId={branchId} close={close} />}
    </Disclosure>
  );
}

function StationFields({ branchId, close }: { branchId: string; close: () => void }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/v1/kitchen-stations', { branchId, code: text(f, 'code'), name: text(f, 'name'), isDefault: f.get('isDefault') === 'on' }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <TextField label={t('rest.stationCode')} name="code" hint={t('rest.stationCodeHint')} autoCapitalize="characters" error={fieldError('code')} />
      <TextField label={t('common.name')} name="name" error={fieldError('name')} />
      <label className="col-span-full flex items-center gap-2 text-[0.9375rem]">
        <input type="checkbox" name="isDefault" className="size-4" /> {t('rest.defaultStation')}
      </label>
      <Actions pending={pending} general={general(error)} submitLabel={t('rest.addStation')} close={close} />
    </form>
  );
}

export function AreaForm({ branchId }: { branchId: string }) {
  const { t } = useT();
  return (
    <Disclosure label={t('rest.addArea')}>
      {(close) => <SimpleNameForm url="/api/v1/dining-areas" body={{ branchId }} label={t('rest.areaName')} submitLabel={t('rest.addArea')} close={close} />}
    </Disclosure>
  );
}

function SimpleNameForm({ url, body, label, submitLabel, close, after }: { url: string; body: Record<string, unknown>; label: string; submitLabel: string; close: () => void; after?: (id: string) => void }) {
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await submit<{ id: string }>('POST', url, { ...body, name: text(new FormData(e.currentTarget), 'name') }, { idempotencyKey: key, refresh: !after });
    if (r.ok) {
      close();
      after?.(r.data.id);
    }
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start" noValidate>
      <TextField label={label} name="name" autoFocus error={fieldError('name')} />
      <Actions pending={pending} general={general(error)} submitLabel={submitLabel} close={close} />
    </form>
  );
}

export function TableForm({ areaId }: { areaId: string }) {
  const { t } = useT();
  return <Disclosure label={t('rest.addTable')}>{(close) => <TableFields areaId={areaId} close={close} />}</Disclosure>;
}

function TableFields({ areaId, close }: { areaId: string; close: () => void }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const seats = text(f, 'seats');
    const r = await submit('POST', '/api/v1/restaurant-tables', { areaId, code: text(f, 'code'), ...(seats && { seats: /^\d+$/.test(seats) ? Number(seats) : seats }) }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <TextField label={t('rest.tableCode')} name="code" autoFocus hint={t('rest.tableCodeHint')} error={fieldError('code')} />
      <TextField label={t('rest.seats')} name="seats" inputMode="numeric" defaultValue="4" error={fieldError('seats')} />
      <Actions pending={pending} general={general(error)} submitLabel={t('rest.addTable')} close={close} />
    </form>
  );
}

// ---------------------------------------------------------------- modifiers

export function ModifierGroupForm({ variants }: { variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('rest.addGroup')}>{(close) => <GroupFields variants={variants} close={close} />}</Disclosure>;
}

function GroupFields({ variants, close }: { variants: VariantOption[]; close: () => void }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const int = (k: string) => (/^\d+$/.test(text(f, k)) ? Number(text(f, k)) : text(f, k));
    const r = await submit('POST', '/api/v1/modifier-groups', {
      name: text(f, 'name'),
      minSelect: int('minSelect'),
      maxSelect: int('maxSelect'),
      options: readLines(f, ['name', 'variantId']).map((o) => ({ name: o.name, variantId: o.variantId || null })),
    }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3" noValidate>
      <TextField label={t('rest.groupName')} name="name" autoFocus hint={t('rest.groupNameHint')} error={fieldError('name')} />
      <TextField label={t('rest.minSelect')} name="minSelect" inputMode="numeric" defaultValue="0" hint={t('rest.minHint')} error={fieldError('minSelect')} />
      <TextField label={t('rest.maxSelect')} name="maxSelect" inputMode="numeric" defaultValue="1" error={fieldError('maxSelect')} />
      <p className="col-span-full text-[0.875rem] text-muted">{t('rest.optionsHint')}</p>
      <LineItems
        fields={[
          { name: 'name', label: t('rest.optionName'), kind: 'text' },
          { name: 'variantId', label: t('rest.pricedAs'), kind: 'select' },
        ]}
        options={variants}
        fieldError={fieldError}
        addLabel={t('rest.addOption')}
        removeLabel={t('common.removeLine')}
      />
      <Actions pending={pending} general={general(error) ?? fieldError('options')} submitLabel={t('rest.addGroup')} close={close} />
    </form>
  );
}

export function OptionForm({ groupId, variants }: { groupId: string; variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('rest.addOption')}>{(close) => <OptionFields groupId={groupId} variants={variants} close={close} />}</Disclosure>;
}

function OptionFields({ groupId, variants, close }: { groupId: string; variants: VariantOption[]; close: () => void }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', `/api/v1/modifier-groups/${groupId}/options`, { name: text(f, 'name'), variantId: text(f, 'variantId') || null }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <TextField label={t('rest.optionName')} name="name" autoFocus error={fieldError('name')} />
      <SelectField label={t('rest.pricedAs')} name="variantId" defaultValue="" hint={t('rest.pricedAsHint')}>
        <option value="">{t('rest.free')}</option>
        {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </SelectField>
      <Actions pending={pending} general={general(error)} submitLabel={t('rest.addOption')} close={close} />
    </form>
  );
}

// ---------------------------------------------------------------- menus

export function MenuForm() {
  const { t } = useT();
  const router = useRouter();
  return (
    <Disclosure label={t('rest.newMenu')}>
      {(close) => <SimpleNameForm url="/api/v1/menus" body={{}} label={t('rest.menuName')} submitLabel={t('rest.newMenu')} close={close} after={(id) => router.push(`/restaurant/menus/${id}`)} />}
    </Disclosure>
  );
}

interface DraftItem {
  key: string;
  variantId: string;
  displayName: string;
  stationCode: string;
  modifierGroupIds: string[];
}
interface DraftSection {
  key: string;
  name: string;
  items: DraftItem[];
}

const move = <T,>(xs: T[], i: number, by: -1 | 1) => {
  const j = i + by;
  if (j < 0 || j >= xs.length) return xs;
  const out = [...xs];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
};

/**
 * The draft menu editor: sections in order, each with items (a sellable item, an optional display
 * name, the kitchen station and the choices offered). Saving replaces the draft's whole content;
 * publishing freezes it and retires the previous version (ADR-0014 §2).
 */
export function MenuEditor({ draft, variants, groups, stations }: { draft: MenuVersion; variants: VariantOption[]; groups: ModifierGroup[]; stations: string[] }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  const publish = useSubmit();
  // Row keys for sections and items added in this editor (saved ones keep their server ids).
  const seq = useRef(0);
  const next = () => `n${seq.current++}`;
  const [sections, setSections] = useState<DraftSection[]>(() =>
    draft.sections.map((s) => ({
      key: s.id,
      name: s.name,
      items: s.items.map((i) => ({ key: i.id, variantId: i.variantId, displayName: i.displayName ?? '', stationCode: i.stationCode ?? '', modifierGroupIds: i.modifierGroupIds })),
    })),
  );
  const [dirty, setDirty] = useState(false);
  const edit = (fn: (s: DraftSection[]) => DraftSection[]) => {
    setSections(fn);
    setDirty(true);
  };
  const editSection = (si: number, fn: (s: DraftSection) => DraftSection) => edit((ss) => ss.map((s, i) => (i === si ? fn(s) : s)));
  const editItem = (si: number, ii: number, patch: Partial<DraftItem>) => editSection(si, (s) => ({ ...s, items: s.items.map((it, j) => (j === ii ? { ...it, ...patch } : it)) }));

  async function save() {
    const r = await submit('PUT', `/api/v1/menu-versions/${draft.id}/content`, {
      sections: sections.map((s) => ({
        name: s.name.trim(),
        items: s.items.map((i) => ({
          variantId: i.variantId,
          displayName: i.displayName.trim() || null,
          stationCode: i.stationCode || null,
          modifierGroupIds: i.modifierGroupIds,
        })),
      })),
    });
    if (r.ok) setDirty(false);
  }

  return (
    <div className="flex flex-col gap-4">
      {sections.length === 0 && <p className="text-muted">{t('rest.emptyDraft')}</p>}
      {sections.map((s, si) => (
        <div key={s.key} className="rounded-[5px] border border-hair bg-white p-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1">
              <TextField label={t('rest.sectionName')} name={`sections.${si}.name`} value={s.name} onChange={(e) => editSection(si, (x) => ({ ...x, name: e.target.value }))} error={fieldError(`sections.${si}.name`)} />
            </div>
            <button type="button" className="btn h-[2.4rem] px-2.5" aria-label={t('rest.moveUp')} disabled={si === 0} onClick={() => edit((ss) => move(ss, si, -1))}><ArrowUp aria-hidden className="size-4" /></button>
            <button type="button" className="btn h-[2.4rem] px-2.5" aria-label={t('rest.moveDown')} disabled={si === sections.length - 1} onClick={() => edit((ss) => move(ss, si, 1))}><ArrowDown aria-hidden className="size-4" /></button>
            <button type="button" className="btn btn-danger h-[2.4rem] px-2.5" aria-label={t('rest.removeSection')} onClick={() => edit((ss) => ss.filter((_, i) => i !== si))}><Trash2 aria-hidden className="size-4" /></button>
          </div>
          <ul className="mt-3 flex flex-col gap-3">
            {s.items.map((it, ii) => (
              <li key={it.key} className="grid gap-2 rounded-[5px] border border-hair-soft p-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_auto] lg:items-start">
                <SelectField label={t('common.item')} name={`sections.${si}.items.${ii}.variantId`} value={it.variantId} onChange={(e) => editItem(si, ii, { variantId: e.target.value })}>
                  <option value="" disabled>—</option>
                  {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </SelectField>
                <TextField label={`${t('rest.displayName')} (${t('common.optional')})`} name={`sections.${si}.items.${ii}.displayName`} value={it.displayName} maxLength={100} onChange={(e) => editItem(si, ii, { displayName: e.target.value })} error={fieldError(`sections.${si}.items.${ii}.displayName`)} />
                <SelectField label={t('rest.station')} name={`sections.${si}.items.${ii}.stationCode`} value={it.stationCode} onChange={(e) => editItem(si, ii, { stationCode: e.target.value })} hint={t('rest.stationHint')}>
                  <option value="">{t('rest.defaultStationShort')}</option>
                  {stations.map((c) => <option key={c} value={c}>{c}</option>)}
                </SelectField>
                <div className="flex items-end gap-1 lg:pt-[1.55rem]">
                  <button type="button" className="btn h-[2.4rem] px-2.5" aria-label={t('rest.moveUp')} disabled={ii === 0} onClick={() => editSection(si, (x) => ({ ...x, items: move(x.items, ii, -1) }))}><ArrowUp aria-hidden className="size-4" /></button>
                  <button type="button" className="btn h-[2.4rem] px-2.5" aria-label={t('rest.moveDown')} disabled={ii === s.items.length - 1} onClick={() => editSection(si, (x) => ({ ...x, items: move(x.items, ii, 1) }))}><ArrowDown aria-hidden className="size-4" /></button>
                  <button type="button" className="btn btn-danger h-[2.4rem] px-2.5" aria-label={t('rest.removeItem')} onClick={() => editSection(si, (x) => ({ ...x, items: x.items.filter((_, j) => j !== ii) }))}><Trash2 aria-hidden className="size-4" /></button>
                </div>
                {groups.length > 0 && (
                  <fieldset className="col-span-full flex flex-wrap items-center gap-x-4 gap-y-1">
                    <legend className="mb-1 text-[0.8125rem] font-semibold">{t('rest.choicesOffered')}</legend>
                    {groups.map((g) => (
                      <label key={g.id} className="flex items-center gap-2 text-[0.875rem]">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={it.modifierGroupIds.includes(g.id)}
                          onChange={(e) => editItem(si, ii, { modifierGroupIds: e.target.checked ? [...it.modifierGroupIds, g.id] : it.modifierGroupIds.filter((x) => x !== g.id) })}
                        />
                        {g.name}
                      </label>
                    ))}
                  </fieldset>
                )}
                {fieldError(`sections.${si}.items.${ii}.variantId`) && <p className="hint col-span-full text-red!">{fieldError(`sections.${si}.items.${ii}.variantId`)}</p>}
              </li>
            ))}
          </ul>
          <button type="button" className="btn mt-3" onClick={() => editSection(si, (x) => ({ ...x, items: [...x.items, { key: next(), variantId: '', displayName: '', stationCode: '', modifierGroupIds: [] }] }))}>
            <Plus aria-hidden className="size-4" /> {t('rest.addItem')}
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={() => edit((ss) => [...ss, { key: next(), name: '', items: [] }])}>
          <Plus aria-hidden className="size-4" /> {t('rest.addSection')}
        </button>
        <button type="button" className="btn btn-primary" disabled={pending || !dirty} onClick={() => void save()}>{t('rest.saveDraft')}</button>
        <button
          type="button"
          className="btn"
          disabled={publish.pending || dirty}
          title={dirty ? t('rest.saveFirst') : undefined}
          onClick={() => {
            if (window.confirm(t('rest.publishConfirm'))) void publish.submit('POST', `/api/v1/menu-versions/${draft.id}/publish`, {});
          }}
        >
          {t('rest.publish')}
        </button>
        {dirty && <span className="text-[0.875rem] text-muted">{t('rest.unsaved')}</span>}
        <FormError message={general(error) ?? fieldError('sections') ?? publish.error?.message} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- recipes

export function RecipeForm({ variantId, ingredients }: { variantId: string; ingredients: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('rest.newRecipe')}>{(close) => <RecipeFields variantId={variantId} ingredients={ingredients} close={close} />}</Disclosure>;
}

function RecipeFields({ variantId, ingredients, close }: { variantId: string; ingredients: VariantOption[]; close: () => void }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const from = text(f, 'effectiveFrom');
    const note = text(f, 'note');
    const r = await submit('POST', `/api/v1/variants/${variantId}/recipe`, {
      ingredients: readLines(f, ['variantId', 'quantity']).filter((l) => l.variantId || l.quantity),
      // datetime-local is the browser's local time; the API takes an instant with its offset.
      ...(from && { effectiveFrom: new Date(from).toISOString() }),
      ...(note && { note }),
    }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <p className="col-span-full -mt-2 text-[0.875rem] text-muted">{t('rest.recipeHint')}</p>
      <LineItems
        fields={[
          { name: 'variantId', label: t('rest.ingredient'), kind: 'select' },
          { name: 'quantity', label: t('rest.perPortion'), kind: 'decimal', placeholder: '0' },
        ]}
        options={ingredients}
        fieldError={(p) => fieldError(p.replace(/^lines\./, 'ingredients.'))}
        addLabel={t('common.addLine')}
        removeLabel={t('common.removeLine')}
      />
      <TextField label={`${t('rest.effectiveFrom')} (${t('common.optional')})`} name="effectiveFrom" type="datetime-local" hint={t('rest.effectiveHint')} error={fieldError('effectiveFrom')} />
      <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="note" error={fieldError('note')} />
      <Actions pending={pending} general={general(error) ?? fieldError('ingredients')} submitLabel={t('rest.saveRecipe')} close={close} />
    </form>
  );
}

// ---------------------------------------------------------------- branch settings and 86

export function SettingsForm({ branchId, settings, menus, vatSeller }: { branchId: string; settings: RestaurantSettings; menus: Menu[]; vatSeller: boolean }) {
  const { t } = useT();
  const { pending, submit, fieldError, error, setError } = useSubmit();
  const [saved, setSaved] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaved(false);
    const f = new FormData(e.currentTarget);
    const rate = rateFromPercent(text(f, 'rate') || '0');
    if (rate === null) {
      setError({ status: 400, code: 'VALIDATION_FAILED', message: '', details: { issues: [{ path: 'serviceChargeRate', message: t('rest.rateInvalid') }] } });
      return;
    }
    const r = await submit('PUT', `/api/v1/branches/${branchId}/restaurant-settings`, {
      dineInMenuId: text(f, 'dineInMenuId') || null,
      takeawayMenuId: text(f, 'takeawayMenuId') || null,
      serviceChargeRate: rate,
      serviceChargeDineIn: f.get('dineIn') === 'on',
      serviceChargeTakeaway: f.get('takeaway') === 'on',
      serviceChargeVatTreatment: text(f, 'vat') || 'VATABLE',
    });
    if (r.ok) setSaved(true);
  }
  const published = menus.filter((m) => m.published && !m.archivedAt);
  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <SelectField label={t('rest.dineInMenu')} name="dineInMenuId" defaultValue={settings.dineInMenuId ?? ''}>
        <option value="">{t('rest.noMenu')}</option>
        {published.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </SelectField>
      <SelectField label={t('rest.takeawayMenu')} name="takeawayMenuId" defaultValue={settings.takeawayMenuId ?? ''}>
        <option value="">{t('rest.noMenu')}</option>
        {published.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </SelectField>
      <TextField label={t('rest.serviceCharge')} name="rate" inputMode="decimal" defaultValue={percentFromRate(settings.serviceChargeRate)} hint={t('rest.serviceChargeHint')} error={fieldError('serviceChargeRate')} />
      <SelectField label={t('rest.chargeVat')} name="vat" defaultValue={settings.serviceChargeVatTreatment} hint={vatSeller ? t('rest.chargeVatHint') : t('rest.chargeNonVatHint')}>
        <option value="VATABLE">{t('rest.vatable')}</option>
        <option value="VAT_EXEMPT">{t('rest.vatExempt')}</option>
      </SelectField>
      <fieldset className="col-span-full flex flex-wrap gap-x-6 gap-y-2">
        <legend className="mb-1 text-[0.8125rem] font-semibold">{t('rest.chargeOn')}</legend>
        <label className="flex items-center gap-2"><input type="checkbox" name="dineIn" className="size-4" defaultChecked={settings.serviceChargeDineIn} /> {t('rest.dineIn')}</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="takeaway" className="size-4" defaultChecked={settings.serviceChargeTakeaway} /> {t('rest.takeaway')}</label>
      </fieldset>
      <p className="col-span-full text-[0.8125rem] text-muted">{t('rest.chargeLiability')}</p>
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
        {saved && <span role="status" className="text-[0.875rem] text-muted">{t('rest.saved')}</span>}
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

export function SoldOutForm({ branchId, variants }: { branchId: string; variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('rest.markSoldOut')}>{(close) => <SoldOutFields branchId={branchId} variants={variants} close={close} />}</Disclosure>;
}

function SoldOutFields({ branchId, variants, close }: { branchId: string; variants: VariantOption[]; close: () => void }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const note = text(f, 'note');
    const r = await submit('PUT', `/api/v1/branches/${branchId}/sold-out`, { variantId: text(f, 'variantId'), soldOut: true, ...(note && { note }) });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <SelectField label={t('common.item')} name="variantId" defaultValue="">
        <option value="" disabled>—</option>
        {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </SelectField>
      <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="note" maxLength={200} error={fieldError('note')} />
      <Actions pending={pending} general={general(error) ?? fieldError('variantId')} submitLabel={t('rest.markSoldOut')} close={close} />
    </form>
  );
}
