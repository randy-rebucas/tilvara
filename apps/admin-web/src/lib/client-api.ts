'use client';

import { CSRF_HEADER } from './cookies';

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

/**
 * Browser → same-origin BFF. Mutations carry the CSRF header and, when asked, a fresh
 * Idempotency-Key so a double click or a retried request never creates two records.
 */
export async function send<T>(
  method: 'POST' | 'PATCH' | 'PUT',
  url: string,
  body?: unknown,
  opts: { idempotent?: boolean } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json', [CSRF_HEADER]: '1' };
  if (opts.idempotent) headers['idempotency-key'] = crypto.randomUUID();
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const e = (json as { error?: ApiFailure } | null)?.error;
      return { ok: false, error: { status: res.status, code: e?.code ?? 'ERROR', message: e?.message ?? 'Request failed', details: e?.details } };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, error: { status: 0, code: 'NETWORK', message: 'Network error. Check your connection and try again.' } };
  }
}
