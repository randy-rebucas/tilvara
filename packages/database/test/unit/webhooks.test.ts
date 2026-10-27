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
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
  });

  it('judges an IPv6 address that carries an IPv4 one by that address (audit 45 #2)', () => {
    const refused = [
      // what WHATWG URL makes of [::ffff:127.0.0.1] and friends
      '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:127.0.0.1', '::FFFF:169.254.169.254', '0:0:0:0:0:ffff:a00:1',
      '::7f00:1', '::127.0.0.1', '::ffff:0:a00:1', // IPv4-compatible and SIIT
      '64:ff9b::a9fe:a9fe', '64:ff9b::127.0.0.1', '64:ff9b::a00:1', '64:ff9b:1::808:808', // NAT64
      '2002:7f00:1::', '2002:a9fe:a9fe::1', '2002:c0a8:101::', // 6to4
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    ];
    for (const ip of refused) expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
    for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2a00:1450:4001:80b::200e', '2606:4700:4700::1111', '1.1.1.1', '93.184.216.34']) {
      expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
    }
  });

  it('refuses special-purpose, documentation, benchmarking and reserved ranges', () => {
    const refused = [
      '0.1.2.3', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9',
      '239.255.255.250', '240.0.0.1', '255.255.255.255', '100.127.255.255', '172.20.0.1',
      'ff02::1', 'fe80::1%eth0', 'febf::1', 'fc00::1', '2001:db8::1', '0:0:0:0:0:0:0:1', 'not-an-ip', '1.2.3', '',
    ];
    for (const ip of refused) expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
    for (const ip of ['100.128.0.1', '198.20.0.1', '192.0.3.1', '223.255.255.255', 'fec0::1', '2001:db9::1']) expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
  });
});
