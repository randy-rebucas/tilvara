import type { OfflineSaleError } from '@1pos/pos-offline';
import type { MessageKey } from '../i18n';

/** Why the till refused a sale offline, in the cashier's language (the engine's own message is English, for logs). */
const WORDS: Record<OfflineSaleError['code'], MessageKey> = {
  NO_SNAPSHOT: 'till.why.NO_SNAPSHOT',
  NO_OPEN_SHIFT: 'till.why.NO_OPEN_SHIFT',
  NOT_SHIFT_OWNER: 'till.why.NOT_SHIFT_OWNER',
  UNKNOWN_ITEM: 'till.why.UNKNOWN_ITEM',
  QUANTITY_NOT_ALLOWED: 'till.why.QUANTITY_NOT_ALLOWED',
  INSUFFICIENT_TENDER: 'till.why.INSUFFICIENT_TENDER',
  TAX_REFUSED: 'till.why.TAX_REFUSED',
  TERMINAL_REVOKED: 'till.why.TERMINAL_REVOKED',
  INVALID_SALE: 'till.why.INVALID_SALE',
};

export const offlineRefusalText = (err: Pick<OfflineSaleError, 'code'>, t: (key: MessageKey) => string): string => t(WORDS[err.code] ?? 'till.why.INVALID_SALE');
