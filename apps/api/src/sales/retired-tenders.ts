import { HttpStatus } from '@nestjs/common';
import { TENDER_METHODS } from '@1pos/database';
import { AppError } from '../infrastructure/http-error.filter.js';

/**
 * Tenders of features that were removed stay on the sales that took them (append-only evidence:
 * JOB_DEPOSIT since 0110, ROOM_CHARGE since 0111), but nothing can give them back any more: the down
 * payment and the guest folio are gone. A return, void or exchange of such a sale is refused rather
 * than refunded some other way.
 */
export function assertTendersCurrent(tenders: { method: string }[]): void {
  const retired = tenders.find((t) => !(TENDER_METHODS as readonly string[]).includes(t.method));
  if (retired) {
    throw new AppError(
      'TENDER_RETIRED',
      'This sale was paid in a way that is no longer offered, so it cannot be returned or voided here. Settle it with the customer and record the adjustment in the books.',
      HttpStatus.CONFLICT,
      { method: retired.method },
    );
  }
}
