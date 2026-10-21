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

describe('salon permissions (ADR-0022)', () => {
  it('shows appointments and staff only to a business that takes appointments, unless the role holds them', async () => {
    const { permissionGroupsFor } = await import('./permissions');
    const keys = (t: Parameters<typeof permissionGroupsFor>[0], held: string[] = []) => permissionGroupsFor(t, held).map((g) => g.key);
    expect(keys('SALON')).toContain('salon');
    expect(keys('HYBRID')).toContain('salon');
    expect(keys('RETAIL')).not.toContain('salon');
    expect(keys('RETAIL', ['appointments.read'])).toContain('salon');
  });
});

describe('lodging permissions (ADR-0023)', () => {
  it('shows rooms, stays and housekeeping only to a business with rooms, unless the role holds them', async () => {
    const { permissionGroupsFor } = await import('./permissions');
    const keys = (t: Parameters<typeof permissionGroupsFor>[0], held: string[] = []) => permissionGroupsFor(t, held).map((g) => g.key);
    expect(keys('LODGING')).toContain('lodging');
    expect(keys('LODGING')).not.toContain('salon');
    expect(keys('HYBRID')).toContain('lodging');
    expect(keys('SALON')).not.toContain('lodging');
    expect(keys('RETAIL', ['lodging.read'])).toContain('lodging');
  });
});

describe('pharmacy permissions (ADR-0025)', () => {
  it('shows the pharmacy area only to a pharmacy, unless the role holds its codes', async () => {
    const { permissionGroupsFor } = await import('./permissions');
    const keys = (t: Parameters<typeof permissionGroupsFor>[0], held: string[] = []) => permissionGroupsFor(t, held).map((g) => g.key);
    expect(keys('PHARMACY')).toContain('pharmacy');
    expect(keys('HYBRID')).toContain('pharmacy');
    expect(keys('GROCERY')).not.toContain('pharmacy');
    expect(keys('RETAIL', ['pharmacy.read'])).toContain('pharmacy');
  });
});
