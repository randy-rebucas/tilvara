'use client';

import { useState } from 'react';
import { FormError, TextField } from './fields';
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
 * An action that needs a reason (cancel, close, reverse, reopen): the button opens an inline
 * panel with the reason field. `idempotent` pins one key per open panel (financial writes).
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
}: {
  url: string;
  label: string;
  reasonLabel: string;
  hint?: string;
  field?: string;
  body?: Record<string, unknown>;
  danger?: boolean;
  idempotent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className={`btn ${danger ? 'btn-danger' : ''}`} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return <ReasonPanel {...{ url, label, reasonLabel, hint, field, body, danger, idempotent }} close={() => setOpen(false)} />;
}

function ReasonPanel({
  url, label, reasonLabel, hint, field, body, danger, idempotent, close,
}: { url: string; label: string; reasonLabel: string; hint?: string; field: string; body: Record<string, unknown>; danger: boolean; idempotent: boolean; close: () => void }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get(field) ?? '').trim();
    const r = await submit('POST', url, { ...body, [field]: reason }, idempotent ? { idempotencyKey: key } : {});
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} noValidate className="flex w-full flex-col gap-3 rounded-[5px] border border-hair bg-white p-4">
      <p className="font-semibold">{label}</p>
      {hint && <p className="-mt-2 text-[0.875rem] text-muted">{hint}</p>}
      <TextField label={reasonLabel} name={field} required autoFocus error={fieldError(field)} />
      <div className="flex flex-wrap items-center gap-2">
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={pending}>{label}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      </div>
    </form>
  );
}
