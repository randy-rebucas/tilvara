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

  it('builds the API path for each report (open orders by day)', () => {
    const q = { branchId: 'b', from: '2026-10-01', to: '2026-10-17', day: '2026-10-17' };
    expect(reportPath('statutory', q)).toBe('/reports/statutory-book?branchId=b&from=2026-10-01&to=2026-10-17');
    expect(reportPath('open', q)).toBe('/reports/open-orders?branchId=b&day=2026-10-17');
  });
});
