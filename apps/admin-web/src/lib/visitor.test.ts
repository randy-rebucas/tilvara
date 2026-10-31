import { describe, expect, it } from 'vitest';
import { visitorIp } from './visitor';

describe('visitorIp (session 40)', () => {
  it('takes the address the nearest trusted proxy wrote, never one the browser put in front', () => {
    expect(visitorIp('203.0.113.7', 0)).toBe('203.0.113.7');
    expect(visitorIp('6.6.6.6, 203.0.113.7', 1)).toBe('203.0.113.7');
    expect(visitorIp('6.6.6.6, 203.0.113.7, 10.0.0.2', 2)).toBe('203.0.113.7');
  });

  it('has nothing to give without the header, or with fewer entries than proxies', () => {
    expect(visitorIp(null, 0)).toBeNull();
    expect(visitorIp('', 1)).toBeNull();
    expect(visitorIp('203.0.113.7', 2)).toBeNull();
  });

  it('in production trusts the header only behind a proxy (audit 47 #18)', () => {
    // No proxy: the browser's own X-Forwarded-For would be believed, so nothing is sent.
    expect(visitorIp('6.6.6.6', 0, true)).toBeNull();
    expect(visitorIp('6.6.6.6, 203.0.113.7', 1, true)).toBe('203.0.113.7');
    expect(visitorIp('6.6.6.6', 0, false)).toBe('6.6.6.6');
  });
});
