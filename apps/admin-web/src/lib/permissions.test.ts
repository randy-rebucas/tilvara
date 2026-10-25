import { describe, expect, it } from 'vitest';
import { en, fil } from '../i18n/messages';
import { PERMISSION_GROUPS, PERMISSIONS } from './permissions';

describe('role editor permissions', () => {
  it('lists every permission exactly once, in some area', () => {
    const listed = PERMISSION_GROUPS.flatMap((g) => g.codes);
    expect([...listed].sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('words every permission and area in English and Filipino', () => {
    for (const dict of [en, fil] as Record<string, string>[]) {
      for (const code of PERMISSIONS) expect(dict[`perm.${code}`], code).toBeTruthy();
      for (const g of PERMISSION_GROUPS) expect(dict[`permGroup.${g.key}`], g.key).toBeTruthy();
    }
  });
});
