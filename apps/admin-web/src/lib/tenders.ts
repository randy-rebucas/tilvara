import { en, type MessageKey } from '../i18n/messages';

/**
 * A tender method in words (`tender.<METHOD>`), for screens and CSVs alike. ROOM_CHARGE and JOB_DEPOSIT
 * stay on old sales (retired with lodging and laundry) and read as no longer offered; a code this build
 * has no words for is shown as stored.
 */
export function tenderLabel(t: (key: MessageKey) => string, method: string): string {
  const key = `tender.${method}`;
  return key in en ? t(key as MessageKey) : method;
}
