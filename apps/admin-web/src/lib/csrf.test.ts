import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { rejectCrossSite } from './csrf';

const req = (headers: Record<string, string>) => new NextRequest('http://127.0.0.1:3320/api/v1/products', { method: 'POST', headers });

describe('rejectCrossSite', () => {
  it('lets a same-origin request with the CSRF header through', () => {
    expect(rejectCrossSite(req({ origin: 'http://127.0.0.1:3320', host: '127.0.0.1:3320', 'x-onepos-request': '1' }))).toBeNull();
  });

  it('answers 403 (not 500) to Origin: null and to an Origin that is no URL', async () => {
    for (const origin of ['null', 'not a url', '', 'file://']) {
      const r = rejectCrossSite(req({ origin, host: '127.0.0.1:3320', 'x-onepos-request': '1' }));
      expect(r?.status, origin).toBe(403);
      expect((await r!.json()).error.code).toBe('FORBIDDEN');
    }
  });

  it('refuses another origin, a missing Origin and a missing CSRF header', () => {
    expect(rejectCrossSite(req({ origin: 'https://evil.example', host: '127.0.0.1:3320', 'x-onepos-request': '1' }))?.status).toBe(403);
    expect(rejectCrossSite(req({ host: '127.0.0.1:3320', 'x-onepos-request': '1' }))?.status).toBe(403);
    expect(rejectCrossSite(req({ origin: 'http://127.0.0.1:3320', host: '127.0.0.1:3320' }))?.status).toBe(403);
  });
});
