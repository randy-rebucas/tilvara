import { describe, expect, it } from 'vitest';
import {
  CORE_PERMISSIONS,
  dependentsOf,
  EXTENSIONS,
  extensionOn,
  extensionPermissions,
  missingRequirements,
  PERMISSIONS,
  PRIVILEGED_PERMISSIONS,
  ROLE_TEMPLATES,
  roleTemplatesFor,
  SUPPORT_PERMISSIONS,
  type ExtensionManifest,
} from '../src/index.js';

const fixtures: readonly ExtensionManifest[] = [
  {
    code: 'clinic',
    permissions: ['clinic.read', 'clinic.manage'],
    privileged: ['clinic.manage'],
    support: ['clinic.read'],
    roleTemplates: [{ key: 'clinic_nurse', name: 'Nurse', permissions: ['catalog.read', 'clinic.read'] }],
  },
  { code: 'clinic_lab', requires: ['clinic'], permissions: ['clinic_lab.manage'] },
];

describe('extensions (ADR-0026)', () => {
  it('every manifest is well formed: code format, codes prefixed with the extension, roles within reach, known requirements', () => {
    for (const list of [EXTENSIONS as readonly ExtensionManifest[], fixtures]) {
      const codes = list.map((m) => m.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const m of list) {
        expect(m.code).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
        for (const p of m.permissions) expect([m.code, p.startsWith(`${m.code}.`)]).toEqual([m.code, true]);
        for (const p of [...(m.privileged ?? []), ...(m.support ?? [])]) expect(m.permissions).toContain(p);
        for (const r of m.requires ?? []) expect(codes).toContain(r);
        const reach = new Set<string>([...CORE_PERMISSIONS, ...m.permissions, ...(m.requires ?? []).flatMap((r) => list.find((x) => x.code === r)!.permissions)]);
        for (const role of m.roleTemplates ?? []) {
          for (const p of role.permissions) expect([role.key, p, reach.has(p)]).toEqual([role.key, p, true]);
          expect(ROLE_TEMPLATES.map((t) => t.key)).not.toContain(role.key);
        }
      }
    }
  });

  it('the catalog is the base plus each extension, and no base code looks like an extension code', () => {
    expect(PERMISSIONS).toEqual([...CORE_PERMISSIONS, ...extensionPermissions()]);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const p of CORE_PERMISSIONS) expect(EXTENSIONS.map((m: ExtensionManifest) => m.code)).not.toContain(p.split('.')[0]);
    expect(extensionPermissions(fixtures)).toEqual(['clinic.read', 'clinic.manage', 'clinic_lab.manage']);
  });

  it('roles: the base roles always, plus those of the extensions that are on', () => {
    expect(roleTemplatesFor()).toEqual(ROLE_TEMPLATES);
    expect(roleTemplatesFor(['clinic'], fixtures).map((r) => r.key)).toEqual([...ROLE_TEMPLATES.map((r) => r.key), 'clinic_nurse']);
    expect(roleTemplatesFor(['clinic_lab'], fixtures)).toEqual(ROLE_TEMPLATES);
    expect(roleTemplatesFor(['unknown'], fixtures)).toEqual(ROLE_TEMPLATES);
  });

  it('requirements and dependents', () => {
    expect(missingRequirements(fixtures[1]!, [])).toEqual(['clinic']);
    expect(missingRequirements(fixtures[1]!, ['clinic'])).toEqual([]);
    expect(dependentsOf('clinic', ['clinic', 'clinic_lab'], fixtures)).toEqual(['clinic_lab']);
    expect(dependentsOf('clinic', ['clinic'], fixtures)).toEqual([]);
  });

  it('extensionOn reads the usable list', () => {
    expect(extensionOn(['clinic'], 'clinic')).toBe(true);
    expect(extensionOn([], 'clinic')).toBe(false);
    expect(extensionOn(undefined, 'clinic')).toBe(false);
  });

  it('support sessions and privileged codes include the extensions’ declared codes only', () => {
    for (const m of EXTENSIONS as readonly ExtensionManifest[]) {
      for (const p of m.privileged ?? []) expect(PRIVILEGED_PERMISSIONS).toContain(p);
      for (const p of m.support ?? []) expect(SUPPORT_PERMISSIONS).toContain(p);
    }
  });
});
