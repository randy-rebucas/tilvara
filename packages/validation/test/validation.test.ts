import { describe, expect, it } from 'vitest';
import { loginSchema, PERMISSIONS, ROLE_TEMPLATES, signupSchema } from '../src/index.js';

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

  it('owner holds every permission; admin cannot manage the subscription', () => {
    expect(ROLE_TEMPLATES.find((t) => t.key === 'owner')!.permissions).toHaveLength(PERMISSIONS.length);
    expect(ROLE_TEMPLATES.find((t) => t.key === 'admin')!.permissions).not.toContain('subscription.manage');
  });
});
