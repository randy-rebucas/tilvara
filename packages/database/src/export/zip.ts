import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';

/*
 * A streaming ZIP writer (PKWARE APPNOTE 6.3): deflated entries with data descriptors, so an entry
 * is written while it is produced and nothing is held in memory. Names are UTF-8 (flag bit 11).
 * No ZIP64: an archive over 4 GiB or 65,535 entries is refused, far beyond a pilot business's
 * records (the dev database's largest business is a few MB). Node built-ins only.
 */
const MAX_32 = 0xffff_ffff;
const FLAGS = 0x0808; // bit 3: sizes in a data descriptor; bit 11: UTF-8 names
const DEFLATE = 8;
const VERSION = 20; // 2.0: deflate, data descriptors

interface CentralEntry {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

export class ZipLimitError extends Error {}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private readonly stamp: { time: number; date: number };

  /** `modified` is stamped on every entry (UTC), so an archive's bytes depend on its content only. */
  constructor(
    private readonly out: Writable,
    modified: Date = new Date(),
  ) {
    this.stamp = dosDateTime(modified);
  }

  private async write(buf: Buffer): Promise<void> {
    this.offset += buf.length;
    if (this.offset > MAX_32) throw new ZipLimitError('archive larger than 4 GiB (ZIP64 is not supported)');
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  /** Add one file. `source` yields its content (strings are UTF-8). Returns its uncompressed size. */
  async add(name: string, source: AsyncIterable<Buffer | string> | Iterable<Buffer | string>): Promise<number> {
    if (this.entries.length >= 0xffff) throw new ZipLimitError('more than 65,535 entries (ZIP64 is not supported)');
    const nameBuf = Buffer.from(name, 'utf8');
    const offset = this.offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(this.stamp.time, 10);
    local.writeUInt16LE(this.stamp.date, 12);
    // crc and sizes (14–25) stay 0: they follow in the data descriptor.
    local.writeUInt16LE(nameBuf.length, 26);
    await this.write(Buffer.concat([local, nameBuf]));

    let crc = 0;
    let size = 0;
    let compressed = 0;
    const deflate = createDeflateRaw({ level: 6 });
    const pump = (async () => {
      for await (const chunk of deflate as AsyncIterable<Buffer>) {
        compressed += chunk.length;
        await this.write(chunk);
      }
    })();
    try {
      for await (const part of source) {
        const buf = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
        if (buf.length === 0) continue;
        crc = crc32(buf, crc);
        size += buf.length;
        if (size > MAX_32) throw new ZipLimitError(`${name}: larger than 4 GiB (ZIP64 is not supported)`);
        if (!deflate.write(buf)) await once(deflate, 'drain');
      }
      deflate.end();
      await pump;
    } catch (e) {
      deflate.destroy();
      await pump.catch(() => undefined);
      throw e;
    }

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
    this.entries.push({ name: nameBuf, crc: crc >>> 0, compressed, size, offset, ...this.stamp });
    return size;
  }

  /** Write the central directory. The caller ends the output stream. */
  async finish(): Promise<void> {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(VERSION, 4); // made by: MS-DOS / FAT attributes, spec 2.0
      h.writeUInt16LE(VERSION, 6);
      h.writeUInt16LE(FLAGS, 8);
      h.writeUInt16LE(DEFLATE, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.compressed, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      // extra, comment, disk, internal and external attributes: 0
      h.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([h, e.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
  }
}
