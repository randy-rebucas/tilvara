'use client';

import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';

/** As @1pos/validation lists them (API_KEY_SCOPES, WEBHOOK_TOPIC_NAMES). */
export const SCOPES = ['org.read', 'catalog.read', 'sales.read', 'inventory.read', 'reports.read', 'customers.read'] as const;
export const TOPICS = ['sale.completed', 'sale.returned', 'sale.voided', 'stock.low', 'stock.below_zero'] as const;

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);

/** A secret shown once: the person copies it now; it cannot be shown again. */
function ShownOnce({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const { t } = useT();
  return (
    <div className="grid gap-2 rounded-[5px] border border-orange bg-white p-4" data-testid="shown-once">
      <p className="font-semibold">{label}</p>
      <code className="block break-all rounded bg-paper px-3 py-2 font-mono text-[0.875rem]">{value}</code>
      <p className="text-[0.8125rem] text-muted">{t('int.shownOnce')}</p>
      <div className="flex gap-2">
        <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(value)}>{t('int.copy')}</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onDone}>{t('int.copied')}</button>
      </div>
    </div>
  );
}

/** `scopes`: the ones the person holds (a key reads no more than its maker; the API refuses others). */
function KeyFields({ close, scopes }: { close: () => void; scopes: readonly (typeof SCOPES)[number][] }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  const [made, setMade] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const days = Number(f.get('validDays') ?? 0);
    const r = await submit<{ key: string }>('POST', '/api/v1/api-keys', {
      name: String(f.get('keyName') ?? '').trim(),
      scopes: scopes.filter((s) => f.get(`scope-${s}`) === 'on'),
      ...(days > 0 && { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() }),
    });
    if (r.ok) setMade(r.data.key);
  }
  if (made) return <ShownOnce label={t('int.keyMade')} value={made} onDone={close} />;
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <TextField label={t('int.keyName')} name="keyName" required maxLength={100} placeholder={t('int.keyNameHint')} error={fieldError('name')} />
      <fieldset className="grid gap-1">
        <legend className="mb-1 text-[0.875rem] font-semibold">{t('int.scopes')}</legend>
        {scopes.map((s) => (
          <label key={s} className="flex items-center gap-2 text-[0.9375rem]">
            <input type="checkbox" name={`scope-${s}`} defaultChecked={s === 'reports.read' || s === 'org.read'} /> {t(`int.scope.${s}` as MessageKey)}
          </label>
        ))}
        {fieldError('scopes') && <p className="hint text-red!">{fieldError('scopes')}</p>}
      </fieldset>
      <SelectField label={t('int.validFor')} name="validDays" defaultValue="0" hint={fieldError('expiresAt') ?? undefined}>
        <option value="0">{t('int.validForever')}</option>
        {[30, 90, 365].map((n) => <option key={n} value={n}>{t('int.validDays', { n })}</option>)}
      </SelectField>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={pending}>{t('int.createKey')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

/** `held`: the person's permission codes (from /me); without them every scope is offered and the API decides. */
export function CreateKeyForm({ held }: { held?: readonly string[] }) {
  const { t } = useT();
  const scopes = held ? SCOPES.filter((s) => held.includes(s)) : SCOPES;
  return <Disclosure label={t('int.newKey')}>{(close) => <KeyFields close={close} scopes={scopes} />}</Disclosure>;
}

function WebhookFields({ close }: { close: () => void }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  const [made, setMade] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const description = String(f.get('hookDescription') ?? '').trim();
    const r = await submit<{ secret: string }>('POST', '/api/v1/webhooks', {
      url: String(f.get('hookUrl') ?? '').trim(),
      topics: TOPICS.filter((x) => f.get(`topic-${x}`) === 'on'),
      ...(description && { description }),
    });
    if (r.ok) setMade(r.data.secret);
  }
  if (made) return <ShownOnce label={t('int.secretMade')} value={made} onDone={close} />;
  return (
    <form onSubmit={onSubmit} className="form-grid" noValidate>
      <TextField label={t('int.url')} name="hookUrl" type="url" required placeholder="https://" error={fieldError('url')} />
      <TextField label={`${t('int.description')} (${t('common.optional')})`} name="hookDescription" maxLength={200} error={fieldError('description')} />
      <fieldset className="grid gap-1">
        <legend className="mb-1 text-[0.875rem] font-semibold">{t('int.topics')}</legend>
        {TOPICS.map((x) => (
          <label key={x} className="flex items-center gap-2 text-[0.9375rem]">
            <input type="checkbox" name={`topic-${x}`} defaultChecked={x === 'sale.completed'} /> {t(`int.topic.${x}` as MessageKey)}
          </label>
        ))}
        {fieldError('topics') && <p className="hint text-red!">{fieldError('topics')}</p>}
      </fieldset>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={pending}>{t('int.createHook')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

export function CreateWebhookForm() {
  const { t } = useT();
  return <Disclosure label={t('int.newHook')}>{(close) => <WebhookFields close={close} />}</Disclosure>;
}

/** A new signing secret: the old one stops working at once. */
export function RotateSecretButton({ id }: { id: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [secret, setSecret] = useState<string | null>(null);
  if (secret) return <ShownOnce label={t('int.secretMade')} value={secret} onDone={() => setSecret(null)} />;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending}
        onClick={async () => {
          if (!window.confirm(t('int.rotateConfirm'))) return;
          const r = await submit<{ secret: string }>('POST', `/api/v1/webhooks/${id}/rotate-secret`, {});
          if (r.ok) setSecret(r.data.secret);
        }}
      >
        {t('int.rotate')}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}
