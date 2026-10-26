'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import type { Branch, LegalEntity, Member, Role } from '@/lib/api';
import { permissionGroupsFor, PRIVILEGED_PERMISSIONS } from '@/lib/permissions';

// ---------------------------------------------------------------- roles
/** A custom role's name and permissions (the key is set once, at creation). */
function RoleFields({ close, role, extensions }: { close: () => void; role?: Role; extensions: string[] }) {
  const { t } = useT();
  const router = useRouter();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const permissions = f.getAll('permissions').map(String);
    const name = String(f.get('name') ?? '').trim();
    if (role) {
      const r = await submit('PATCH', `/api/v1/roles/${role.id}`, { name, permissions });
      if (r.ok) close();
      return;
    }
    const r = await submit<{ id: string }>('POST', '/api/v1/roles', { key: String(f.get('key') ?? '').trim(), name, permissions }, { idempotent: true, refresh: false });
    if (r.ok) {
      close();
      router.push(`/team/roles/${r.data.id}`);
    }
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <TextField span={role ? 'full' : 'half'} label={t('team.roleName')} name="name" required autoFocus defaultValue={role?.name} error={fieldError('name')} />
      {!role && <TextField span="half" label={t('team.roleKey')} name="key" required hint={t('team.roleKeyHint')} error={fieldError('key')} />}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-[0.875rem] font-semibold">{t('team.permissions')}</legend>
        <p className="text-[0.8125rem] text-muted">{t('team.privilegedNote')}</p>
        <div className="grid gap-4 @2xl:grid-cols-2">
          {permissionGroupsFor(extensions, role?.permissions).map((g) => (
            <div key={g.key} className="rounded-[5px] border border-hair-soft p-3">
              <p className="mb-2 text-[0.8125rem] font-semibold uppercase tracking-[0.06em] text-muted">{t(`permGroup.${g.key}` as MessageKey)}</p>
              <ul className="grid gap-1.5">
                {g.codes.map((code) => (
                  <li key={code}>
                    <label className="flex items-start gap-2 text-[0.9375rem]">
                      <input type="checkbox" name="permissions" value={code} defaultChecked={role?.permissions.includes(code)} className="mt-1 size-4 accent-[var(--color-blue)]" />
                      <span>
                        {t(`perm.${code}` as MessageKey)}
                        {PRIVILEGED_PERMISSIONS.includes(code) && <span className="ml-1.5 text-[0.75rem] text-muted">({t('team.privileged')})</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {fieldError('permissions') && <p className="hint text-red!">{fieldError('permissions')}</p>}
      </fieldset>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={pending}>{role ? t('common.save') : t('common.create')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      </div>
    </form>
  );
}

/** `extensions`: the business's usable extensions (their permission areas show in the editor). */
export function NewRoleForm({ extensions }: { extensions: string[] }) {
  const { t } = useT();
  return <Disclosure wide label={t('team.newRole')}>{(close) => <RoleFields close={close} extensions={extensions} />}</Disclosure>;
}

export function EditRoleForm({ role, extensions }: { role: Role; extensions: string[] }) {
  const { t } = useT();
  return <Disclosure wide kind="edit" label={t('team.editRole')}>{(close) => <RoleFields close={close} role={role} extensions={extensions} />}</Disclosure>;
}

// ---------------------------------------------------------------- member access
type Row = { key: number; roleId: string; scope: string };
const scopeValue = (a: { scopeType: string; scopeId: string | null }) => (a.scopeType === 'TENANT' ? 'TENANT' : `${a.scopeType}:${a.scopeId}`);

/** A member's role assignments, edited as lines (role + where it applies); saving replaces them all. */
function AccessFields({ close, member, roles, branches, entities }: { close: () => void; member: Member; roles: Role[]; branches: Branch[]; entities: LegalEntity[] }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [rows, setRows] = useState<Row[]>(() =>
    member.roles.length ? member.roles.map((a, i) => ({ key: i, roleId: a.roleId, scope: scopeValue(a) })) : [{ key: 0, roleId: roles[0]?.id ?? '', scope: 'TENANT' }],
  );
  const [next, setNext] = useState(rows.length);
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = rows.map((r) => {
      if (r.scope === 'TENANT') return { roleId: r.roleId, scopeType: 'TENANT', scopeId: null };
      const [scopeType, scopeId] = r.scope.split(':');
      return { roleId: r.roleId, scopeType, scopeId };
    });
    const res = await submit('PUT', `/api/v1/members/${member.membershipId}/roles`, { roles: body });
    if (res.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <p className="form-lede">{t('team.accessHint')}</p>
      {rows.map((r, i) => (
        <div key={r.key} className="grid gap-2 @lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] @lg:items-end">
          <div className="field min-w-0">
            <label htmlFor={`role-${r.key}`} className={i > 0 ? '@lg:sr-only' : undefined}>{t('team.role')}</label>
            <select id={`role-${r.key}`} className="input" value={r.roleId} onChange={(e) => update(r.key, { roleId: e.target.value })}>
              {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
            </select>
          </div>
          <div className="field min-w-0">
            <label htmlFor={`scope-${r.key}`} className={i > 0 ? '@lg:sr-only' : undefined}>{t('team.scope')}</label>
            <select id={`scope-${r.key}`} className="input" value={r.scope} onChange={(e) => update(r.key, { scope: e.target.value })}>
              <option value="TENANT">{t('team.wholeBusiness')}</option>
              {entities.map((le) => <option key={le.id} value={`LEGAL_ENTITY:${le.id}`}>{t('team.legalEntity', { name: le.registeredName })}</option>)}
              {branches.map((b) => <option key={b.id} value={`BRANCH:${b.id}`}>{b.code} · {b.name}</option>)}
            </select>
          </div>
          <button type="button" className="btn h-[2.4rem] px-2.5" aria-label={`${t('team.removeAccess')} ${i + 1}`} disabled={rows.length <= 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
            <Trash2 aria-hidden className="size-4" />
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn" onClick={() => { setRows((rs) => [...rs, { key: next, roleId: roles[0]?.id ?? '', scope: 'TENANT' }]); setNext((n) => n + 1); }}>
          <Plus aria-hidden className="size-4" /> {t('team.addAccess')}
        </button>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error?.message} />
      </div>
    </form>
  );
}

export function AccessForm(props: { member: Member; roles: Role[]; branches: Branch[]; entities: LegalEntity[] }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('team.editAccess')}>{(close) => <AccessFields close={close} {...props} />}</Disclosure>;
}

function InviteFields({ close, roles, branches, onSent }: { close: () => void; roles: Role[]; branches: Branch[]; onSent: (email: string) => void }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const scope = String(f.get('scope'));
    const email = String(f.get('email'));
    const r = await submit('POST', '/api/v1/invitations', {
      email,
      roles: [{ roleId: f.get('roleId'), scopeType: scope === 'TENANT' ? 'TENANT' : 'BRANCH', scopeId: scope === 'TENANT' ? null : scope }],
    }, { idempotent: true });
    if (r.ok) {
      close();
      onSent(email);
    }
  }
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <TextField label={t('auth.email')} name="email" type="email" required autoFocus error={fieldError('email')} />
      <SelectField span="half" label={t('team.role')} name="roleId" defaultValue={roles.find((r) => r.key === 'cashier')?.id}>
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </SelectField>
      <SelectField span="half" label={t('team.scope')} name="scope" defaultValue="TENANT">
        <option value="TENANT">{t('team.wholeBusiness')}</option>
        {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
      </SelectField>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={pending}>{t('team.invite')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      </div>
    </form>
  );
}

export function InviteForm({ roles, branches }: { roles: Role[]; branches: Branch[] }) {
  const { t } = useT();
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-2">
      {sent && <p role="status" className="text-[0.875rem] text-ink">{t('team.inviteSent', { email: sent })}</p>}
      <Disclosure label={t('team.invite')}>
        {(close) => <InviteFields close={close} roles={roles} branches={branches} onSent={setSent} />}
      </Disclosure>
    </div>
  );
}
