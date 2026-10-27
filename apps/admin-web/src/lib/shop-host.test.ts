import { describe, expect, it } from 'vitest';
import { safeNext } from './next-path';
import { shopOrigin, shopSlugOfHost } from './shop-host';

describe('shopSlugOfHost (session 40)', () => {
  const of = (host: string | null) => shopSlugOfHost(host, 'tilvara.ph', 'https://app.tilvara.ph');

  it('reads a shop from its own subdomain, with or without a port', () => {
    expect(of('alpha-mart.tilvara.ph')).toBe('alpha-mart');
    expect(of('Alpha-Mart.Tilvara.PH:443')).toBe('alpha-mart');
    expect(of('alpha-mart.tilvara.ph.')).toBe('alpha-mart');
  });

  it('is never a shop on the main admin, the bare domain, other domains or deeper names', () => {
    for (const host of ['app.tilvara.ph', 'tilvara.ph', 'alpha.tilvara.ph.evil.com', 'alpha.eviltilvara.ph', 'a.b.tilvara.ph', null, '']) {
      expect(of(host), String(host)).toBeNull();
    }
  });

  it('skips reserved and non-DNS labels', () => {
    for (const host of ['www.tilvara.ph', 'api.tilvara.ph', 'acme-.tilvara.ph', 'xn--abc.tilvara.ph']) expect(of(host), host).toBeNull();
  });

  it('is off without a shop domain', () => {
    expect(shopSlugOfHost('alpha.tilvara.ph', null, 'https://app.tilvara.ph')).toBeNull();
  });
});

describe('shopOrigin and safeNext (session 41)', () => {
  it('builds the shop address with the main admin’s scheme and port', () => {
    expect(shopOrigin('my-store', 'tilvara.ph', 'https://app.tilvara.ph')).toBe('https://my-store.tilvara.ph');
    expect(shopOrigin('my-store', 'localhost', 'http://app.localhost:3320')).toBe('http://my-store.localhost:3320');
  });

  it('has no address when addresses are off or the slug cannot be one', () => {
    expect(shopOrigin('my-store', null, 'https://app.tilvara.ph')).toBeNull();
    expect(shopOrigin('my-store', 'tilvara.ph', null)).toBeNull();
    expect(shopOrigin('admin', 'tilvara.ph', 'https://app.tilvara.ph')).toBeNull();
    expect(shopOrigin('a.b', 'tilvara.ph', 'https://app.tilvara.ph')).toBeNull();
  });

  it('keeps next inside the admin', () => {
    expect(safeNext('/products?q=1')).toBe('/products?q=1');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '', null, 42]) expect(safeNext(bad)).toBe('/');
    expect(safeNext('/accept-invite?token=abc')).toBe('/accept-invite?token=abc');
  });

  it('refuses control characters and backslashes anywhere (browsers strip tab/newline, read \\ as /)', () => {
    for (const bad of ['/\t/evil.example', '/\n/evil.example', '/\r//evil.example', '/\u0000/x', '/x\u007f', '/\u001f', '/products\\x', '\\\\evil.example', 'products', ' /x']) {
      expect(safeNext(bad), JSON.stringify(bad)).toBe('/');
    }
  });
});
