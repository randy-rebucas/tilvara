import { describe, expect, it } from 'vitest';
import { ApiFailure, withReference } from './api';

const failure = (status: number, correlationId?: string) =>
  new ApiFailure({ status, code: status >= 500 ? 'INTERNAL' : 'OUT_OF_STOCK', message: 'm', ...(correlationId ? { correlationId } : {}) });

describe('withReference', () => {
  it('adds the start of the correlation id when the server failed to finish', () => {
    expect(withReference('Not recorded.', failure(503, '0af76519-16cd-43dd-8448-eb211c80319c'))).toBe('Not recorded. · Ref. 0af76519');
  });

  it('leaves refusals, missing answers and other errors alone', () => {
    expect(withReference('Out of stock.', failure(409, 'abcdef12-0000-0000-0000-000000000000'))).toBe('Out of stock.');
    expect(withReference('No connection.', failure(0))).toBe('No connection.');
    expect(withReference('No reference.', failure(500))).toBe('No reference.');
    expect(withReference('Oops.', new Error('x'))).toBe('Oops.');
  });
});
