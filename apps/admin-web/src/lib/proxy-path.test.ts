import { describe, expect, it } from 'vitest';
import { proxiedCacheControl, proxyTarget } from './proxy-path';

const API = 'http://127.0.0.1:4320/v1';
const ID = '0b6c1d9e-3f0a-4c55-9a3e-1f2b3c4d5e6f';

describe('proxyTarget (the /api/v1 proxy)', () => {
  const write = (segments: string[], search = '', method = 'POST') => proxyTarget(API, segments, search, method);

  it('forwards writes to allowed resources with their ids and the query', () => {
    expect(write(['products'])).toBe(`${API}/products`);
    expect(write(['products', ID], '?q=a%20b&page=2', 'PATCH')).toBe(`${API}/products/${ID}?q=a%20b&page=2`);
    expect(write(['supplier-payments'])).toBe(`${API}/supplier-payments`);
    expect(write(['supplier-payments', ID, 'void'])).toBe(`${API}/supplier-payments/${ID}/void`);
    expect(write(['sync', 'transactions', ID, 'retry'])).toBe(`${API}/sync/transactions/${ID}/retry`);
    expect(write(['business', 'branding', 'logo'], '', 'PUT')).toBe(`${API}/business/branding/logo`);
    expect(proxyTarget(`${API}/`, ['me'], '', 'PATCH')).toBe(`${API}/me`);
  });

  it('GETs only what the browser itself loads: branding images and a data export file', () => {
    expect(proxyTarget(API, ['business', 'branding', 'logo'], '?v=abc')).toBe(`${API}/business/branding/logo?v=abc`);
    expect(proxyTarget(API, ['business', 'branding', 'background'])).toBe(`${API}/business/branding/background`);
    expect(proxyTarget(API, ['data-export-files', 'tok-123'])).toBe(`${API}/data-export-files/tok-123`);
    for (const path of [['products'], ['products', ID], ['me'], ['customers'], ['journal-entries'], ['business'], ['business', 'branding'], ['data-exports'], ['data-export-files'], ['data-export-files', 'a', 'b'], ['stock', 'transfers']]) {
      expect(proxyTarget(API, path), path.join('/')).toBeNull();
      expect(proxyTarget(API, path, '', 'GET'), path.join('/')).toBeNull();
    }
  });

  it('refuses a data export file or a branding image as a write, and any other method', () => {
    expect(write(['data-export-files', 'tok-123'])).toBeNull();
    expect(write(['products'], '', 'DELETE')).toBeNull();
    expect(write(['products'], '', 'HEAD')).toBeNull();
    expect(write(['products'], '', 'OPTIONS')).toBeNull();
  });

  it('reaches only the owner’s billing writes under subscription (ADR-0027), not the rest of it', () => {
    expect(write(['subscription', 'plan'])).toBe(`${API}/subscription/plan`);
    expect(write(['subscription', 'cancel'])).toBe(`${API}/subscription/cancel`);
    expect(write(['subscription', 'bills', ID, 'checkout'])).toBe(`${API}/subscription/bills/${ID}/checkout`);
    expect(write(['subscription'])).toBeNull();
    expect(write(['subscription', 'bills'])).toBeNull();
    expect(write(['subscription', 'bills', 'x', 'checkout'])).toBeNull();
    expect(write(['billing', 'webhooks', 'paymongo'])).toBeNull();
  });

  it('refuses a decoded slash inside one segment (products%2F..%2Fauth%2Fhandoff)', () => {
    expect(write(['products/../auth/handoff'])).toBeNull();
    expect(write(['products/x'])).toBeNull();
    expect(proxyTarget(API, ['business/branding/logo'])).toBeNull();
  });

  it('refuses dot and empty segments', () => {
    expect(write(['products', '..', 'auth', 'handoff'])).toBeNull();
    expect(write(['products', '.'])).toBeNull();
    expect(write(['products', ''])).toBeNull();
    expect(write([])).toBeNull();
    expect(proxyTarget(API, ['data-export-files', '..'])).toBeNull();
  });

  it('refuses backslashes, percent signs and control characters', () => {
    expect(write(['products\\..\\auth'])).toBeNull();
    expect(write(['products', '%2e%2e'])).toBeNull();
    expect(write(['products', 'a%2Fb'])).toBeNull();
    for (const c of ['\u0000', '\t', '\n', '\r', '\u001f', '\u007f']) expect(write(['products', `a${c}b`]), JSON.stringify(c)).toBeNull();
  });

  it('refuses resources off the allow-list', () => {
    expect(write(['auth', 'handoff'])).toBeNull();
    expect(write(['invitations', 'accept'])).toBeNull();
    expect(write(['productsx'])).toBeNull();
  });

  it('encodes other characters so they stay inside their segment', () => {
    expect(write(['products', 'a?b#c'])).toBe(`${API}/products/a%3Fb%23c`);
    expect(write(['products', 'a b'], 'nope')).toBe(`${API}/products/a%20b`);
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
