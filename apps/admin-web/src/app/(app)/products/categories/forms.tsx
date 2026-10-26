'use client';

import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { Category } from '@/lib/api';

type Option = { id: string; label: string };
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);

function Actions({ pending, label, close, error }: { pending: boolean; label: string; close: () => void; error: string | null }) {
  const { t } = useT();
  return (
    <div className="form-actions">
      <button className="btn btn-primary" disabled={pending}>{label}</button>
      <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
      <FormError message={error} />
    </div>
  );
}

function ParentField({ parents, value, error }: { parents: Option[]; value: string; error?: string }) {
  const { t } = useT();
  return (
    <SelectField span="half" label={t('cat.parent')} name="parentId" defaultValue={value} error={error}>
      <option value="">{t('cat.top')}</option>
      {parents.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
    </SelectField>
  );
}

/** A new category; `parentId` fixes where it goes (a row's "Add sub-category"). One key per open form (POST /categories is idempotent). */
function AddFields({ close, parents, parentId }: { close: () => void; parents: Option[]; parentId?: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parent = parentId ?? text(f, 'parentId');
    const order = text(f, 'sortOrder');
    const r = await submit('POST', '/api/v1/categories', {
      name: text(f, 'name'),
      parentId: parent || null,
      ...(/^\d+$/.test(order) ? { sortOrder: Number(order) } : {}),
    }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <TextField span={parentId ? 'half' : 'full'} label={t('cat.name')} name="name" required autoFocus maxLength={200} error={fieldError('name')} />
      {!parentId && <ParentField parents={parents} value="" error={fieldError('parentId')} />}
      <TextField span="half" label={`${t('cat.sortOrder')} (${t('common.optional')})`} name="sortOrder" inputMode="numeric" placeholder="0" hint={t('cat.sortOrderHint')} error={fieldError('sortOrder')} />
      <Actions pending={pending} label={t('common.create')} close={close} error={general(error)} />
    </form>
  );
}

export function AddCategory({ parents }: { parents: Option[] }) {
  const { t } = useT();
  return <Disclosure label={t('cat.add')}>{(close) => <AddFields close={close} parents={parents} />}</Disclosure>;
}

export function AddSubCategory({ parentId, parentName }: { parentId: string; parentName: string }) {
  const { t } = useT();
  return <Disclosure label={t('cat.addSub')}>{(close) => <><p className="form-lede mb-4">{t('cat.under', { name: parentName })}</p><AddFields close={close} parents={[]} parentId={parentId} /></>}</Disclosure>;
}

/** Rename, move under another category (never under itself or one of its own), or reorder; only changed fields are sent. */
function EditFields({ close, category, parents }: { close: () => void; category: Category; parents: Option[] }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {};
    const name = text(f, 'name');
    const parent = text(f, 'parentId') || null;
    const order = text(f, 'sortOrder');
    if (name !== category.name) body.name = name;
    if (parent !== category.parentId) body.parentId = parent;
    if (/^\d+$/.test(order) && Number(order) !== category.sortOrder) body.sortOrder = Number(order);
    if (Object.keys(body).length === 0) return close();
    const r = await submit('PATCH', `/api/v1/categories/${category.id}`, body);
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <TextField label={t('cat.name')} name="name" required autoFocus maxLength={200} defaultValue={category.name} error={fieldError('name')} />
      <ParentField parents={parents} value={category.parentId ?? ''} error={fieldError('parentId')} />
      <TextField span="half" label={t('cat.sortOrder')} name="sortOrder" inputMode="numeric" defaultValue={String(category.sortOrder)} hint={t('cat.sortOrderHint')} error={fieldError('sortOrder')} />
      <Actions pending={pending} label={t('common.save')} close={close} error={general(error)} />
    </form>
  );
}

export function EditCategory({ category, parents }: { category: Category; parents: Option[] }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('cat.edit')}>{(close) => <EditFields close={close} category={category} parents={parents} />}</Disclosure>;
}
