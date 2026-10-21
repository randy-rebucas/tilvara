'use client';

import { CSRF_HEADER } from './cookies';

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** The API's X-Correlation-Id for this request: the reference support looks up in the logs. */
  correlationId?: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

/**
 * Browser → same-origin BFF. Mutations carry the CSRF header and, when asked, an
 * Idempotency-Key so a double click or a retried request never creates two records.
 * `idempotencyKey` pins the key: stock and books documents keep one key per form, so a
 * resubmit after "no answer" replays the first outcome instead of posting a second document.
 */
export async function send<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  opts: { idempotent?: boolean; idempotencyKey?: string } = {},
): Promise<Result<T>> {
  // Minted here and forwarded by the BFF, so a request whose answer never came still has a reference.
  const correlationId = crypto.randomUUID();
  const headers: Record<string, string> = { 'content-type': 'application/json', [CSRF_HEADER]: '1', 'x-correlation-id': correlationId };
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  else if (opts.idempotent) headers['idempotency-key'] = crypto.randomUUID();
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const e = (json as { error?: ApiFailure } | null)?.error;
      const reference = e?.correlationId ?? res.headers.get('x-correlation-id') ?? correlationId;
      return { ok: false, error: { status: res.status, code: e?.code ?? 'ERROR', message: e?.message ?? 'Request failed', details: e?.details, correlationId: reference } };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, error: { status: 0, code: 'NETWORK', message: 'Network error. Check your connection and try again.', correlationId } };
  }
}
