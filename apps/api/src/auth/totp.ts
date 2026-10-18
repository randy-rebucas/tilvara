import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 TOTP with the parameters every authenticator app supports: SHA-1, 6 digits, 30 s. */
export const TOTP_PERIOD_SECONDS = 30;
const DIGITS = 6;
/** Accept the previous and next step too (clock drift between phone and server). */
const WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 random bytes (160 bits, the RFC 4226 recommendation). */
export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return bin.toString().padStart(DIGITS, '0');
}

export const stepAt = (unixSeconds: number): number => Math.floor(unixSeconds / TOTP_PERIOD_SECONDS);

/**
 * The time step a code belongs to, or null. Checks the current step ± WINDOW in constant time per
 * candidate; the caller must still spend the step once (replay protection lives in the database).
 */
export function matchTotp(secret: Buffer, code: string, unixSeconds = Date.now() / 1000): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(unixSeconds);
  let found: number | null = null;
  for (let s = now - WINDOW; s <= now + WINDOW; s++) {
    if (timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(code)) && found === null) found = s;
  }
  return found;
}

/** otpauth:// URI for authenticator apps (Key URI Format). */
export function otpauthUri(secret: Buffer, account: string, issuer = 'Tilvara'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Recovery codes ---------------------------------------------------------------------------
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten codes like `k7m2-x9qp-4hzt` (≈ 71 bits each); only their SHA-256 is stored. */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(12);
    const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

export const normalizeRecoveryCode = (code: string): string => code.trim().toLowerCase().replace(/[\s-]/g, '');

export const hashRecoveryCode = (code: string): string =>
  createHash('sha256').update(`1pos-recovery:${normalizeRecoveryCode(code)}`).digest('hex');

// Secret encryption at rest -------------------------------------------------------------------
/**
 * AES-256-GCM. Format `v1.<iv>.<tag>.<ciphertext>` (base64url). The key is MFA_ENCRYPTION_KEY, or one
 * derived from the JWT secret outside production (config refuses the derived key in production).
 * Rotation: deploy the new key with the old one as MFA_ENCRYPTION_KEY_PREVIOUS (secrets sealed with
 * it still open; GCM's tag tells the keys apart), re-seal with `mfa-rekey`, then drop the old key.
 */
export class SecretBox {
  private readonly key: Buffer;
  private readonly previous: Buffer | null;

  constructor(mfaKeyBase64: string | undefined, jwtSecret: string, previousKeyBase64?: string) {
    this.key = mfaKeyBase64
      ? Buffer.from(mfaKeyBase64, 'base64')
      : Buffer.from(hkdfSync('sha256', jwtSecret, '1pos-mfa', 'totp-secret-dev-key', 32));
    this.previous = previousKeyBase64 ? Buffer.from(previousKeyBase64, 'base64') : null;
    if (this.key.length !== 32 || (this.previous && this.previous.length !== 32)) throw new Error('MFA key must be 32 bytes');
  }

  seal(plain: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  open(sealed: string): Buffer {
    return this.openKeyed(sealed).plain;
  }

  /** The secret, and whether the current key sealed it (false: the previous key). Throws when neither did. */
  openKeyed(sealed: string): { plain: Buffer; current: boolean } {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unknown secret format');
    const decrypt = (key: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
    };
    try {
      return { plain: decrypt(this.key), current: true };
    } catch (e) {
      if (!this.previous) throw e;
      return { plain: decrypt(this.previous), current: false };
    }
  }
}
