import { describe, expect, it } from 'vitest';
import { encodeEscPos, layout, printable, toText, type PrintableReceipt } from '../src/index.js';

const receipt: PrintableReceipt = {
  header: ['Tindahan ni Aling Nena', 'Nena Reyes Trading', 'VAT REG TIN 123-456-789-00000'],
  notice: 'THIS IS NOT AN OFFICIAL INVOICE',
  meta: [['R1-000042', '10/17/2026, 10:15:00'], ['Cashier', 'Maria Santos — Front']],
  items: [
    { name: 'Cola', amount: '44.80 V', detail: '2 x 22.40' },
    { name: 'Pancit Canton Calamansi Extra Hot Family Pack', amount: '1,250.00 V', detail: '10 x 125.00' },
  ],
  totals: [
    { label: 'Gross', amount: '₱1,294.80' },
    { label: 'VAT 12%', amount: '₱138.73' },
    { label: 'TOTAL DUE', amount: '₱1,294.80', emphasis: true },
  ],
  payments: [{ label: 'CASH', amount: '₱1,294.80' }, { label: 'Tendered', amount: '₱1,300.00' }, { label: 'Change', amount: '₱5.20' }],
  footer: ['V = VATable, E = VAT-exempt, Z = zero-rated', 'Salamat po, Señora!'],
};

describe('layout', () => {
  it('fits 58 mm paper: every line within 32 columns, amounts right-aligned, long names wrapped', () => {
    const text = toText(receipt, 32);
    expect(text).toBe([
      '     Tindahan ni Aling Nena',
      '       Nena Reyes Trading',
      ' VAT REG TIN 123-456-789-00000',
      'THIS IS NOT AN OFFICIAL INVOICE',
      '--------------------------------',
      'R1-000042   10/17/2026, 10:15:00',
      'Cashier     Maria Santos - Front',
      '--------------------------------',
      'Cola                     44.80 V',
      '  2 x 22.40',
      'Pancit Canton Calamansi Extra',
      'Hot Family Pack       1,250.00 V',
      '  10 x 125.00',
      '--------------------------------',
      'Gross               PHP 1,294.80',
      'VAT 12%               PHP 138.73',
      'TOTAL DUE           PHP 1,294.80',
      '--------------------------------',
      'CASH                PHP 1,294.80',
      'Tendered            PHP 1,300.00',
      'Change                  PHP 5.20',
      '',
      'V = VATable, E = VAT-exempt, Z =',
      '           zero-rated',
      '      Salamat po, Señora!',
    ].join('\n'));
    for (const l of layout(receipt, 32)) if (l.kind === 'text') expect(l.text.length).toBeLessThanOrEqual(32);
    for (const l of layout(receipt, 48)) if (l.kind === 'text') expect(l.text.length).toBeLessThanOrEqual(48);
  });

  it('prints an SC/PWD block with room to sign under a full-width line', () => {
    const text = toText({ ...receipt, blocks: [{ lines: ['Senior citizen: Lola Cruz', 'ID OSCA-123'], pairs: [['Discount', '-₱26.79']], signature: 'Signature of the beneficiary' }] }, 32);
    expect(text).toContain(['--------------------------------', 'Senior citizen: Lola Cruz', 'ID OSCA-123', 'Discount              -PHP 26.79', '', '', '_'.repeat(32), '  Signature of the beneficiary'].join('\n'));
  });

  it('prints a banner first, centred, bold and double height', () => {
    const lines = layout({ ...receipt, banner: '*** VOID ***' }, 32);
    expect(lines[0]).toEqual({ kind: 'text', text: '*** VOID ***', align: 'center', bold: true, double: true });
    expect(layout(receipt, 32)[0]).toMatchObject({ text: 'Tindahan ni Aling Nena' });
  });

  it('spells what a printer code page lacks and never prints an unknown character as garbage', () => {
    expect(printable('₱5.20 — “ok” × 2 · Peña')).toBe(`PHP 5.20 - "ok" x 2 - Peña`);
    expect(printable('日本')).toBe('??');
    expect(printable('é'.normalize('NFD'))).toBe('é');
  });
});

describe('ESC/POS bytes', () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  it('initializes, selects CP437, styles the notice and the total, encodes ñ, and cuts', () => {
    const b = encodeEscPos(receipt, { width: 32 });
    expect(hex(b.slice(0, 5))).toBe('1b401b7400'); // ESC @ · ESC t 0
    expect(hex(b)).toContain('1b6101'); // centre for the header
    expect(hex(b)).toContain(`1b4501${Buffer.from('THIS IS NOT AN OFFICIAL INVOICE').toString('hex')}0a1b4500`); // bold notice
    expect(hex(b)).toContain(`1d2101${Buffer.from('TOTAL DUE').toString('hex')}`); // double-height total
    expect([...b]).toContain(0xa4); // ñ in CP437
    expect(hex(b.slice(-4))).toBe('1d564203'); // feed and partial cut
    expect(hex(b)).not.toContain('1b7000'); // no drawer kick unless asked
    expect([...b].every((x) => x <= 0xff)).toBe(true);
  });

  it('kicks the drawer before printing when asked, and can leave the paper uncut', () => {
    const b = encodeEscPos(receipt, { width: 48, openDrawer: true, cut: false });
    expect(hex(b.slice(0, 10))).toBe('1b401b74001b700019fa');
    expect(hex(b.slice(-4))).not.toBe('1d564203');
  });
});
