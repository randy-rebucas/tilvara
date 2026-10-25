import { describe, expect, it } from 'vitest';
import { canonicalJson, offlineSaleSchema, syncSalesBatchSchema, syncSalesRequestSchema } from '../src/index.js';

const sale = {
  terminalTxnId: '0199f0a0-0000-7000-8000-000000000001',
  deviceSeq: 1,
  snapshotId: '0199f0a0-0000-7000-8000-000000000002',
  cashierSessionId: '0199f0a0-0000-7000-8000-000000000003',
  cashierUserId: '0199f0a0-0000-7000-8000-000000000004',
  occurredAt: '2026-10-17T10:00:00+08:00',
  localReference: 'R1-T1A2B-000001',
  lines: [{ variantId: '0199f0a0-0000-7000-8000-000000000005', quantity: '2' }],
  tenders: [{ method: 'CASH' as const, tendered: '100.00' }],
  amountDue: '44.80',
};

describe('offline sale envelope', () => {
  it('accepts a cash sale and refuses anything that cannot be taken offline', () => {
    expect(offlineSaleSchema.parse(sale)).toMatchObject({ deviceSeq: 1, amountDue: '44.80' });
    expect(offlineSaleSchema.safeParse({ ...sale, tenders: [{ method: 'INTENT', paymentIntentId: sale.snapshotId }] }).success).toBe(false);
    expect(offlineSaleSchema.safeParse({ ...sale, deviceSeq: 0 }).success).toBe(false);
    expect(offlineSaleSchema.safeParse({ ...sale, amountDue: 44.8 }).success).toBe(false); // never JS numbers for money
    expect(offlineSaleSchema.safeParse({ ...sale, occurredAt: '2026-10-17 10:00' }).success).toBe(false);
    // Tips, service staff and prescriptions were removed (migration 0112): a sale queued before the update
    // that still carries one fails the check, so the server quarantines it instead of recording it without.
    expect(offlineSaleSchema.safeParse({ ...sale, tip: { amount: '5.00' } }).success).toBe(false);
    expect(offlineSaleSchema.safeParse({ ...sale, prescriptions: [] }).success).toBe(false);
    expect(offlineSaleSchema.safeParse({ ...sale, lines: sale.lines.map((l) => ({ ...l, staffId: sale.snapshotId })) }).success).toBe(false);
    expect(syncSalesRequestSchema.safeParse({ sales: [] }).success).toBe(false);
  });

  it('the server reads a batch by each envelope’s head only, so one malformed envelope does not refuse the others', () => {
    const bad = { ...sale, terminalTxnId: '0199f0a0-0000-7000-8000-000000000009', deviceSeq: 2, amountDue: 44.8, extra: { kept: true } };
    const parsed = syncSalesBatchSchema.parse({ sales: [sale, bad] });
    expect(parsed.sales[1]).toEqual(bad); // kept as received, for the quarantine
    expect(syncSalesRequestSchema.safeParse({ sales: [sale, bad] }).success).toBe(false);
    expect(syncSalesBatchSchema.safeParse({ sales: [{ ...sale, terminalTxnId: 'not-a-uuid' }] }).success).toBe(false);
    expect(syncSalesBatchSchema.safeParse({ sales: [{ ...sale, deviceSeq: '1' }] }).success).toBe(false);
    expect(syncSalesBatchSchema.safeParse({ sales: ['x'] }).success).toBe(false);
    expect(syncSalesBatchSchema.safeParse({ sales: [] }).success).toBe(false);
  });

  it('hashes the same content the same way whatever the key order', () => {
    const { amountDue, ...rest } = sale;
    const reordered = { amountDue, ...rest, lines: [{ quantity: '2', variantId: sale.lines[0]!.variantId }] };
    expect(canonicalJson(offlineSaleSchema.parse(reordered))).toBe(canonicalJson(offlineSaleSchema.parse(sale)));
    expect(canonicalJson({ b: [1, { d: 'x', c: null }], a: undefined })).toBe('{"b":[1,{"c":null,"d":"x"}]}');
  });
});
