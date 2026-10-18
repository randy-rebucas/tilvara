import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { csvField, csvRow } from '../../src/export/data-export.js';
import { DevFileStorage } from '../../src/export/storage.js';
import { ZipWriter } from '../../src/export/zip.js';

/** A minimal reader written from the spec, used to check the writer entry by entry. */
function readZip(buf: Buffer): { name: string; data: Buffer; flags: number }[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  expect(cdOffset + cdSize).toBe(eocd);
  const out: { name: string; data: Buffer; flags: number }[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const localName = buf.readUInt16LE(local + 26);
    const start = local + 30 + localName + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(start, start + csize));
    expect([name, data.length, crc32(data) >>> 0]).toEqual([name, size, crc]);
    // The data descriptor repeats crc and sizes.
    expect(buf.readUInt32LE(start + csize)).toBe(0x08074b50);
    expect([buf.readUInt32LE(start + csize + 4), buf.readUInt32LE(start + csize + 8), buf.readUInt32LE(start + csize + 12)]).toEqual([crc, csize, size]);
    out.push({ name, data, flags });
    p += 46 + nameLen;
  }
  return out;
}

async function zipToBuffer(build: (z: ZipWriter) => Promise<void>): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const z = new ZipWriter(out, new Date('2026-10-18T04:05:06Z'));
  await build(z);
  out.end();
  return Buffer.concat(chunks);
}

/** An independent ZIP reader: bsdtar (Windows ships it as System32\tar.exe; GNU tar cannot read ZIP). */
const BSDTAR = [process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar'].find(
  (t) => /bsdtar/.test(spawnSync(t, ['--version'], { encoding: 'utf8' }).stdout ?? ''),
);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('ZIP writer', () => {
  it('writes deflated UTF-8 entries that read back byte for byte', async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `${i},Ñame ₱${i}.5000\r\n`);
    const buf = await zipToBuffer(async (z) => {
      await z.add('README.txt', ['hello\r\n']);
      await z.add('tables/sales.csv', (async function* () {
        for (const line of big) yield line;
      })());
      await z.add('empty.csv', []);
      await z.add('niño.txt', [Buffer.from([0, 1, 2, 255])]);
      await z.finish();
    });
    const entries = readZip(buf);
    expect(entries.map((e) => e.name)).toEqual(['README.txt', 'tables/sales.csv', 'empty.csv', 'niño.txt']);
    expect(entries[0]!.data.toString()).toBe('hello\r\n');
    expect(entries[1]!.data.toString('utf8')).toBe(big.join(''));
    expect(entries[2]!.data.length).toBe(0);
    expect([...entries[3]!.data]).toEqual([0, 1, 2, 255]);
    expect(entries.every((e) => e.flags === 0x0808)).toBe(true);
    // Deflate works: 20,000 similar lines compress well.
    expect(buf.length).toBeLessThan(big.join('').length / 3);
  });

  it('the same content and time give the same bytes', async () => {
    const make = () => zipToBuffer(async (z) => {
      await z.add('a.csv', ['x,y\r\n1,2\r\n']);
      await z.finish();
    });
    expect((await make()).equals(await make())).toBe(true);
  });

  it.runIf(BSDTAR !== undefined)('another implementation (bsdtar) lists and extracts it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'onepos-zip-'));
    dirs.push(dir);
    const file = join(dir, 'export.zip');
    await writeFile(file, await zipToBuffer(async (z) => {
      await z.add('README.txt', ['read me\r\n']);
      await z.add('tables/products.csv', ['\ufeffid,name\r\n1,"Iced coffee, 16oz"\r\n']);
      await z.finish();
    }));
    // Relative names: bsdtar would read "C:" as a remote host.
    expect(execFileSync(BSDTAR!, ['-tf', 'export.zip'], { cwd: dir, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)).toEqual(['README.txt', 'tables/products.csv']);
    execFileSync(BSDTAR!, ['-xf', 'export.zip'], { cwd: dir });
    expect(await readFile(join(dir, 'tables', 'products.csv'), 'utf8')).toBe('\ufeffid,name\r\n1,"Iced coffee, 16oz"\r\n');
  });
});

describe('CSV fields (RFC 4180)', () => {
  it('keeps values exact and tells NULL from an empty text', () => {
    expect(csvField(null)).toBe('');
    expect(csvField('')).toBe('""');
    expect(csvField('120.5000')).toBe('120.5000');
    expect(csvField('-5.0000')).toBe('-5.0000');
    expect(csvField('=SUM(A1)')).toBe('=SUM(A1)');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('{"a": 1}')).toBe('"{""a"": 1}"');
    expect(csvRow(['1', null, ''])).toBe('1,,""\r\n');
  });
});

describe('DevFileStorage', () => {
  it('a file appears only when complete, with its size and SHA-256; a failed write leaves nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'onepos-files-'));
    dirs.push(root);
    const s = new DevFileStorage(root);
    const put = await s.put('exports/t1/e1.zip', async (out) => {
      out.write('abc');
      out.write(Buffer.from('def'));
    });
    expect(put).toEqual({ sizeBytes: 6, sha256: createHash('sha256').update('abcdef').digest('hex') });
    const opened = await s.open('exports/t1/e1.zip');
    expect(opened?.sizeBytes).toBe(6);
    const chunks: Buffer[] = [];
    for await (const c of opened!.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('abcdef');

    await expect(s.put('exports/t1/e2.zip', async (out) => {
      out.write('partial');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await s.open('exports/t1/e2.zip')).toBeNull();
    expect((await readdir(join(root, 'exports', 't1'))).sort()).toEqual(['e1.zip']);

    await s.remove('exports/t1/e1.zip');
    expect(await s.open('exports/t1/e1.zip')).toBeNull();
  });

  it('refuses keys that leave its folder', async () => {
    const s = new DevFileStorage(await mkdtemp(join(tmpdir(), 'onepos-files-')));
    dirs.push(s.root);
    for (const key of ['../x', 'a/../../x', '/etc/passwd', 'a//b', 'C:\\x', '']) {
      await expect(s.open(key)).rejects.toThrow('invalid storage key');
    }
  });
});
