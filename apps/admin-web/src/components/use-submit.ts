'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { send, type ApiFailure, type Result } from '@/lib/client-api';

/** Form submission state: pending flag, last error, field issues; refreshes server data on success. */
export function useSubmit() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  async function submit<T>(
    method: 'POST' | 'PATCH' | 'PUT',
    url: string,
    body?: unknown,
    opts: { idempotent?: boolean; refresh?: boolean } = {},
  ): Promise<Result<T>> {
    setPending(true);
    setError(null);
    const r = await send<T>(method, url, body, opts);
    setPending(false);
    if (!r.ok) setError(r.error);
    else if (opts.refresh !== false) router.refresh();
    return r;
  }

  /** Field-level message from a VALIDATION_FAILED response, if any. */
  function fieldError(path: string): string | undefined {
    const issues = (error?.details?.issues as { path: string; message: string }[] | undefined) ?? [];
    return issues.find((i) => i.path === path)?.message;
  }

  return { pending, error, setError, submit, fieldError };
}
