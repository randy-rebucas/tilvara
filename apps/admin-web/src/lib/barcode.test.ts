import { describe, expect, it } from 'vitest';
import { barcodeFor, CODE128_PATTERNS, code128BValues, code128Checksum, ean13CheckDigit, encodeCode128B, encodeEan13, isEan13Guard, isValidEan13 } from './barcode';

/** Read 7-module digits back with the published tables (independent of the encoder's derived ones). */
const L: Record<string, number> = { '0001101': 0, '0011001': 1, '0010011': 2, '0111101': 3, '0100011': 4, '0110001': 5, '0101111': 6, '0111011': 7, '0110111': 8, '0001011': 9 };
const G: Record<string, number> = { '0100111': 0, '0110011': 1, '0011011': 2, '0100001': 3, '0011101': 4, '0111001': 5, '0000101': 6, '0010001': 7, '0001001': 8, '0010111': 9 };
const R: Record<string, number> = { '1110010': 0, '1100110': 1, '1101100': 2, '1000010': 3, '1011100': 4, '1001110': 5, '1010000': 6, '1000100': 7, '1001000': 8, '1110100': 9 };
const FIRST: Record<string, number> = { LLLLLL: 0, LLGLGG: 1, LLGGLG: 2, LLGGGL: 3, LGLLGG: 4, LGGLLG: 5, LGGGLL: 6, LGLGLG: 7, LGLGGL: 8, LGGLGL: 9 };

function decodeEan13(m: string): string {
  expect(m.slice(0, 3)).toBe('101');
  expect(m.slice(45, 50)).toBe('01010');
  expect(m.slice(92)).toBe('101');
  let parity = '';
  let left = '';
  for (let i = 0; i < 6; i++) {
    const chunk = m.slice(3 + i * 7, 10 + i * 7);
    if (chunk in L) { parity += 'L'; left += L[chunk]; } else { parity += 'G'; left += G[chunk]; }
  }
  let right = '';
  for (let i = 0; i < 6; i++) right += R[m.slice(50 + i * 7, 57 + i * 7)];
  return `${FIRST[parity]}${left}${right}`;
}

describe('EAN-13', () => {
  it('computes the check digit (weights 1 and 3)', () => {
    expect(ean13CheckDigit('480001664429')).toBe(0);
    expect(isValidEan13('4800016644290')).toBe(true);
    expect(isValidEan13('4800016644291')).toBe(false);
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(isValidEan13('290000000001')).toBe(false); // 12 digits
  });

  it('draws 95 modules that read back to the same digits', () => {
    for (const code of ['4800016644290', '4006381333931', '2900000123457'.slice(0, 12) + ean13CheckDigit('290000012345'), '0000000000000']) {
      const m = encodeEan13(code);
      expect(m).toHaveLength(95);
      expect(m).toMatch(/^[01]+$/);
      expect(decodeEan13(m)).toBe(code);
    }
  });

  it('uses the first digit for the parity of the left half (4 → LGLLGG)', () => {
    const m = encodeEan13('4800016644290');
    expect(m.slice(3, 10)).toBe('0110111'); // 8, L
    expect(m.slice(10, 17)).toBe('0100111'); // 0, G
    expect(m.slice(17, 24)).toBe('0001101'); // 0, L
    expect(m.slice(85, 92)).toBe('1110010'); // last digit 0, R
  });

  it('marks the guard bars', () => {
    expect([0, 1, 2, 45, 49, 92, 94].every(isEan13Guard)).toBe(true);
    expect([3, 44, 50, 91].some(isEan13Guard)).toBe(false);
  });

  it('refuses a code with a wrong check digit', () => {
    expect(() => encodeEan13('4800016644291')).toThrow();
  });
});

describe('Code 128 B', () => {
  it('has 107 distinct symbols of 11 modules (the stop has 13)', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((p, i) => expect([...p].reduce((a, w) => a + Number(w), 0), String(i)).toBe(i === 106 ? 13 : 11));
  });

  it('checksums "PJJ123C" as 104 + Σ value × position, mod 103', () => {
    const values = code128BValues('PJJ123C');
    expect(values).toEqual([48, 42, 42, 17, 18, 19, 35]);
    const sum = 104 + 48 * 1 + 42 * 2 + 42 * 3 + 17 * 4 + 18 * 5 + 19 * 6 + 35 * 7;
    expect(sum).toBe(879);
    expect(code128Checksum(values)).toBe(879 % 103);
    expect(code128Checksum(values)).toBe(55);
  });

  it('starts with Start B, ends with the check symbol and the stop', () => {
    const m = encodeCode128B('PJJ123C');
    expect(m).toHaveLength(11 * (7 + 2) + 13);
    expect(m.slice(0, 11)).toBe('11010010000'); // Start B 211214
    expect(m.slice(-13)).toBe('1100011101011'); // stop 2331112
    // The check symbol (55 = 311321) sits just before the stop.
    expect(m.slice(-24, -13)).toBe('11101000110');
  });

  it('refuses characters outside printable ASCII', () => {
    expect(() => encodeCode128B('ñ')).toThrow();
    expect(() => encodeCode128B('')).toThrow();
  });
});

describe('barcodeFor', () => {
  it('prints a valid EAN-13 as EAN-13 and anything else (an SKU) as Code 128', () => {
    expect(barcodeFor('4800016644290').kind).toBe('EAN13');
    expect(barcodeFor('4800016644291').kind).toBe('CODE128');
    expect(barcodeFor('TSHIRT-M-BLACK')).toMatchObject({ kind: 'CODE128', text: 'TSHIRT-M-BLACK' });
  });
});
