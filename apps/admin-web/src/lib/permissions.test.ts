import { describe, expect, it } from 'vitest';
import { en, fil } from '../i18n/messages';
import { EXTENSIONS, type ExtensionManifest } from '@1pos/validation/extensions';
import { PERMISSION_GROUPS, PERMISSIONS, permissionGroupsFor } from './permissions';

describe('role editor permissions', () => {
  it('lists every permission exactly once, in some area', () => {
    const listed = PERMISSION_GROUPS.flatMap((g) => g.codes);
    expect([...listed].sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('extensions (ADR-0026): an extension’s area shows while the business has it or the role holds one of its codes', () => {
    const known: readonly string[] = EXTENSIONS.map((m: ExtensionManifest) => m.code);
    for (const g of PERMISSION_GROUPS) if (g.extension) expect(known).toContain(g.extension);
    expect(permissionGroupsFor(known)).toEqual(PERMISSION_GROUPS);
    expect(permissionGroupsFor([])).toEqual(PERMISSION_GROUPS.filter((g) => !g.extension));
    for (const g of PERMISSION_GROUPS.filter((x) => x.extension)) expect(permissionGroupsFor([], [g.codes[0]!])).toContainEqual(g);
  });

  it('words every permission and area in English and Filipino', () => {
    for (const dict of [en, fil] as Record<string, string>[]) {
      for (const code of PERMISSIONS) expect(dict[`perm.${code}`], code).toBeTruthy();
      for (const g of PERMISSION_GROUPS) expect(dict[`permGroup.${g.key}`], g.key).toBeTruthy();
    }
  });
});
