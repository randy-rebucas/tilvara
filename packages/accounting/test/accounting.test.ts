import { describe, expect, it } from 'vitest';
import {
  balanced,
  cashMovementPosting,
  cashVariancePosting,
  DEFAULT_CHART,
  goodsReceiptPosting,
  reversalOf,
  salePosting,
  saleReturnPosting,
  stockChangePosting,
  supplierReturnPosting,
  transferDispatchPosting,
  transferReceiptPosting,
  UnbalancedEntryError,
  type PostingLine,
} from '../src/index.js';

/** account → signed amount (debit +, credit −), for readable expectations. */
const net = (lines: PostingLine[]) =>
  Object.fromEntries(lines.map((l) => [l.account, (Number(l.debit) - Number(l.credit)).toFixed(2)]));

describe('posting rules', () => {
  it('cash sale with VATable and exempt items (₱115.80, Phase 2 golden)', () => {
    const lines = salePosting({ salesExVat: '109.39', vatAmount: '6.41', statutoryDiscount: '0', cash: '115.80', electronic: '0', cogs: '70.00' });
    expect(net(lines)).toEqual({ CASH_ON_HAND: '115.80', SALES: '-109.39', OUTPUT_VAT: '-6.41', COGS: '70.00', INVENTORY: '-70.00' });
  });

  it('senior citizen sale: discount as contra-revenue, no output VAT (₱20.00 → ₱16.00)', () => {
    const lines = salePosting({ salesExVat: '20.00', vatAmount: '0', statutoryDiscount: '4.00', cash: '0', electronic: '16.00', cogs: '0' });
    expect(net(lines)).toEqual({ PAYMENT_CLEARING: '16.00', STATUTORY_DISCOUNTS: '4.00', SALES: '-20.00' });
  });

  it('a sale whose money does not add up is refused', () => {
    expect(() => salePosting({ salesExVat: '20.00', vatAmount: '2.40', statutoryDiscount: '0', cash: '22.39', electronic: '0', cogs: '0' })).toThrow(UnbalancedEntryError);
  });

  it('restaurant check: the service charge ex VAT is owed to staff, not revenue; its VAT is output VAT', () => {
    // Items ₱300 incl. VAT (267.86 + 32.14) + 10 % service charge on 267.86 = 26.79 + 3.21 VAT → ₱330.00.
    const lines = salePosting({ salesExVat: '267.86', serviceCharge: '26.79', vatAmount: '35.35', statutoryDiscount: '0', cash: '330.00', electronic: '0', cogs: '0' });
    expect(net(lines)).toEqual({ CASH_ON_HAND: '330.00', SALES: '-267.86', SERVICE_CHARGE_PAYABLE: '-26.79', OUTPUT_VAT: '-35.35' });
    const back = saleReturnPosting({ salesExVat: '267.86', serviceCharge: '26.79', vatAmount: '35.35', statutoryDiscount: '0', refund: '330.00', restocked: '0' });
    expect(net(back)).toEqual({ SALES_RETURNS: '267.86', SERVICE_CHARGE_PAYABLE: '26.79', OUTPUT_VAT: '35.35', CASH_ON_HAND: '-330.00' });
  });

  it('return reverses revenue, tax and discount; only restocked goods go back to inventory', () => {
    const lines = saleReturnPosting({ salesExVat: '20.00', vatAmount: '2.40', statutoryDiscount: '0', refund: '22.40', restocked: '12.00' });
    expect(net(lines)).toEqual({ SALES_RETURNS: '20.00', OUTPUT_VAT: '2.40', CASH_ON_HAND: '-22.40', INVENTORY: '12.00', COGS: '-12.00' });
  });

  it('goods receipt: owed at cost; a revaluation of units sold short goes to COGS', () => {
    // 5 @ 13.00 = 65.00 owed; the ledger recorded 62.40 (2 units had left at 11.70).
    const lines = goodsReceiptPosting({ stockValue: '62.40', stockAtCost: '65.00', nonStock: '150.00' });
    expect(net(lines)).toEqual({ INVENTORY: '62.40', COGS: '2.60', PURCHASES_NON_STOCK: '150.00', GRNI: '-215.00' });
  });

  it('supplier return: credit at purchase cost, stock out at average, difference is price variance', () => {
    const lines = supplierReturnPosting({ stockValueOut: '36.00', stockCredit: '42.00', nonStockCredit: '0' });
    expect(net(lines)).toEqual({ GRNI: '42.00', INVENTORY: '-36.00', PURCHASE_PRICE_VARIANCE: '-6.00' });
  });

  it('adjustments, waste and counts post to their expense accounts in either direction', () => {
    expect(net(stockChangePosting('WASTE', '-7.50'))).toEqual({ INVENTORY: '-7.50', INVENTORY_WASTE: '7.50' });
    expect(net(stockChangePosting('COUNT', '15.00'))).toEqual({ INVENTORY: '15.00', INVENTORY_ADJUSTMENTS: '-15.00' });
    expect(stockChangePosting('ADJUSTMENT', '0')).toEqual([]);
  });

  it('transfers: into transit, then out of transit with the shortfall as a loss', () => {
    expect(net(transferDispatchPosting('48.00', 'b1'))).toEqual({ INVENTORY_IN_TRANSIT: '48.00', INVENTORY: '-48.00' });
    const recv = transferReceiptPosting([{ sentValue: '48.00', arrivedAtCost: '36.00', stockValue: '36.00' }], 'b1', 'b2');
    expect(net(recv)).toEqual({ INVENTORY: '36.00', TRANSIT_LOSS: '12.00', INVENTORY_IN_TRANSIT: '-48.00' });
    expect(recv.find((l) => l.account === 'INVENTORY')!.branchId).toBe('b2');
    expect(recv.find((l) => l.account === 'INVENTORY_IN_TRANSIT')!.branchId).toBe('b1');
  });

  it('cash: pay-ins/outs against cash fund transfers, a short drawer to cash over/short', () => {
    expect(net(cashMovementPosting('-50.00'))).toEqual({ CASH_ON_HAND: '-50.00', CASH_TRANSFERS: '50.00' });
    expect(net(cashVariancePosting('-2.40'))).toEqual({ CASH_ON_HAND: '-2.40', CASH_OVER_SHORT: '2.40' });
  });

  it('a reversal mirrors every line and still balances', () => {
    const sale = salePosting({ salesExVat: '20.00', vatAmount: '2.40', statutoryDiscount: '0', cash: '22.40', electronic: '0', cogs: '12.00' });
    const rev = reversalOf(sale);
    expect(net(rev)).toEqual(Object.fromEntries(Object.entries(net(sale)).map(([k, v]) => [k, (-Number(v)).toFixed(2)])));
  });

  it('refuses lines that are both debit and credit, or negative', () => {
    expect(() => balanced([{ account: 'SALES', debit: '1', credit: '1' }, { account: 'COGS', debit: '0', credit: '0' }])).toThrow();
    expect(() => balanced([{ account: 'SALES', debit: '-1', credit: '0' }, { account: 'COGS', debit: '0', credit: '-1' }])).toThrow();
  });

  it('random sales always balance when their buckets are consistent', () => {
    for (let i = 0; i < 1000; i++) {
      const c = (n: number) => Math.floor(Math.random() * n * 100) / 100;
      const salesExVat = c(5000);
      const vat = c(600);
      const sd = Math.min(c(500), salesExVat);
      const due = salesExVat + vat - sd;
      const cash = Math.min(c(due), due);
      const lines = salePosting({ salesExVat: salesExVat.toFixed(2), vatAmount: vat.toFixed(2), statutoryDiscount: sd.toFixed(2), cash: cash.toFixed(2), electronic: (due - cash).toFixed(2), cogs: c(3000).toFixed(4) });
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  it('the default chart has unique keys and codes', () => {
    expect(new Set(DEFAULT_CHART.map((a) => a.key)).size).toBe(DEFAULT_CHART.length);
    expect(new Set(DEFAULT_CHART.map((a) => a.code)).size).toBe(DEFAULT_CHART.length);
  });
});
