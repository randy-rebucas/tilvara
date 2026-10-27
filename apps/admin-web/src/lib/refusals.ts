import type { MessageKey } from '../i18n/messages';

/**
 * Words for the API refusals people meet in the back office, in the reader's language. The API's
 * message is English; a refusal not listed here keeps it. A code whose meaning depends on the record
 * (HAS_ACTIVE_CHILDREN, SHIFT_OPEN) is matched on the API's exact message.
 */
const BY_MESSAGE: Record<string, MessageKey> = {
  'Archive its branches first': 'refusal.archiveBranchesFirst',
  'Archive its registers first': 'refusal.archiveRegistersFirst',
  'Revoke its terminals first': 'refusal.revokeTerminalsFirst',
  'Close the open shift on this register first': 'refusal.closeShiftFirst',
};

const BY_CODE: Record<string, MessageKey> = {
  LAST_OWNER: 'refusal.lastOwner',
  PRIVILEGE_ESCALATION: 'refusal.escalation',
  SCOPE_NOT_HELD: 'refusal.scopeNotHeld',
  ENTITLEMENT_REQUIRED: 'refusal.notOnPlan',
  ENTITLEMENT_LIMIT_REACHED: 'refusal.planLimit',
  TAX_PROFILE_BACKDATED: 'refusal.taxBackdated',
  SYSTEM_ROLE_READONLY: 'refusal.systemRole',
  ROLE_IN_USE: 'refusal.roleInUse',
  ALREADY_MEMBER: 'refusal.alreadyMember',
  MFA_RESET_SELF: 'refusal.mfaResetSelf',
  MFA_NOT_ENABLED: 'refusal.mfaNotEnabled',
  MFA_RESET_OTHER_BUSINESS: 'refusal.mfaResetOtherBusiness',
  EXTENSION_REQUIRES: 'refusal.extensionRequires',
  EXTENSION_REQUIRED_BY: 'refusal.extensionRequiredBy',
  EXTENSION_IN_USE: 'refusal.extensionInUse',
};

/** The copy key for a refusal, or null to show the API's own message. */
export function refusalKey(code: string, message: string): MessageKey | null {
  return BY_MESSAGE[message] ?? BY_CODE[code] ?? null;
}
