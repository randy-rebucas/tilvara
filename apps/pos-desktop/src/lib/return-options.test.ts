import { describe, expect, it } from 'vitest';
import { messages } from '../i18n';
import { offlineRefusalText } from './offline-words';
import { returnOptions } from './return-options';

const line = (quantity: string, returnedQuantity: string) => ({ id: quantity + returnedQuantity, name: 'Cola', sku: 'C', quantity, returnedQuantity, amountDue: '1.00' });
const SHIFT = 's-1';

describe('what This shift offers for a sale (the server would refuse the rest)', () => {
  it('offers everything for an untouched sale of this shift', () => {
    expect(returnOptions({ cashierSessionId: SHIFT, lines: [line('2', '0')] }, [{ method: 'CASH' }], SHIFT)).toEqual({ voidable: true, returnable: true, exchangeable: true, why: [] });
  });
  it('a sale of another shift: return and exchange, no void (VOID_OUTSIDE_SESSION)', () => {
    expect(returnOptions({ cashierSessionId: 's-0', lines: [line('2', '0')] }, [{ method: 'CASH' }], SHIFT)).toMatchObject({ voidable: false, returnable: true, why: ['history.voidOtherShift'] });
  });
  it('part returned: no void (ALREADY_RETURNED); fully returned or voided: nothing (RETURN_EXCEEDS_SOLD)', () => {
    expect(returnOptions({ cashierSessionId: SHIFT, lines: [line('2', '0.5')] }, [], SHIFT)).toMatchObject({ voidable: false, returnable: true, why: ['history.voidAfterReturn'] });
    expect(returnOptions({ cashierSessionId: SHIFT, lines: [line('2', '2'), line('1', '1')] }, [], SHIFT)).toEqual({ voidable: false, returnable: false, exchangeable: false, why: ['history.nothingLeft'] });
  });
  it('paid with store credit: no exchange (EXCHANGE_STORE_CREDIT)', () => {
    expect(returnOptions({ cashierSessionId: SHIFT, lines: [line('1', '0')] }, [{ method: 'STORE_CREDIT' }, { method: 'CASH' }], SHIFT)).toMatchObject({ voidable: true, returnable: true, exchangeable: false, why: ['history.exchangeCredit'] });
  });
});

describe('offline refusals in words', () => {
  it('words every engine code in English and Filipino, never the engine’s English message', () => {
    const codes = ['NO_SNAPSHOT', 'NO_OPEN_SHIFT', 'NOT_SHIFT_OWNER', 'UNKNOWN_ITEM', 'QUANTITY_NOT_ALLOWED', 'INSUFFICIENT_TENDER', 'TAX_REFUSED', 'TERMINAL_REVOKED', 'INVALID_SALE'] as const;
    for (const lang of ['en', 'fil'] as const) {
      for (const code of codes) {
        const text = offlineRefusalText({ code }, (k) => messages[lang][k]);
        expect(text, `${lang} ${code}`).toBeTruthy();
      }
    }
    expect(offlineRefusalText({ code: 'INSUFFICIENT_TENDER' }, (k) => messages.fil[k])).toBe('kulang ang natanggap na cash para sa kabuuan.');
  });
});
