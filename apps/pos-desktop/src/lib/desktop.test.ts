import { describe, expect, it } from 'vitest';
import { normalizeApiUrl } from './desktop';

describe('normalizeApiUrl', () => {
  it('keeps the origin of an https address', () => {
    expect(normalizeApiUrl(' https://api.1pos.ph/ ')).toBe('https://api.1pos.ph');
    expect(normalizeApiUrl('https://api.1pos.ph:8443/v1/health')).toBe('https://api.1pos.ph:8443');
  });

  it('allows plain http only to this computer', () => {
    expect(normalizeApiUrl('http://127.0.0.1:4320')).toBe('http://127.0.0.1:4320');
    expect(normalizeApiUrl('http://localhost:4399/')).toBe('http://localhost:4399');
    expect(normalizeApiUrl('http://192.168.1.10:4320')).toBeNull(); // the terminal key would cross the LAN unencrypted
    expect(normalizeApiUrl('http://api.1pos.ph')).toBeNull();
  });

  it('refuses what is not a web address', () => {
    expect(normalizeApiUrl('api.1pos.ph')).toBeNull();
    expect(normalizeApiUrl('ftp://api.1pos.ph')).toBeNull();
    expect(normalizeApiUrl('')).toBeNull();
  });
});
