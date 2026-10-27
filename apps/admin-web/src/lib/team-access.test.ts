import { describe, expect, it } from 'vitest';
import { ROLE_TEMPLATES } from '@1pos/validation/permissions';
import { refusalKey } from './refusals';
import { canGrantRole, canManageMember } from './team-access';

const role = (key: string) => {
  const t = ROLE_TEMPLATES.find((r) => r.key === key)!;
  return { id: key, permissions: t.permissions };
};
const owner = role('owner');
const admin = role('admin');
const cashier = role('cashier');

describe('what the viewer may grant', () => {
  it('an Administrator cannot grant or change an Owner, but can a Cashier', () => {
    expect(canGrantRole(owner, admin.permissions)).toBe(false);
    expect(canGrantRole(cashier, admin.permissions)).toBe(true);
    expect(canManageMember({ roles: [{ roleId: 'owner' }] }, [owner, admin, cashier], admin.permissions)).toBe(false);
    expect(canManageMember({ roles: [{ roleId: 'cashier' }, { roleId: 'admin' }] }, [owner, admin, cashier], admin.permissions)).toBe(true);
  });

  it('an Owner may manage everyone; an unknown role is never manageable', () => {
    expect(canManageMember({ roles: [{ roleId: 'owner' }] }, [owner], owner.permissions)).toBe(true);
    expect(canManageMember({ roles: [{ roleId: 'gone' }] }, [owner], owner.permissions)).toBe(false);
  });
});

describe('refusals in words', () => {
  it('maps by exact message first, then by code, else keeps the API message', () => {
    expect(refusalKey('HAS_ACTIVE_CHILDREN', 'Archive its registers first')).toBe('refusal.archiveRegistersFirst');
    expect(refusalKey('HAS_ACTIVE_CHILDREN', 'Move or archive its sub-categories and products first')).toBeNull();
    expect(refusalKey('PRIVILEGE_ESCALATION', 'You cannot grant or change access beyond your own')).toBe('refusal.escalation');
    expect(refusalKey('SHIFT_OPEN', 'Close the open shift on this register before its Z-reading')).toBeNull();
  });
});
