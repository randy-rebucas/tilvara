'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { send, type ApiFailure, type Result } from '@/lib/client-api';
import { refusalKey } from '@/lib/refusals';

/** Form submission state: pending flag, last error, field issues; refreshes server data on success. */
export interface ValidationIssue {
  path: string;
  message: string;
  code?: string;
  origin?: string;
  minimum?: number;
  maximum?: number;
  format?: string;
}

/**
 * Generic zod issues get translated wording; schema-authored messages (e.g. the business web
 * address rule, regex hints) are specific and kept as sent.
 */
export function issueMessage(issue: ValidationIssue, t: ReturnType<typeof useT>['t']): string {
  const { code, origin, minimum, maximum, format } = issue;
  if (code === 'invalid_type') return t('validation.required');
  if (code === 'too_small' && origin === 'string') return minimum === 1 ? t('validation.required') : t('validation.minLength', { n: minimum ?? 0 });
  if (code === 'too_big' && origin === 'string') return t('validation.maxLength', { n: maximum ?? 0 });
  if (code === 'too_small' && origin === 'array' && minimum === 1) return t('validation.required');
  if (code === 'invalid_format' && format === 'email') return t('validation.email');
  if (code === 'invalid_format' && format === 'uuid') return t('validation.choose');
  return issue.message;
}

export function useSubmit() {
  const router = useRouter();
  const { t } = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  async function submit<T>(
    method: 'POST' | 'PATCH' | 'PUT',
    url: string,
    body?: unknown,
    /** `refreshOnError`: the server records something even when it refuses (e.g. a counted attempt). */
    opts: { idempotent?: boolean; idempotencyKey?: string; refresh?: boolean; refreshOnError?: boolean } = {},
  ): Promise<Result<T>> {
    setPending(true);
    setError(null);
    const r = await send<T>(method, url, body, opts);
    setPending(false);
    if (!r.ok) {
      // The server failed to finish (5xx) or no answer came: give the person the reference support can look up.
      const ref = (r.error.status >= 500 || r.error.status === 0) && r.error.correlationId;
      // A known refusal reads in the person's language (the API's message is English).
      const known = !ref && refusalKey(r.error.code, r.error.message);
      // No answer at all: the client's own words are English, so the person's language takes over here.
      const message = r.error.status === 0 ? t('error.network') : r.error.message;
      setError(ref ? { ...r.error, message: t('error.reference', { message, ref }) } : known ? { ...r.error, message: t(known) } : r.error);
      if (opts.refreshOnError) router.refresh();
    } else if (opts.refresh !== false) router.refresh();
    return r;
  }

  /** Field-level message from a VALIDATION_FAILED response, if any, in the UI language. */
  function fieldError(path: string): string | undefined {
    const issues = (error?.details?.issues as ValidationIssue[] | undefined) ?? [];
    const issue = issues.find((i) => i.path === path);
    return issue && issueMessage(issue, t);
  }

  return { pending, error, setError, submit, fieldError };
}

/**
 * One Idempotency-Key per open form (a remount gets a new one). Failed requests leave no
 * idempotency record, so correcting the form and resubmitting with the same key is safe.
 */
export function useFormKey() {
  const [key] = useState(() => crypto.randomUUID());
  return key;
}
