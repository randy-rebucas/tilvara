import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MANIFEST_FORMAT, pruneBackups } from '../../src/backup/backup.js';
import { canonicalJson, postureDiff } from '../../src/backup/catalog.js';
import { connectionParts, withDatabase } from '../../src/backup/pg-tools.js';

describe('pg tool connection', () => {
  it('passes host, port, user and database as options and keeps the password for PGPASSWORD', () => {
    expect(connectionParts('postgres://onepos_backup:p%40ss@127.0.0.1:55460/onepos')).toEqual({
      host: '127.0.0.1',
      port: '55460',
      user: 'onepos_backup',
      password: 'p@ss',
      database: 'onepos',
    });
  });
  it('inside a container, reaches the server at the in-container address', () => {
    expect(connectionParts('postgres://u:p@127.0.0.1:55460/onepos', { docker: 'onepos-postgres-1' })).toMatchObject({ host: '127.0.0.1', port: '5432' });
    expect(connectionParts('postgres://u:p@127.0.0.1:55460/onepos', { docker: 'c', dockerHost: 'db:6543' })).toMatchObject({ host: 'db', port: '6543' });
  });
  it('refuses a URL without a database and swaps databases', () => {
    expect(() => connectionParts('postgres://u:p@127.0.0.1:5432/')).toThrow(/no database/);
    expect(withDatabase('postgres://u:p@h:1/onepos?sslmode=require', 'onepos_drill_x')).toBe('postgres://u:p@h:1/onepos_drill_x?sslmode=require');
  });
});

describe('posture comparison', () => {
  it('hashes the same whatever the key order', () => {
    expect(canonicalJson({ b: [1, { y: 2, x: 1 }], a: null })).toBe(canonicalJson({ a: null, b: [1, { x: 1, y: 2 }] }));
  });
  it('names what is missing, added or different', () => {
    const before = { relations: [{ name: 'public.sales', forced: true }, { name: 'public.plans', forced: true }] };
    const after = { relations: [{ name: 'public.sales', forced: false }, { name: 'public.extra', forced: true }] };
    expect(postureDiff(before, after)).toEqual([
      'relations public.sales: differs ({"forced":true,"name":"public.sales"} → {"forced":false,"name":"public.sales"})',
      'relations public.plans: missing after restore',
      'relations public.extra: not in the backup',
    ]);
  });
});

describe('pruneBackups', () => {
  let dir = '';
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const backup = async (day: number) => {
    const stamp = `202610${String(day).padStart(2, '0')}T020000Z`;
    const file = `onepos-onepos-${stamp}.dump.age`;
    await writeFile(join(dir, file), 'x');
    await writeFile(
      join(dir, `onepos-onepos-${stamp}.manifest.json`),
      JSON.stringify({ format: MANIFEST_FORMAT, file, finishedAt: `2026-10-${String(day).padStart(2, '0')}T02:00:05Z` }),
    );
  };

  it('deletes pairs older than the window but always keeps the newest ones and foreign files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'onepos-prune-'));
    for (const day of [1, 2, 3, 10, 11]) await backup(day);
    await writeFile(join(dir, 'notes.txt'), 'keep me');
    const removed = await pruneBackups(dir, 7, 3, new Date('2026-10-12T00:00:00Z'));
    expect(removed).toEqual(['onepos-onepos-20261001T020000Z.dump.age', 'onepos-onepos-20261002T020000Z.dump.age']);
    expect((await readdir(dir)).sort()).toEqual([
      'notes.txt',
      'onepos-onepos-20261003T020000Z.dump.age',
      'onepos-onepos-20261003T020000Z.manifest.json',
      'onepos-onepos-20261010T020000Z.dump.age',
      'onepos-onepos-20261010T020000Z.manifest.json',
      'onepos-onepos-20261011T020000Z.dump.age',
      'onepos-onepos-20261011T020000Z.manifest.json',
    ]);
    // Everything is old, but the newest three stay.
    expect(await pruneBackups(dir, 1, 3, new Date('2027-01-01T00:00:00Z'))).toEqual([]);
  });
});
