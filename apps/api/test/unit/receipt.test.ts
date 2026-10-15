import { describe, expect, it } from 'vitest';
import { buildReceipt, DEV_SERIES_NOTICE, formatTin, NOT_AN_INVOICE, type ReceiptInput } from '../../src/sales/receipt.js';

const base: ReceiptInput = {
  invoicingMode: 'DISABLED',
  seller: { registeredName: 'Nena Reyes Trading', tradeName: 'Tindahan ni Aling Nena', registeredAddress: 'Cubao, QC', tin: '123456789', vatStatus: 'VAT' },
  branch: { name: 'Cubao', code: 'QC-01', birBranchCode: '00000', address: null, timezone: 'Asia/Manila' },
  register: { code: 'R1', name: 'Counter 1' },
  cashierName: 'Maria Santos',
  sale: {
    saleNumber: 42,
    completedAt: new Date('2026-10-16T02:30:05Z'),
    currency: 'PHP',
    gross: '1142.40',
    discount: '0.00',
    statutoryDiscount: '200.00',
    vatExemptionAmount: '120.00',
    vatableSales: '20.00',
    vatAmount: '2.40',
    vatExemptSales: '1000.00',
    zeroRatedSales: '0.00',
    percentageTaxSales: '0.00',
    amountDue: '822.40',
    amountTendered: '1000.00',
    changeDue: '177.60',
    vatRate: '0.12',
  },
  lines: [
    { name: 'Lola meal', quantity: '1', unitPrice: '1120.0000', gross: '1120.00', discount: '0.00', statutoryDiscount: '200.00', vatTreatment: 'VATABLE', beneficiaryId: 'b1' },
    { name: 'Cola', quantity: '1', unitPrice: '22.4000', gross: '22.40', discount: '0.00', statutoryDiscount: '0.00', vatTreatment: 'VATABLE', beneficiaryId: null },
  ],
  tenders: [{ method: 'CASH', amount: '822.40', tendered: '1000.00', change: '177.60' }],
  beneficiaries: [{ id: 'b1', schemeCode: 'SC', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001', tin: null }],
};

describe('buildReceipt', () => {
  it('never claims to be an invoice while invoicing is disabled', () => {
    const r = buildReceipt(base);
    expect(r).toMatchObject({ documentType: 'SALES_RECEIPT', notice: NOT_AN_INVOICE });
    expect(JSON.stringify(r)).not.toMatch(/official receipt/i);
    expect(buildReceipt({ ...base, invoicingMode: 'DEV_SERIES' }).notice).toBe(DEV_SERIES_NOTICE);
  });

  it('shows the VAT REG TIN with branch code, local time and a register-scoped reference', () => {
    const r = buildReceipt(base);
    expect(r.seller).toMatchObject({ name: 'Tindahan ni Aling Nena', tinLabel: 'VAT REG TIN', tin: '123-456-789-00000', address: 'Cubao, QC' });
    expect(r.transaction).toMatchObject({ reference: 'R1-000042', timezone: 'Asia/Manila', cashier: 'Maria Santos' });
    expect(r.transaction.dateTime).toContain('10:30:05');
  });

  it('breaks down VATable, VAT, exempt sales, the VAT exemption and the SC discount with ID and signature line', () => {
    const r = buildReceipt(base);
    expect(r.totals).toMatchObject({ vatableSales: '20.00', vatLabel: 'VAT 12%', vatAmount: '2.40', vatExemptSales: '1000.00', vatExemption: '120.00', statutoryDiscount: '200.00', amountDue: '822.40', change: '177.60' });
    expect(r.statutory).toEqual([{ scheme: 'SC', label: 'Senior citizen', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001', tin: null, discount: '200.00', signatureLine: true }]);
    expect(r.lines.map((l) => l.flag)).toEqual(['V', 'V']);
  });

  it('non-VAT sellers get NON-VAT REG TIN and percentage-tax wording, no VAT lines', () => {
    const r = buildReceipt({ ...base, seller: { ...base.seller, vatStatus: 'NON_VAT' } });
    expect(r.seller.tinLabel).toBe('NON-VAT REG TIN');
    expect(r.totals).not.toHaveProperty('vatAmount');
    expect(r.totals).toHaveProperty('salesSubjectToPercentageTax');
    expect(r.legend).toBeNull();
  });

  it('formats TINs only when present', () => {
    expect(formatTin(null, '00000')).toBeNull();
    expect(formatTin('987654321', '00002')).toBe('987-654-321-00002');
  });
});
