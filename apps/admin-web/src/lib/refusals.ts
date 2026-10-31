import type { MessageKey } from '../i18n/messages';

/**
 * Words for the API refusals people meet in the back office, in the reader's language. The API's
 * message is English; a refusal not listed here keeps it. A code whose meaning depends on the record
 * (HAS_ACTIVE_CHILDREN, SHIFT_OPEN) is matched on the API's exact message.
 */
const BY_MESSAGE: Record<string, MessageKey> = {
  'Archive its branches first': 'refusal.archiveBranchesFirst',
  // HAS_STOCK: what keeps the item from being untracked (audit 47 #7).
  'Receive its transfers in transit first': 'refusal.hasStockInTransit',
  'Post or cancel the open count sheets listing it first': 'refusal.hasStockOnSheet',
  'Archive its registers first': 'refusal.archiveRegistersFirst',
  'Revoke its terminals first': 'refusal.revokeTerminalsFirst',
  'Move or archive its products first': 'refusal.moveProductsFirst',
  'Move or archive its sub-categories first': 'refusal.moveSubcategoriesFirst',
  'Move or archive its sub-categories and products first': 'refusal.moveSubcategoriesAndProductsFirst',
  'Close the open shift on this register first': 'refusal.closeShiftFirst',
};

const BY_CODE: Record<string, MessageKey> = {
  LAST_OWNER: 'refusal.lastOwner',
  PRIVILEGE_ESCALATION: 'refusal.escalation',
  SCOPE_NOT_HELD: 'refusal.scopeNotHeld',
  ENTITLEMENT_REQUIRED: 'refusal.notOnPlan',
  ENTITLEMENT_LIMIT_REACHED: 'refusal.planLimit',
  SUBSCRIPTION_READ_ONLY: 'refusal.readOnly',
  TENANT_SUSPENDED: 'refusal.suspended',
  PLAN_LIMITS_EXCEEDED: 'refusal.planLimits',
  PLAN_NOT_PRICED: 'refusal.planNotPriced',
  BILL_NOT_OPEN: 'refusal.billNotOpen',
  NOT_ACTIVE: 'refusal.notActive',
  BILLING_PROVIDER_UNAVAILABLE: 'refusal.billingUnavailable',
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
  SYSTEM_ACCOUNT_NOT_ALLOWED: 'refusal.systemAccount',
  HAS_STOCK: 'refusal.hasStock',
  BRANCH_HAS_STOCK: 'refusal.branchHasStock',
  BRANCH_HAS_OPEN_DOCUMENTS: 'refusal.branchHasOpenDocuments',
  BRANCH_ARCHIVED: 'refusal.branchArchived',
  GOODS_RECEIPT_REQUIRED: 'refusal.goodsReceiptRequired',
  PACKS_NOT_ON_HAND: 'refusal.packsNotOnHand',
  DATE_IN_FUTURE: 'refusal.dateInFuture',
  REVERSAL_BEFORE_ORIGINAL: 'refusal.reversalBeforeOriginal',
  NOT_STOCKED: 'refusal.notStocked',
};

/** The copy key for a refusal, or null to show the API's own message. */
export function refusalKey(code: string, message: string): MessageKey | null {
  return BY_MESSAGE[message] ?? BY_CODE[code] ?? null;
}
