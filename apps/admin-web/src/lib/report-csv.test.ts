import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../i18n/messages';
import { csvField, reportPath, reportRows, toCsv } from './report-csv';

const t = (key: MessageKey, vars?: Record<string, string | number>) => translate('en', key, vars);

describe('report CSV', () => {
  it('quotes commas, quotes and line breaks, and defuses formulas', () => {
    expect(csvField('Lola, Cruz')).toBe('"Lola, Cruz"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('@cmd')).toBe("'@cmd");
    expect(csvField('-12.50')).toBe('-12.50'); // a negative amount stays a number
    expect(csvField('-1+1')).toBe("'-1+1");
    expect(csvField(null)).toBe('');
    expect(csvField(3)).toBe('3');
  });

  it('starts with a BOM and ends rows with CRLF', () => {
    expect(toCsv([['a', 'b'], ['₱', 'ñ']])).toBe('﻿a,b\r\n₱,ñ\r\n');
  });

  it('keeps exact decimal strings: tender report', () => {
    const rows = reportRows('tenders', { data: [{ method: 'CASH', tenders: 2, collected: '60.80', refundsCount: 1, refunded: '22.40', net: '38.40' }] }, t);
    expect(rows).toEqual([['Method', 'Count', 'Collected', 'Returns count', 'Refunded', 'Net'], ['CASH', 2, '60.80', 1, '22.40', '38.40']]);
  });

  it('sales summary: three rows per day (sales, returns, net) in the receipt buckets', () => {
    const b = (amountDue: string) => ({ gross: amountDue, discount: '0.00', statutoryDiscount: '0.00', vatExemptionAmount: '0.00', vatableSales: '0.00', vatAmount: '0.00', vatExemptSales: '0.00', zeroRatedSales: '0.00', percentageTaxSales: '0.00', amountDue });
    const rows = reportRows('sales', { days: [{ day: '2026-10-17', salesCount: 2, returnsCount: 1, voidsCount: 0, sales: b('60.80'), returns: b('22.40'), net: b('38.40') }] }, t);
    expect(rows).toHaveLength(4);
    expect(rows[1]!.slice(0, 3)).toEqual(['2026-10-17', 'Sales', 2]);
    expect(rows[3]!.at(-1)).toBe('38.40');
  });

  it('builds the API path for each report', () => {
    const q = { branchId: 'b', from: '2026-10-01', to: '2026-10-17' };
    expect(reportPath('statutory', q)).toBe('/reports/statutory-book?branchId=b&from=2026-10-01&to=2026-10-17');
    expect(reportPath('refunds', q)).toBe('/reports/refund-watch?branchId=b&from=2026-10-01&to=2026-10-17');
  });

  it('refund watch: exact amounts and ratios, flags as words in one cell', () => {
    const t = (k: string) => k;
    const rows = reportRows('refunds', {
      data: [{ userId: 'u', displayName: 'Ana', salesCount: 4, sales: '400.00', returnsCount: 0, returns: '0.00', voidsCount: 3, voids: '300.00', ownSalesRefunded: 3, refunded: '300.00', refundRate: '0.7500', flags: ['HIGH_RATE', 'OWN_SALES'] }],
      branch: { sales: '1000.00', refunded: '300.00', refundRate: '0.3000' },
    }, t as never);
    expect(rows[1]).toEqual(['Ana', 4, '400.00', 0, '0.00', 3, '300.00', 3, '0.7500', 'HIGH_RATE OWN_SALES']);
  });

  it('session 20 reports: the consolidated report has no branch in its path; discounts keep who approved', () => {
    const q = { branchId: 'b', from: '2026-10-01', to: '2026-10-20' };
    expect(reportPath('branches', q)).toBe('/reports/by-branch?from=2026-10-01&to=2026-10-20');
    expect(reportPath('payments', q)).toBe('/reports/payment-exceptions?branchId=b');
    const rows = reportRows('discounts', {
      data: [{ saleId: 's', reference: 'R1-000002', completedAt: '2026-10-20T01:00:00Z', name: 'Cola', quantity: '1', listUnitPrice: '22.4', unitPrice: '20', discount: '0.00', priceChange: '2.40', cashierName: 'Ana', approvedByName: 'Jun', approvalMethod: 'CREDENTIALS', priceReason: 'Dented can' }],
      byCashier: [], totals: { lines: 1, discount: '0.00', priceChange: '2.40' },
    }, t);
    expect(rows[1]).toEqual(['R1-000002', '2026-10-20T01:00:00Z', 'Cola', '1', '22.4', '20', '0.00', '2.40', 'Ana', 'Jun', 'Dented can']);
    const branches = reportRows('branches', {
      from: '2026-10-20', to: '2026-10-20',
      data: [{ branchId: 'b', code: 'B1', name: 'One', salesCount: 2, sales: '10.00', returnsCount: 0, returns: '0.00', netSales: '10.00', vatAmount: '1.07', netExVat: '8.93', discount: '0.00', statutoryDiscount: '0.00' }],
      totals: { salesCount: 2, returnsCount: 0, sales: '10.00', returns: '0.00', netSales: '10.00', vatAmount: '1.07', netExVat: '8.93', discount: '0.00', statutoryDiscount: '0.00' },
    }, t);
    expect(branches.at(-1)).toEqual(['All branches', 2, '10.00', 0, '0.00', '10.00', '1.07', '8.93', '0.00', '0.00']);
  });

  it('session 26: promotions with their kind in words; sizes and colours by the chosen attribute', () => {
    const q = { branchId: 'b', from: '2026-10-01', to: '2026-10-20' };
    expect(reportPath('promotions', q)).toBe('/reports/promotions?branchId=b&from=2026-10-01&to=2026-10-20');
    expect(reportPath('attributes', { ...q, attribute: 'Size & fit' })).toBe('/reports/by-attribute?branchId=b&from=2026-10-01&to=2026-10-20&attribute=Size%20%26%20fit');
    expect(reportPath('attributes', q)).toBe('/reports/by-attribute?branchId=b&from=2026-10-01&to=2026-10-20');
    const promos = reportRows('promotions', { data: [{ promotionId: 'p', name: '3 for 800', kind: 'MULTI_BUY', salesCount: 2, netQuantity: '6', discount: '298.00', netSales: '1600.00' }] }, t);
    expect(promos[1]).toEqual(['3 for 800', 'Multi-buy', 2, '6', '298.00', '1600.00']);
    const sizes = reportRows('attributes', {
      attribute: 'Size',
      attributes: ['Colour', 'Size'],
      data: [
        { value: 'M', quantitySold: '3', quantityReturned: '1', netQuantity: '2', netSales: '700.00', revenueExVat: '625.00' },
        { value: null, quantitySold: '1', quantityReturned: '0', netQuantity: '1', netSales: '50.00', revenueExVat: '44.64' },
      ],
    }, t);
    expect(sizes[0]![0]).toBe('Size');
    expect(sizes[1]).toEqual(['M', '3', '1', '2', '700.00', '625.00']);
    expect(sizes[2]![0]).toBe('No Size');
  });
});

describe('SC/PWD book CSV', () => {
  it('one row per beneficiary, ending with the net', () => {
    const row = { document: 'SALE', day: '2026-10-21', number: 1, register: 'R1', schemeCode: 'SC', name: 'Lola', idNumber: 'SC-1', tin: null, sales: '100.00', discount: '20.00', net: '80.00' };
    const rows = reportRows('statutory', { data: [row] }, t);
    expect(rows[1]).toEqual(['2026-10-21', 'SALE', 1, 'R1', 'SC', 'Lola', 'SC-1', '', '100.00', '20.00', '80.00']);
  });
});
