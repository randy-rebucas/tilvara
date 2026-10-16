import { encodeEscPos, toText } from '@1pos/escpos';
import { describe, expect, it } from 'vitest';
import type { Receipt } from '../types';
import { escposDrawer, escposPrinter } from './devices';
import { offlineReceiptToPrintable, receiptToPrintable } from './printing';

const receipt: Receipt = {
  notice: 'THIS IS NOT AN OFFICIAL INVOICE',
  seller: { name: 'Kainan ni Lito', registeredName: 'Lito Santos Foods', address: null, tinLabel: 'VAT REG TIN', tin: '234-567-891-00000', branch: 'Makati' },
  transaction: { reference: 'R1-000001', dateTime: '10/17/2026, 01:14:24', register: 'Front', cashier: 'Lito Santos' },
  lines: [
    { name: 'Burger', quantity: '1', unitPrice: '150.00', amount: '107.14', flag: 'E' },
    { name: 'Iced tea', quantity: '1', unitPrice: '45.00', amount: '45.00', flag: 'V' },
  ],
  charges: [{ kind: 'SERVICE_CHARGE', label: 'Service charge 10%', amount: '21.50', flag: 'V' }],
  totals: { currency: 'PHP', gross: '216.79', vatableSales: '40.18', vatLabel: 'VAT 12%', vatAmount: '4.82', vatExemptSales: '133.93', zeroRatedSales: '0.00', statutoryDiscount: '26.79', amountDue: '173.64', tendered: '200.00', change: '26.36' },
  tenders: [{ method: 'CASH', amount: '173.64' }],
  statutory: [{ label: 'Senior citizen', name: 'Lola Cruz', idNumber: 'OSCA-123', discount: '26.79', signatureLine: true }],
  legend: 'V = VATable, E = VAT-exempt, Z = zero-rated',
};

describe('receipt for a thermal printer', () => {
  it('keeps the server receipt’s content and order: lines, the charge, totals with deductions signed, tenders, the SC/PWD block to sign', () => {
    const text = toText(receiptToPrintable(receipt), 48);
    const lines = text.split('\n');
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(lines[0]!.trim()).toBe('Kainan ni Lito');
    expect(text).toContain('VAT REG TIN 234-567-891-00000');
    expect(text).toContain('THIS IS NOT AN OFFICIAL INVOICE');
    expect(text).toContain(`Burger${' '.repeat(34)}107.14 E`);
    expect(text).toContain(`Service charge 10%${' '.repeat(23)}21.50 V`);
    expect(text).toContain(`SC/PWD discount${' '.repeat(23)}-PHP 26.79`);
    expect(at('VAT 12%')).toBeGreaterThan(at('VATable sales'));
    expect(at('TOTAL DUE')).toBeLessThan(at('CASH'));
    expect(at('CASH')).toBeLessThan(at('Tendered'));
    expect(at('Tendered')).toBeLessThan(at('Change'));
    expect(at('Senior citizen: Lola Cruz')).toBeGreaterThan(at('Change'));
    expect(text).toContain('Signature of the beneficiary');
    expect(lines.at(-1)!.trim()).toBe('Cashier: Lito Santos - Front');
  });

  it('prints an offline sale with its local reference and that it is not an invoice', () => {
    const doc = offlineReceiptToPrintable({
      localReference: 'R1-TAbCd-000042', occurredAt: '2026-10-17T02:00:00.000Z', register: { code: 'R1', name: 'Front' }, branch: { name: 'Cubao' },
      seller: { name: 'Tindahan ni Nena', registeredName: 'Nena Trading', tin: '123-456-789-00000', vatStatus: 'VAT' }, cashierName: 'Maria',
      lines: [{ name: 'Cola', quantity: '2', unitPrice: '22.40', amount: '44.80', flag: 'V' }],
      totals: { gross: '44.80', vatableSales: '40.00', vatAmount: '4.80', vatExemptSales: '0.00', zeroRatedSales: '0.00', percentageTaxSales: '0.00', amountDue: '44.80' },
      tendered: '50.00', change: '5.20', notice: 'THIS IS NOT AN OFFICIAL INVOICE — OFFLINE SALE, RECORDED WHEN THE TILL RECONNECTS',
    }, '10/17/2026, 10:00:00');
    const text = toText(doc, 32);
    expect(text).toContain('R1-TAbCd-000042');
    expect(text).toContain('THIS IS NOT AN OFFICIAL INVOICE');
    expect(text).toContain('OFFLINE SALE');
    expect(text).toContain('Change                  PHP 5.20');
  });
});

describe('ESC/POS printer port', () => {
  const doc = receiptToPrintable(receipt);
  it('sends the encoded receipt, and fails (for "print again") when the printer refuses or never answers', async () => {
    const sent: Uint8Array[] = [];
    await escposPrinter(async (b) => void sent.push(b), { width: 32 }).print({} as HTMLElement, doc);
    expect(sent[0]).toEqual(encodeEscPos(doc, { width: 32 }));
    await expect(escposPrinter(async () => { throw new Error('Paper out'); }).print({} as HTMLElement, doc)).rejects.toThrow('Paper out');
    await expect(escposPrinter(() => new Promise(() => undefined), { timeoutMs: 20 }).print({} as HTMLElement, doc)).rejects.toThrow('did not answer');
  });

  it('kicks the drawer with a single pulse', async () => {
    const sent: Uint8Array[] = [];
    await escposDrawer(async (b) => void sent.push(b)).open();
    expect(Buffer.from(sent[0]!).toString('hex')).toBe('1b401b700019fa');
  });
});
