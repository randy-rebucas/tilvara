import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPrivilegedSet, loginSchema, PERMISSIONS, ROLE_TEMPLATES, signupSchema } from '../src/index.js';

describe('signupSchema', () => {
  const valid = {
    email: '  Owner@Example.PH ',
    password: 'correct horse battery',
    displayName: 'Juan',
    businessName: 'Sari-Sari Plus',
    tenantSlug: 'Sari-Sari-Plus',
  };

  it('normalises email and slug', () => {
    const r = signupSchema.parse(valid);
    expect(r.email).toBe('owner@example.ph');
    expect(r.tenantSlug).toBe('sari-sari-plus');
  });

  it('rejects short passwords, bad slugs and bad emails', () => {
    expect(signupSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
    expect(signupSchema.safeParse({ ...valid, tenantSlug: 'bad slug!' }).success).toBe(false);
    expect(signupSchema.safeParse({ ...valid, email: 'nope' }).success).toBe(false);
  });

  it('strips unknown fields such as a client-supplied tenantId', () => {
    const r = loginSchema.parse({ email: 'a@b.ph', password: 'x', isAdmin: true } as unknown);
    expect(r).not.toHaveProperty('isAdmin');
  });
});

describe('role templates', () => {
  it('only reference catalogued permissions and have unique keys', () => {
    const keys = new Set<string>();
    for (const t of ROLE_TEMPLATES) {
      expect(keys.has(t.key)).toBe(false);
      keys.add(t.key);
      for (const p of t.permissions) expect(PERMISSIONS).toContain(p);
    }
  });

  it('restaurant manager = branch manager + restaurant set-up; kitchen crew works the KDS only; neither needs MFA', () => {
    const of = (k: string) => ROLE_TEMPLATES.find((t) => t.key === k)!.permissions;
    expect([...of('restaurant_manager')].sort()).toEqual([...of('branch_manager'), 'restaurant.manage'].sort());
    expect(of('kitchen_crew')).toEqual(['kitchen.operate']);
    expect(isPrivilegedSet(of('restaurant_manager'))).toBe(false);
    expect(isPrivilegedSet(of('kitchen_crew'))).toBe(false);
  });

  it('migration 0049 back-fills exactly these two templates into existing businesses', () => {
    const sql = readFileSync(fileURLToPath(new URL('../../database/drizzle/0049_restaurant_role_templates.sql', import.meta.url)), 'utf8');
    for (const key of ['restaurant_manager', 'kitchen_crew']) {
      const t = ROLE_TEMPLATES.find((x) => x.key === key)!;
      const m = new RegExp(`\\('${key}', '${t.name}', ARRAY\\[([^\\]]*)\\]`).exec(sql);
      expect(m, key).not.toBeNull();
      expect(m![1]!.split(',').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual([...t.permissions].sort());
    }
  });

  it('owner holds every permission; admin cannot manage the subscription', () => {
    expect(ROLE_TEMPLATES.find((t) => t.key === 'owner')!.permissions).toHaveLength(PERMISSIONS.length);
    expect(ROLE_TEMPLATES.find((t) => t.key === 'admin')!.permissions).not.toContain('subscription.manage');
  });
});
