import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFailure, withReference } from './api';

const failure = (status: number, correlationId?: string) =>
  new ApiFailure({ status, code: status >= 500 ? 'INTERNAL' : 'OUT_OF_STOCK', message: 'm', ...(correlationId ? { correlationId } : {}) });

describe('withReference', () => {
  it('adds the start of the correlation id when the server failed to finish', () => {
    expect(withReference('Not recorded.', failure(503, '0af76519-16cd-43dd-8448-eb211c80319c'))).toBe('Not recorded. · Ref. 0af76519');
  });

  it('adds it when no answer came back, as the request may have reached the server', () => {
    expect(withReference('No connection.', failure(0, '7d1c2e3f-0000-4000-8000-000000000000'))).toBe('No connection. · Ref. 7d1c2e3f');
  });

  it('leaves refusals and errors without an id alone', () => {
    expect(withReference('Out of stock.', failure(409, 'abcdef12-0000-0000-0000-000000000000'))).toBe('Out of stock.');
    expect(withReference('No connection.', failure(0))).toBe('No connection.');
    expect(withReference('No reference.', failure(500))).toBe('No reference.');
    expect(withReference('Oops.', new Error('x'))).toBe('Oops.');
  });
});

describe('api correlation ids', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends its own id with every request and keeps it when no answer comes back', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>)['x-correlation-id']!);
      throw new TypeError('Failed to fetch');
    }));
    const err = await api('POST', '/v1/sales', { a: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).error.status).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect((err as ApiFailure).error.correlationId).toBe(sent[0]);
  });

  it('uses a new id per request', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>)['x-correlation-id']!);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await api('GET', '/v1/me');
    await api('GET', '/v1/me');
    expect(new Set(sent).size).toBe(2);
  });
});
