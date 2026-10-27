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
});
