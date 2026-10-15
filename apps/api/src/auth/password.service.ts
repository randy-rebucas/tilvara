import { Injectable } from '@nestjs/common';
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

/** OWASP 2025 baseline for argon2id: m=19 MiB, t=2, p=1. Stored in PHC string format. */
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
const unb64 = (s: string) => Buffer.from(s, 'base64');

/**
 * Password hashing with Node's built-in argon2id (node:crypto, Node ≥ 24.7) —
 * no native addon to build. Verification is constant-time.
 */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const tag = await this.derive(password, salt, PARAMS);
    return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(tag)}`;
  }

  async verify(password: string, phc: string): Promise<boolean> {
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
    if (!m) return false;
    const expected = unb64(m[5]!);
    const actual = await this.derive(password, unb64(m[4]!), {
      memory: Number(m[1]),
      passes: Number(m[2]),
      parallelism: Number(m[3]),
      tagLength: expected.length,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Burn the same work for unknown accounts so response timing doesn't reveal which emails exist. */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    await this.verify(password, await this.dummyHash);
    return false;
  }

  private async derive(
    password: string,
    salt: Buffer,
    p: { memory: number; passes: number; parallelism: number; tagLength: number },
  ): Promise<Buffer> {
    return argon2Async('argon2id', {
      message: Buffer.from(password, 'utf8'),
      nonce: salt,
      memory: p.memory,
      passes: p.passes,
      parallelism: p.parallelism,
      tagLength: p.tagLength,
    });
  }
}
