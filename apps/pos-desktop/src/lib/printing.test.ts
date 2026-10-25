import { encodeEscPos, toText } from '@1pos/escpos';
import { describe, expect, it } from 'vitest';
import type { Receipt } from '../types';
import { escposDrawer, escposPrinter } from './devices';
import { offlineReceiptToPrintable, receiptToPrintable, tenderLabel } from './printing';

const receipt: Receipt = {
  notice: 'THIS IS NOT AN OFFICIAL INVOICE',
  seller: { name: 'Tindahan ni Lito', registeredName: 'Lito Santos Trading', address: null, tinLabel: 'VAT REG TIN', tin: '234-567-891-00000', branch: 'Makati' },
  transaction: { reference: 'R1-000001', dateTime: '10/17/2026, 01:14:24', register: 'Front', cashier: 'Lito Santos' },
  lines: [
    { name: 'Coffee', quantity: '1', unitPrice: '150.00', amount: '107.14', flag: 'E' },
    { name: 'Bottled water', quantity: '1', unitPrice: '45.00', amount: '45.00', flag: 'V' },
  ],
  totals: { currency: 'PHP', gross: '216.79', vatableSales: '40.18', vatLabel: 'VAT 12%', vatAmount: '4.82', vatExemptSales: '133.93', zeroRatedSales: '0.00', statutoryDiscount: '26.79', amountDue: '173.64', tendered: '200.00', change: '26.36' },
  tenders: [{ method: 'CASH', amount: '173.64' }],
  statutory: [{ label: 'Senior citizen', name: 'Lola Cruz', idNumber: 'OSCA-123', discount: '26.79', signatureLine: true }],
  legend: 'V = VATable, E = VAT-exempt, Z = zero-rated',
};

describe('receipt for a thermal printer', () => {
  it('keeps the server receipt’s content and order: lines, totals with deductions signed, tenders, the SC/PWD block to sign', () => {
    const text = toText(receiptToPrintable(receipt), 48);
    const lines = text.split('\n');
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(lines[0]!.trim()).toBe('Tindahan ni Lito');
    expect(text).toContain('VAT REG TIN 234-567-891-00000');
    expect(text).toContain('THIS IS NOT AN OFFICIAL INVOICE');
    expect(text).toContain(`Coffee${' '.repeat(34)}107.14 E`);
    expect(text).toContain(`SC/PWD discount${' '.repeat(23)}-PHP 26.79`);
    expect(at('VAT 12%')).toBeGreaterThan(at('VATable sales'));
    expect(at('TOTAL DUE')).toBeLessThan(at('CASH'));
    expect(at('CASH')).toBeLessThan(at('Tendered'));
    expect(at('Tendered')).toBeLessThan(at('Change'));
    expect(at('Senior citizen: Lola Cruz')).toBeGreaterThan(at('Change'));
    expect(text).toContain('Signature of the beneficiary');
    expect(lines.at(-1)!.trim()).toBe('Cashier: Lito Santos - Front');
    // One beneficiary: the discount prints once, in the totals, not again in the block.
    expect(lines.filter((l) => l.includes('26.79'))).toHaveLength(1);
  });

  it('prints an older sale’s service charge on its own line after the items, before the totals', () => {
    const text = toText(receiptToPrintable({ ...receipt, charges: [{ kind: 'SERVICE_CHARGE', label: 'Service charge 10%', amount: '21.50', flag: 'V' }] }), 48);
    const lines = text.split('\n');
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(text).toContain(`Service charge 10%${' '.repeat(23)}21.50 V`);
    expect(at('Service charge 10%')).toBeGreaterThan(at('Bottled water'));
    expect(at('Service charge 10%')).toBeLessThan(at('TOTAL DUE'));
  });

  it('prints each beneficiary’s share only when the discount is split between several', () => {
    const split: Receipt = {
      ...receipt,
      statutory: [
        { label: 'Senior citizen', name: 'Lola Cruz', idNumber: 'OSCA-123', discount: '16.07', signatureLine: true },
        { label: 'PWD', name: 'Ben Reyes', idNumber: 'PWD-456', discount: '10.72', signatureLine: true },
      ],
    };
    const text = toText(receiptToPrintable(split), 48);
    expect(text).toContain(`SC/PWD discount${' '.repeat(23)}-PHP 26.79`);
    expect(text).toContain(`Discount${' '.repeat(30)}-PHP 16.07`);
    expect(text).toContain(`Discount${' '.repeat(30)}-PHP 10.72`);
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

describe('tender labels (session 20)', () => {
  it('names an exchange credit by its return, store credit in words, the rest by method', () => {
    expect(tenderLabel({ method: 'CASH', exchangeReturnNumber: 12 })).toBe('EXCHANGE CREDIT (RETURN #000012)');
    expect(tenderLabel({ method: 'STORE_CREDIT' })).toBe('STORE CREDIT');
    expect(tenderLabel({ method: 'CARD' })).toBe('CARD');
  });

  it('prints the customer on the receipt when the sale has one', () => {
    const text = toText(receiptToPrintable({ ...receipt, customer: { name: 'Rosa Lim', tin: '123-456-789' } }), 48);
    expect(text).toContain('Customer: Rosa Lim');
    expect(text).toContain('TIN 123-456-789');
    expect(toText(receiptToPrintable(receipt), 48)).not.toContain('Customer:');
  });
});

describe('medicines on the receipt (ADR-0025)', () => {
  const pharmacy: Receipt = {
    ...receipt,
    lines: [
      { name: 'Biogesic', quantity: '2', unitPrice: '5.50', amount: '8.80', flag: 'E', generic: 'Paracetamol 500 mg tablet', lots: ['Lot NEW-1 · Exp 03/2027', 'Lot NEW-2 · Exp 05/2027'] },
      { name: 'Cotton balls', quantity: '1', unitPrice: '20.00', amount: '20.00', flag: 'V' },
    ],
    statutory: [{ label: 'Senior citizen', name: 'Lola Cruz', idNumber: 'OSCA-123', discount: '2.20', signatureLine: true, purchaseBooklet: true }],
  };

  it('prints the generic and each lot under the medicine, and the booklet under the SC/PWD details', () => {
    const text = toText(receiptToPrintable(pharmacy), 48);
    const lines = text.split('\n');
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    // The detail wraps at the paper width (indented), one medicine's generic and batches together.
    expect(text).toContain('  2 x 5.50 | Paracetamol 500 mg tablet | Lot\n  NEW-1 - Exp 03/2027 | Lot NEW-2 - Exp 05/2027');
    expect(at('Paracetamol')).toBeGreaterThan(at('Biogesic'));
    expect(at('Paracetamol')).toBeLessThan(at('Cotton balls'));
    expect(lines[at('Cotton balls') + 1]!.trim()).toBe('1 x 20.00');
    expect(at('Purchase booklet presented')).toBe(at('ID OSCA-123') + 1);
    // No booklet (false or not a medicine): nothing printed.
    const without = toText(receiptToPrintable({ ...pharmacy, statutory: [{ ...pharmacy.statutory[0]!, purchaseBooklet: false }] }), 48);
    expect(without).not.toContain('booklet');
  });

  it('prints the generic on an offline receipt (no lots offline)', () => {
    const doc = offlineReceiptToPrintable({
      localReference: 'R1-TAbCd-000043', occurredAt: '2026-10-17T02:00:00.000Z', register: { code: 'R1', name: 'Front' }, branch: { name: 'Cubao' },
      seller: { name: 'Botika', registeredName: 'Botika Inc', tin: null, vatStatus: 'VAT' }, cashierName: 'Maria',
      lines: [{ name: 'Amoxil 500', quantity: '7', unitPrice: '18.00', amount: '126.00', flag: 'E', generic: 'Amoxicillin 500 mg capsule' }],
      totals: { gross: '126.00', vatableSales: '0.00', vatAmount: '0.00', vatExemptSales: '126.00', zeroRatedSales: '0.00', percentageTaxSales: '0.00', amountDue: '126.00' },
      tendered: '200.00', change: '74.00', notice: 'OFFLINE',
    }, '10/17/2026, 10:00:00');
    expect(toText(doc, 48)).toContain('7 x 18.00 | Amoxicillin 500 mg capsule');
  });
});
