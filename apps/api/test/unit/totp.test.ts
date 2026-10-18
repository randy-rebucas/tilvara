import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  hotp,
  matchTotp,
  newRecoveryCodes,
  otpauthUri,
  SecretBox,
  stepAt,
} from '../../src/auth/totp.js';

// RFC 6238 appendix B, SHA-1 seed; the 8-digit values' last 6 digits are the 6-digit codes.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors', () => {
    for (const [t, code] of RFC_VECTORS) expect([t, hotp(RFC_SECRET, stepAt(t))]).toEqual([t, code]);
  });

  it('RFC 4226 HOTP vectors (counter 0..3)', () => {
    expect([0, 1, 2, 3].map((c) => hotp(RFC_SECRET, c))).toEqual(['755224', '287082', '359152', '969429']);
  });

  it('accepts one step of drift either way and returns the step the code belongs to', () => {
    const t = 1234567890;
    const step = stepAt(t);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step), t)).toBe(step);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), t)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), t)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), t)).toBeNull();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), t)).toBeNull();
  });

  it('refuses malformed codes', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456']) expect(matchTotp(RFC_SECRET, bad, 59)).toBeNull();
  });

  it('base32 round-trips and matches RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW 6YTB OI').toString()).toBe('foobar');
    expect(base32Decode(base32Encode(RFC_SECRET))).toEqual(RFC_SECRET);
  });

  it('builds an otpauth URI authenticator apps read', () => {
    const uri = otpauthUri(RFC_SECRET, 'owner@shop.ph');
    expect(uri).toBe(
      'otpauth://totp/Tilvara%3Aowner%40shop.ph?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Tilvara&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('recovery codes', () => {
  it('are ten distinct readable codes, hashed regardless of case, spaces and dashes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    const c = codes[0]!;
    expect(hashRecoveryCode(` ${c.toUpperCase().replace(/-/g, ' ')} `)).toBe(hashRecoveryCode(c));
    expect(hashRecoveryCode(c)).not.toBe(hashRecoveryCode(codes[1]!));
  });
});

describe('SecretBox', () => {
  it('seals with a fresh IV and opens only with the same key', () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    const box = new SecretBox(key, 'unused-jwt-secret-unused-jwt-secret');
    const a = box.seal(RFC_SECRET);
    const b = box.seal(RFC_SECRET);
    expect(a).not.toBe(b);
    expect(a).not.toContain(base32Encode(RFC_SECRET));
    expect(box.open(a)).toEqual(RFC_SECRET);
    const other = new SecretBox(Buffer.alloc(32, 8).toString('base64'), 'unused-jwt-secret-unused-jwt-secret');
    expect(() => other.open(a)).toThrow();
  });

  it('detects tampering', () => {
    const box = new SecretBox(undefined, 'dev-only-change-me-dev-only-change-me');
    const [v, iv, tag, ct] = box.seal(RFC_SECRET).split('.');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0]! ^= 1;
    expect(() => box.open([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });

  it('during a rotation opens secrets of the previous key, says which key sealed them, and seals with the new one', () => {
    const jwt = 'unused-jwt-secret-unused-jwt-secret';
    const oldKey = Buffer.alloc(32, 1).toString('base64');
    const newKey = Buffer.alloc(32, 2).toString('base64');
    const before = new SecretBox(oldKey, jwt).seal(RFC_SECRET);
    const rotating = new SecretBox(newKey, jwt, oldKey);
    expect(rotating.openKeyed(before)).toEqual({ plain: RFC_SECRET, current: false });
    const resealed = rotating.seal(RFC_SECRET);
    expect(rotating.openKeyed(resealed)).toEqual({ plain: RFC_SECRET, current: true });
    // After the rotation the old key is gone: only re-sealed secrets open.
    const after = new SecretBox(newKey, jwt);
    expect(after.open(resealed)).toEqual(RFC_SECRET);
    expect(() => after.open(before)).toThrow();
    // A third key opens with neither.
    expect(() => rotating.open(new SecretBox(Buffer.alloc(32, 3).toString('base64'), jwt).seal(RFC_SECRET))).toThrow();
  });
});
