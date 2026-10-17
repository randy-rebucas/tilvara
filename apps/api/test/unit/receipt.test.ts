import { describe, expect, it } from 'vitest';
import { buildReceipt, buildReturnReceipt, DEV_SERIES_NOTICE, formatTin, NOT_AN_INVOICE, RETURN_NOTICE, VOID_NOTICE, type ReceiptInput } from '../../src/sales/receipt.js';

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
    { name: 'Lola meal', quantity: '1', unitPrice: '1120.0000', gross: '1120.00', discount: '0.00', statutoryDiscount: '200.00', vatTreatment: 'VATABLE', vatableSales: '0.00', vatExemptSales: '1000.00', beneficiaryId: 'b1' },
    { name: 'Cola', quantity: '1', unitPrice: '22.4000', gross: '22.40', discount: '0.00', statutoryDiscount: '0.00', vatTreatment: 'VATABLE', vatableSales: '20.00', vatExemptSales: '0.00', beneficiaryId: null },
  ],
  tenders: [{ method: 'CASH', amount: '822.40', tendered: '1000.00', change: '177.60' }],
  beneficiaries: [{ id: 'b1', schemeCode: 'SC', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001', tin: null }],
};

describe('buildReturnReceipt', () => {
  const ret = (kind: 'RETURN' | 'VOID') =>
    buildReturnReceipt({
      invoicingMode: 'DISABLED', seller: base.seller, branch: base.branch, register: base.register, processedBy: 'Manager Mia',
      sale: { saleNumber: 42, registerCode: 'R1', vatRate: '0.12', currency: 'PHP' },
      doc: { kind, returnNumber: 3, reason: 'Dented can', createdAt: new Date('2026-10-16T03:00:00Z'), refundMethod: null, vatableSales: '20.00', vatAmount: '2.40', vatExemptSales: '0.00', zeroRatedSales: '0.00', percentageTaxSales: '0.00', statutoryDiscount: '0.00', vatExemptionAmount: '0.00', amountDue: '22.40' },
      lines: [{ name: 'Cola', quantity: '1', unitPrice: '22.4000', amountDue: '22.40', vatTreatment: 'VATABLE', vatableSales: '20.00', vatExemptSales: '0.00', disposition: 'DAMAGED' }],
    });
  it('is a refund slip against the original sale, never an invoice or an official receipt', () => {
    const r = ret('RETURN');
    expect(r).toMatchObject({ documentType: 'RETURN_SLIP', notice: RETURN_NOTICE, transaction: { reference: 'RETURN 3 of R1-000042', cashier: 'Manager Mia', dateTime: '10/16/2026, 11:00:00' } });
    expect(r.totals).toMatchObject({ refund: '22.40', vatAmount: '2.40' });
    expect(r.lines).toEqual([{ name: 'Cola (damaged)', quantity: '1', unitPrice: '22.40', amount: '22.40', flag: 'V' }]);
    expect(JSON.stringify(r)).not.toMatch(/official receipt/i);
    expect(ret('VOID')).toMatchObject({ documentType: 'VOID_SLIP', notice: VOID_NOTICE });
  });
});

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
    // The SC line is printed as what it was taxed as (exempt), not as its item's category.
    expect(r.lines.map((l) => l.flag)).toEqual(['E', 'V']);
    const shared = buildReceipt({
      ...base,
      lines: [{ ...base.lines[0]!, quantity: '2', vatableSales: '500.00', vatExemptSales: '500.00' }],
    });
    expect(shared.lines[0]!.flag).toBe('V/E');
  });

  it('non-VAT sellers get NON-VAT REG TIN and percentage-tax wording, no VAT lines', () => {
    const r = buildReceipt({ ...base, seller: { ...base.seller, vatStatus: 'NON_VAT' } });
    expect(r.seller.tinLabel).toBe('NON-VAT REG TIN');
    expect(r.totals).not.toHaveProperty('vatAmount');
    expect(r.totals).toHaveProperty('salesSubjectToPercentageTax');
    expect(r.legend).toBeNull();
  });

  it('prints a service charge with its VAT, so the printed lines add up to the gross and the total', () => {
    // Half a split check: burger 150 + cheese 20 + tea 45 = 215.00 incl. VAT; charge 19.19 + VAT 2.31.
    const r = buildReceipt({
      ...base,
      sale: { ...base.sale, gross: '234.19', statutoryDiscount: '0.00', vatExemptionAmount: '0.00', vatableSales: '211.16', vatAmount: '25.34', vatExemptSales: '0.00', amountDue: '236.50', amountTendered: '250.00', changeDue: '13.50' },
      lines: [{ name: 'Burger etc.', quantity: '1', unitPrice: '215.0000', gross: '215.00', discount: '0.00', statutoryDiscount: '0.00', vatTreatment: 'VATABLE', vatableSales: '191.97', vatExemptSales: '0.00', beneficiaryId: null }],
      beneficiaries: [],
      charges: [{ kind: 'SERVICE_CHARGE', rate: '0.1', gross: '19.19', amountDue: '21.50', vatTreatment: 'VATABLE' }],
    });
    expect(r.charges).toEqual([{ kind: 'SERVICE_CHARGE', label: 'Service charge 10%', amount: '21.50', flag: 'V' }]);
    expect([r.totals.gross, r.totals.amountDue]).toEqual(['236.50', '236.50']);
    const nonVat = buildReceipt({ ...base, seller: { ...base.seller, vatStatus: 'NON_VAT' }, charges: [{ kind: 'SERVICE_CHARGE', rate: '0.1', gross: '5.00', amountDue: '5.00', vatTreatment: 'VATABLE' }] });
    expect(nonVat.charges![0]!.flag).toBe('');
  });

  it('formats TINs only when present', () => {
    expect(formatTin(null, '00000')).toBeNull();
    expect(formatTin('987654321', '00002')).toBe('987-654-321-00002');
  });
});
