import { describe, expect, it } from 'vitest';
import { isPublicAddress, signatureHeader, verifySignature, webhookRetryDelay, webhookSecret } from '../../src/webhooks.js';

describe('webhook signing (ADR-0019)', () => {
  it('derives a stable secret per endpoint and salt, and a new one when the salt rotates', () => {
    const a = webhookSecret('k'.repeat(40), 'endpoint-1', 'salt-1');
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(webhookSecret('k'.repeat(40), 'endpoint-1', 'salt-1')).toBe(a);
    expect(webhookSecret('k'.repeat(40), 'endpoint-1', 'salt-2')).not.toBe(a);
    expect(webhookSecret('k'.repeat(40), 'endpoint-2', 'salt-1')).not.toBe(a);
  });

  it('signs timestamp and body; a receiver verifies it and refuses tampering or a stale timestamp', () => {
    const body = '{"id":"d1","type":"sale.completed"}';
    const header = signatureHeader('whsec_x', 1_700_000_000, body);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature('whsec_x', header, body, 1_700_000_010)).toBe(true);
    expect(verifySignature('whsec_x', header, body.replace('d1', 'd2'), 1_700_000_010)).toBe(false);
    expect(verifySignature('whsec_y', header, body, 1_700_000_010)).toBe(false);
    expect(verifySignature('whsec_x', header, body, 1_700_000_000 + 301)).toBe(false);
  });

  it('backs off from 30 s to a 6 h cap', () => {
    for (let i = 0; i < 20; i++) {
      expect(webhookRetryDelay(1)).toBeGreaterThanOrEqual(24);
      expect(webhookRetryDelay(1)).toBeLessThanOrEqual(36);
      expect(webhookRetryDelay(20)).toBeLessThanOrEqual(6 * 3600 * 1.2);
    }
  });

  it('refuses addresses inside the hosting network', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '203.0.113.9', '2606:4700::1111']) expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
  });
});
