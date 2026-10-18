import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createWriteStream } from 'node:fs';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Private file storage for data exports (ADR-0016 slice 6). The production adapter (object storage
 * with signed links) waits for the hosting decision (D1); until then `DevFileStorage` keeps files
 * in a local folder, and the API serves them only through its own short-lived signed links.
 */
export interface FileStorage {
  /** Write a file through `produce`; it appears only when complete. Returns its size and SHA-256. */
  put(key: string, produce: (out: Writable) => Promise<void>): Promise<{ sizeBytes: number; sha256: string }>;
  /** The file's bytes, or null when it does not exist. */
  open(key: string): Promise<{ stream: Readable; sizeBytes: number } | null>;
  remove(key: string): Promise<void>;
}

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,255}$/i;

export class DevFileStorage implements FileStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!KEY.test(key) || key.split('/').some((p) => p === '' || p === '.' || p === '..')) throw new Error('invalid storage key');
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return full;
  }

  async put(key: string, produce: (out: Writable) => Promise<void>): Promise<{ sizeBytes: number; sha256: string }> {
    const full = this.path(key);
    const partial = `${full}.partial`;
    await mkdir(dirname(full), { recursive: true });
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        done(null, chunk);
      },
    });
    const file = createWriteStream(partial, { flags: 'w', mode: 0o600 });
    const written = pipeline(meter, file);
    try {
      await produce(meter);
      meter.end();
      await written;
      await rename(partial, full);
    } catch (e) {
      meter.destroy();
      await written.catch(() => undefined);
      await rm(partial, { force: true });
      throw e;
    }
    return { sizeBytes, sha256: hash.digest('hex') };
  }

  async open(key: string): Promise<{ stream: Readable; sizeBytes: number } | null> {
    const full = this.path(key);
    const s = await stat(full).catch(() => null);
    if (!s?.isFile()) return null;
    return { stream: createReadStream(full), sizeBytes: s.size };
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
