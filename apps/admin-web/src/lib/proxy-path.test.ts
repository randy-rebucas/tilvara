import { describe, expect, it } from 'vitest';
import { proxiedCacheControl, proxyTarget } from './proxy-path';

const API = 'http://127.0.0.1:4320/v1';
const ID = '0b6c1d9e-3f0a-4c55-9a3e-1f2b3c4d5e6f';

describe('proxyTarget (the /api/v1 proxy)', () => {
  it('forwards allowed resources with their ids and the query', () => {
    expect(proxyTarget(API, ['products'])).toBe(`${API}/products`);
    expect(proxyTarget(API, ['products', ID], '?q=a%20b&page=2')).toBe(`${API}/products/${ID}?q=a%20b&page=2`);
    expect(proxyTarget(API, ['supplier-payments', ID, 'void'])).toBe(`${API}/supplier-payments/${ID}/void`);
    expect(proxyTarget(API, ['sync', 'transactions'])).toBe(`${API}/sync/transactions`);
    expect(proxyTarget(`${API}/`, ['me'])).toBe(`${API}/me`);
  });

  it('refuses a decoded slash inside one segment (products%2F..%2Fauth%2Fhandoff)', () => {
    expect(proxyTarget(API, ['products/../auth/handoff'])).toBeNull();
    expect(proxyTarget(API, ['products/x'])).toBeNull();
  });

  it('refuses dot and empty segments', () => {
    expect(proxyTarget(API, ['products', '..', 'auth', 'handoff'])).toBeNull();
    expect(proxyTarget(API, ['products', '.'])).toBeNull();
    expect(proxyTarget(API, ['products', ''])).toBeNull();
    expect(proxyTarget(API, [])).toBeNull();
  });

  it('refuses backslashes, percent signs and control characters', () => {
    expect(proxyTarget(API, ['products\\..\\auth'])).toBeNull();
    expect(proxyTarget(API, ['products', '%2e%2e'])).toBeNull();
    expect(proxyTarget(API, ['products', 'a%2Fb'])).toBeNull();
    for (const c of ['\u0000', '\t', '\n', '\r', '\u001f', '\u007f']) expect(proxyTarget(API, ['products', `a${c}b`]), JSON.stringify(c)).toBeNull();
  });

  it('refuses resources off the allow-list', () => {
    expect(proxyTarget(API, ['auth', 'handoff'])).toBeNull();
    expect(proxyTarget(API, ['invitations', 'accept'])).toBeNull();
    expect(proxyTarget(API, ['productsx'])).toBeNull();
  });

  it('encodes other characters so they stay inside their segment', () => {
    expect(proxyTarget(API, ['products', 'a?b#c'])).toBe(`${API}/products/a%3Fb%23c`);
    expect(proxyTarget(API, ['products', 'a b'], 'nope')).toBe(`${API}/products/a%20b`);
  });
});

describe('proxiedCacheControl', () => {
  it('is private, no-store when the API sent nothing', () => {
    expect(proxiedCacheControl(null)).toBe('private, no-store');
    expect(proxiedCacheControl('')).toBe('private, no-store');
  });

  it('keeps the API’s own caching, but only in the browser', () => {
    expect(proxiedCacheControl('public, max-age=31536000, immutable')).toBe('private, max-age=31536000, immutable');
    expect(proxiedCacheControl('public, s-maxage=600, max-age=60, proxy-revalidate')).toBe('private, max-age=60');
    expect(proxiedCacheControl('no-store')).toBe('private, no-store');
    expect(proxiedCacheControl('private, no-cache')).toBe('private, no-cache');
  });
});
