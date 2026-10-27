import { toDec } from '@1pos/money';
import type { MessageKey } from '../i18n';
import type { SaleDetail } from '../types';

/** What is left to give back on a line (sold − returned), never via JS numbers. */
export const leftOn = (l: SaleDetail['lines'][number]) => toDec(l.quantity).minus(l.returnedQuantity);

/**
 * Which of void / return / exchange the server would accept for this sale, and why not (the same rules
 * as `ReturnsService`): a void only in the sale's own shift and before anything came back; a return
 * while something is left; an exchange also never for a sale paid with store credit.
 */
export function returnOptions(detail: Pick<SaleDetail, 'cashierSessionId' | 'lines'>, tenders: { method: string }[], sessionId: string) {
  const left = detail.lines.some((l) => leftOn(l).gt(0));
  const untouched = detail.lines.every((l) => toDec(l.returnedQuantity).isZero());
  const why: MessageKey[] = [];
  const voidable = left && untouched && detail.cashierSessionId === sessionId;
  if (!left) why.push('history.nothingLeft');
  else if (!untouched) why.push('history.voidAfterReturn');
  else if (detail.cashierSessionId !== sessionId) why.push('history.voidOtherShift');
  const paidWithCredit = tenders.some((tn) => tn.method === 'STORE_CREDIT');
  if (left && paidWithCredit) why.push('history.exchangeCredit');
  return { voidable, returnable: left, exchangeable: left && !paidWithCredit, why };
}

