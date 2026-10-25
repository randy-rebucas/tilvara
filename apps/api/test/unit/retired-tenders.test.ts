import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/infrastructure/http-error.filter.js';
import { assertTendersCurrent } from '../../src/sales/retired-tenders.js';

describe('assertTendersCurrent (returns of sales paid with a removed tender)', () => {
  it('passes the tenders still offered', () => {
    expect(() => assertTendersCurrent([{ method: 'CASH' }, { method: 'CARD' }, { method: 'QR' }, { method: 'EWALLET' }, { method: 'STORE_CREDIT' }])).not.toThrow();
    expect(() => assertTendersCurrent([])).not.toThrow();
  });

  it.each(['ROOM_CHARGE', 'JOB_DEPOSIT'])('refuses a sale paid with %s: 409 TENDER_RETIRED', (method) => {
    let err: unknown;
    try {
      assertTendersCurrent([{ method: 'CASH' }, { method }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'TENDER_RETIRED', details: { method } });
    expect((err as AppError).getStatus()).toBe(409);
  });
});
