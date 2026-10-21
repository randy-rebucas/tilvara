import { encodeEscPos, toText } from '@1pos/escpos';
import { describe, expect, it } from 'vitest';
import type { FolioStatement, JobTicket, Receipt } from '../types';
import type { KitchenTicketPrint } from '@1pos/pos-offline';
import { escposDrawer, escposPrinter } from './devices';
import { kitchenSlipToPrintable, serverTicketSlip } from './kitchen';
import { billToPrintable, jobQuantity, offlineReceiptToPrintable, receiptToPrintable, statementToPrintable, stubToPrintable, tagToPrintable, tenderLabel } from './printing';

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
    // One beneficiary: the discount prints once, in the totals, not again in the block.
    expect(lines.filter((l) => l.includes('26.79'))).toHaveLength(1);
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

  it('prints a bill for the table: lines with choices and seats, the charge, total, paid and left, never as a receipt', () => {
    const z = { gross: '0', discount: '0', statutoryDiscount: '0', vatExemptionAmount: '0', vatableSales: '0', zeroRatedSales: '0', vatExemptSales: '0', percentageTaxSales: '0' };
    const doc = billToPrintable({
      ...z, id: 'b', orderId: 'o', billNumber: 7, status: 'ACTIVE', requiresProfessionalReview: false, vatAmount: '50.68', amountDue: '473.00',
      lines: [
        { id: 'l1', parentLineId: null, name: 'Burger', quantity: '2', amountDue: '340.00', statutoryDiscount: '0', discount: '34.00', beneficiaryId: null, paidShare: '0/1', paidQuantity: '0', fullyPaid: false, seat: 2 },
        { id: 'l2', parentLineId: 'l1', name: 'Cheese', quantity: '2', amountDue: '40.00', statutoryDiscount: '0', discount: '0', beneficiaryId: null, paidShare: '0/1', paidQuantity: '0', fullyPaid: false },
      ],
      charges: [{ id: 'c', kind: 'SERVICE_CHARGE', rate: '0.1', amountDue: '43.00' }],
      checks: [{ id: 's', saleNumber: 1, amountDue: '236.50', completedAt: '' }], amountPaid: '236.50', amountRemaining: '236.50',
    }, { branch: 'Kainan ni Lito', where: 'T1', dateTime: '10/17/26, 8:00 PM' });
    const text = toText(doc, 48);
    expect(text).toContain('BILL - NOT AN OFFICIAL RECEIPT OR INVOICE');
    expect(text).not.toMatch(/OFFICIAL RECEIPT\s*$/m);
    expect(text).toContain('Bill 7 - T1'); // CP437 has no middle dot
    expect(text).toContain('2 x Burger (seat 2)');
    expect(text).toContain('+ Cheese');
    expect(text).toMatch(/^Discount\s+-34\.00$/m);
    expect(text).toContain('Service charge 10%');
    expect(text).toContain('PHP 473.00');
    expect(text).toContain('Left to pay');
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

describe('lodging (ADR-0023)', () => {
  it('prints a charge to a room with its line, amount and the guest’s signature line, after the payment', () => {
    const roomed: Receipt = {
      ...receipt,
      statutory: [],
      tenders: [{ method: 'ROOM_CHARGE', amount: '173.64' }],
      totals: { ...receipt.totals, tendered: '173.64', change: '0.00' },
      roomCharge: { roomNumber: '204', guestSurname: 'Cruz', amount: '173.64', line: 'Charged to room 204 - Cruz', signatureLine: 'Guest signature' },
    };
    const text = toText(receiptToPrintable(roomed), 48);
    const lines = text.split('\n');
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(text).toContain('CHARGE TO ROOM');
    expect(at('Charged to room 204 - Cruz')).toBeGreaterThan(at('Change'));
    expect(at('Guest signature')).toBeGreaterThan(at('Charged to room 204'));
    expect(tenderLabel({ method: 'ROOM_CHARGE' })).toBe('CHARGE TO ROOM');
  });

  it('prints the folio statement with its title, lines, balance and the signature line', () => {
    const st: FolioStatement = {
      title: 'Guest folio - not an invoice',
      seller: { registeredName: 'Bahay Kubo Inn Corp', tradeName: 'Bahay Kubo Inn', tin: '123-456-789', registeredAddress: null },
      branch: { name: 'Baguio' },
      folio: { id: 'f', status: 'SETTLED', openedAt: '2026-10-21T00:00:00Z', settledAt: '2026-10-22T00:00:00Z', currency: 'PHP' },
      stay: { id: 's', roomNumber: '101', roomType: 'Standard', arrivalDate: '2026-10-21', departureDate: '2026-10-22', guestName: 'Juan Cruz' },
      lines: [
        { id: '1', date: '2026-10-21', kind: 'ROOM_NIGHT', description: 'Room night', amount: '2000.00', vatAmount: '214.29' },
        { id: '2', date: '2026-10-21', kind: 'PAYMENT', description: 'Payment (cash)', amount: '-2000.00', vatAmount: null },
      ],
      totals: { roomNights: '2000.00', accommodationTax: '0.00', charges: '0.00', adjustments: '0.00', deposits: '0.00', payments: '-2000.00', balance: '0.00' },
      signatureLine: 'Guest signature',
    } as unknown as FolioStatement;
    const text = toText(statementToPrintable(st), 48);
    expect(text).toContain('Guest folio - not an invoice');
    expect(text).toContain('Room 101');
    expect(text).toContain('Payment (cash)');
    expect(text).toContain('BALANCE');
    expect(text).not.toContain('Accommodation tax');
    expect(text).toContain('Guest signature');
  });
});

describe('laundry claim stub and bag tag (ADR-0024 §4)', () => {
  const ticket: JobTicket = {
    stub: {
      business: 'Labada Express', legalName: 'Labada Express Inc', branch: 'Cubao', branchAddress: null, timezone: 'Asia/Manila',
      reference: 'J-000007', claimCode: 'KQ7M2P', receivedAt: '2026-10-21T01:00:00Z', promisedAt: '2026-10-21T07:00:00Z', serviceLevel: 'EXPRESS',
      customer: 'Maria Santos', weightKg: '2.4', bagCount: 1,
      lines: [
        { name: 'Wash-dry-fold (per kilo)', measuredQuantity: '2.4', quantity: '3', unit: 'KG', unitPrice: '35.00', amountDue: '105.00', packageSession: false },
        { name: 'Express service', measuredQuantity: '1', quantity: '1', unit: null, unitPrice: '50.00', amountDue: '50.00', packageSession: false },
      ],
      amountDue: '155.00', depositHeld: '100.00', balance: '55.00',
      items: [{ label: 'Shirts', count: 6, note: null }], pieces: 6,
      specialInstructions: 'Separate whites', conditionNotes: 'Stain on one shirt', claimPolicy: 'Unclaimed after 30 days may be donated.', notice: 'Claim stub — not an official receipt',
    },
    tag: { reference: 'J-000007', customer: 'Maria Santos', bagCount: 1, serviceLevel: 'EXPRESS', promisedAt: '2026-10-21T07:00:00Z', specialInstructions: 'Separate whites', pieces: 6 },
  };

  it('prints the claim code, the minimum billed, the down payment and the balance, items, condition and policy', () => {
    const text = toText(stubToPrintable(ticket), 48);
    expect(text).toContain('CLAIM CODE KQ7M2P');
    expect(text).toContain('2.4 kg (min 3) x 35.00');
    expect(text).toContain('Down payment');
    expect(text).toMatch(/BALANCE AT PICKUP\s+PHP 55\.00/);
    expect(text).toContain('6 x Shirts');
    expect(text).toContain('Stain on one shirt');
    expect(text).toContain('Unclaimed after 30 days may be donated.');
    expect(text).toContain('Oct 21, 2026');
  });

  it('the bag tag has no prices', () => {
    const text = toText(tagToPrintable(ticket), 32);
    expect(text).toContain('J-000007');
    expect(text).toContain('EXPRESS');
    expect(text).toContain('Separate whites');
    expect(text).not.toContain('PHP');
  });

  it('reads quantities by unit and names the down-payment tender', () => {
    expect(jobQuantity({ measuredQuantity: '2', quantity: '2', unit: 'LOAD' })).toBe('2 loads');
    expect(jobQuantity({ measuredQuantity: '4', quantity: '4', unit: 'PIECE' })).toBe('4 pc');
    expect(tenderLabel({ method: 'JOB_DEPOSIT' })).toBe('DOWN PAYMENT');
  });
});

describe('medicines on the receipt (ADR-0025)', () => {
  const pharmacy: Receipt = {
    ...receipt,
    lines: [
      { name: 'Biogesic', quantity: '2', unitPrice: '5.50', amount: '8.80', flag: 'E', generic: 'Paracetamol 500 mg tablet', lots: ['Lot NEW-1 · Exp 03/2027', 'Lot NEW-2 · Exp 05/2027'] },
      { name: 'Cotton balls', quantity: '1', unitPrice: '20.00', amount: '20.00', flag: 'V' },
    ],
    charges: [],
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

describe('kitchen slips (session 25; VOID slips, audit 2026-10-21)', () => {
  const ticket: KitchenTicketPrint = {
    id: 't1', kind: 'TICKET', ticketNumber: 31, reprint: false, course: 1, courseNote: 'Mains together', firedAt: '2026-10-21T04:00:00Z',
    station: { id: 's1', code: 'GRILL', name: 'Grill' },
    order: { orderNumber: 12, orderType: 'DINE_IN', tableCode: 'T4', customerName: null },
    items: [{ name: 'Burger', quantity: '2', seat: 1, note: null, choices: ['Well done'] }],
  };

  it('a ticket prints its station, its items with their choices and where the food goes', () => {
    const text = toText(kitchenSlipToPrintable(serverTicketSlip(ticket, '12:00')), 32);
    expect(text).toContain('KITCHEN TICKET');
    expect(text).not.toContain('VOID');
    expect(text).toContain('Note: Mains together');
  });

  it('a VOID slip opens with a big VOID, says not to make it, and names the ticket, the table and the voided items', () => {
    const slip = kitchenSlipToPrintable(serverTicketSlip({ ...ticket, kind: 'VOID', items: [{ name: 'No onions (Burger)', quantity: '1', seat: null, note: null, choices: [] }] }, '12:20'));
    expect(slip.banner).toBe('*** VOID ***');
    expect(toText(slip, 32).split('\n')).toEqual([
      '          *** VOID ***',
      '             GRILL',
      '       VOID - DO NOT MAKE',
      '--------------------------------',
      'Ticket 31                  12:20',
      '--------------------------------',
      '1 x No onions (Burger)',
      '--------------------------------',
      'Table T4 - #12',
    ]);
    // On the printer the banner is bold and double height.
    const bytes = Array.from(encodeEscPos(slip, { width: 32 }));
    expect(bytes.join(',')).toContain([0x1d, 0x21, 0x01].join(','));
    // A counter sale's slip names the call number and the pickup name.
    expect(toText(kitchenSlipToPrintable(serverTicketSlip({ ...ticket, kind: 'VOID', order: { orderNumber: 7, orderType: 'COUNTER', tableCode: null, customerName: 'Di' } }, '12:20')), 32)).toContain('#7 Di');
  });
});
