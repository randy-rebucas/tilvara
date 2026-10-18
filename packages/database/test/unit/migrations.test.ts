import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../../src/migrate.js';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
const sqlFiles = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql'));

/**
 * drizzle applies a migration only when its `when` is newer than the newest one already applied,
 * and runs every pending migration in one transaction. Out-of-order or orphan files are therefore
 * skipped without an error (docs/operations/database-migrations.md).
 */
describe('migration journal', () => {
  it('numbers entries 0, 1, 2… with matching file prefixes', () => {
    journal.entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      expect(e.tag.slice(0, 4)).toBe(String(i).padStart(4, '0'));
    });
  });

  it('has strictly increasing timestamps, so no migration is skipped', () => {
    const late = journal.entries.filter((e, i) => i > 0 && e.when <= journal.entries[i - 1]!.when).map((e) => e.tag);
    expect(late).toEqual([]);
  });

  it('has exactly one SQL file per entry', () => {
    expect(sqlFiles.sort()).toEqual(journal.entries.map((e) => `${e.tag}.sql`).sort());
  });

  it('uses no statement that cannot run inside the migration transaction', () => {
    const offending = sqlFiles.filter((f) => /\bCONCURRENTLY\b|^\s*VACUUM\b/im.test(readFileSync(join(MIGRATIONS_FOLDER, f), 'utf8')));
    expect(offending).toEqual([]);
  });
});
