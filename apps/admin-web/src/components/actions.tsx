'use client';

import { useState } from 'react';
import { FormError, SelectField, TextField } from './fields';
import { Sheet } from './sheet';
import { useFormKey, useSubmit } from './use-submit';
import { useT } from '@/i18n/client';

/** A one-click state change (approve) with optional confirmation and inline error. */
export function ActionButton({ url, label, body, primary = false, confirmText, refreshOnError = false, method = 'POST' }: { url: string; label: string; body?: unknown; primary?: boolean; confirmText?: string; refreshOnError?: boolean; method?: 'POST' | 'PATCH' | 'PUT' }) {
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={`btn ${primary ? 'btn-primary' : ''}`}
        disabled={pending}
        onClick={() => {
          if (!confirmText || window.confirm(confirmText)) void submit(method, url, body ?? {}, { refreshOnError });
        }}
      >
        {label}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}

/**
 * An action that needs a reason (cancel, close, reverse, reopen): the button opens a sheet
 * with the reason field. `idempotent` pins one key per open panel (financial writes).
 */
export function ReasonAction({
  url,
  label,
  reasonLabel,
  hint,
  field = 'reason',
  body = {},
  danger = false,
  idempotent = false,
  choice,
}: {
  url: string;
  label: string;
  reasonLabel: string;
  hint?: string;
  field?: string;
  body?: Record<string, unknown>;
  danger?: boolean;
  idempotent?: boolean;
  /** A pick-list sent with the reason under `name` (e.g. the open shift whose drawer takes cash back). */
  choice?: { name: string; label: string; options: { value: string; label: string }[] };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn ${danger ? 'btn-danger' : ''}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {label}
      </button>
      <Sheet open={open} title={label} onClose={() => setOpen(false)}>
        <ReasonPanel {...{ url, label, reasonLabel, hint, field, body, danger, idempotent, choice }} close={() => setOpen(false)} />
      </Sheet>
    </>
  );
}

function ReasonPanel({
  url, label, reasonLabel, hint, field, body, danger, idempotent, choice, close,
}: { url: string; label: string; reasonLabel: string; hint?: string; field: string; body: Record<string, unknown>; danger: boolean; idempotent: boolean; choice?: { name: string; label: string; options: { value: string; label: string }[] }; close: () => void }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const reason = String(f.get(field) ?? '').trim();
    const picked = choice ? { [choice.name]: String(f.get(choice.name) ?? '') } : {};
    const r = await submit('POST', url, { ...body, ...picked, [field]: reason }, idempotent ? { idempotencyKey: key } : {});
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} noValidate className="form-grid">
      {hint && <p className="form-lede">{hint}</p>}
      <TextField label={reasonLabel} name={field} required autoFocus error={fieldError(field)} />
      {choice && (
        <SelectField label={choice.label} name={choice.name} error={fieldError(choice.name)}>
          {choice.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </SelectField>
      )}
      <div className="form-actions">
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={pending || (choice !== undefined && choice.options.length === 0)}>{label}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      </div>
    </form>
  );
}
