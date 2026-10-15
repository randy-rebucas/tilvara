'use client';

import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { Branch, Role } from '@/lib/api';

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
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3" noValidate>
      <TextField label={t('auth.email')} name="email" type="email" required autoFocus error={fieldError('email')} />
      <SelectField label={t('team.role')} name="roleId" defaultValue={roles.find((r) => r.key === 'cashier')?.id}>
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </SelectField>
      <SelectField label={t('team.scope')} name="scope" defaultValue="TENANT">
        <option value="TENANT">{t('team.wholeBusiness')}</option>
        {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
      </SelectField>
      <div className="col-span-full flex flex-wrap items-center gap-2">
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
