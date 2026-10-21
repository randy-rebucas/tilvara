/**
 * Our own barcode encoders for printed labels (ADR-0021 §4): EAN-13 for a valid 13-digit code (shop
 * barcodes and the in-store `29…` codes), Code 128 subset B for anything else (an SKU). Output is a
 * string of modules, '1' for a bar and '0' for a space, which the label draws as SVG rectangles.
 */

/** EAN-13 left-hand digits, odd parity (L); R is the complement of L and G the reverse of R. */
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
const G = R.map((p) => [...p].reverse().join(''));
/** The first digit is not drawn: it sets which of the six left digits use L or G. */
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Check digit for the first 12 digits of an EAN-13 (weights 1 and 3 from the left). */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error('EAN-13 needs 12 digits before the check digit');
  const sum = [...first12].reduce((a, d, i) => a + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** 95 modules: start guard, six left digits, centre guard, six right digits, end guard. */
export function encodeEan13(code: string): string {
  if (!isValidEan13(code)) throw new Error(`not a valid EAN-13: ${code}`);
  const d = [...code].map(Number);
  const parity = PARITY[d[0]!]!;
  const left = d.slice(1, 7).map((n, i) => (parity[i] === 'L' ? L[n]! : G[n]!)).join('');
  const right = d.slice(7).map((n) => R[n]!).join('');
  return `101${left}01010${right}101`;
}

/** Module positions of the EAN-13 guard bars, drawn a little longer than the digits' bars. */
export function isEan13Guard(index: number): boolean {
  return index < 3 || (index >= 45 && index < 50) || index >= 92;
}

/**
 * Code 128 symbol widths (bar, space, bar, space, bar, space) for values 0–105, then the stop
 * pattern (106, seven elements: it ends with a two-module bar).
 */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
export const CODE128_START_B = 104;
export const CODE128_STOP = 106;

/** Code 128 B values: printable ASCII (space to ~) less 32. */
export function code128BValues(text: string): number[] {
  return [...text].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`Code 128 B cannot carry ${JSON.stringify(ch)}`);
    return c - 32;
  });
}

/** Mod-103 check: the start value plus each symbol's value times its position (from 1). */
export function code128Checksum(values: number[], start = CODE128_START_B): number {
  return values.reduce((a, v, i) => a + v * (i + 1), start) % 103;
}

function widthsToModules(widths: string): string {
  return [...widths].map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(Number(w))).join('');
}

/** Start B, the data, the check symbol and the stop pattern: 11 modules per symbol, 13 for the stop. */
export function encodeCode128B(text: string): string {
  if (!text) throw new Error('Code 128 needs at least one character');
  const values = code128BValues(text);
  const symbols = [CODE128_START_B, ...values, code128Checksum(values), CODE128_STOP];
  return symbols.map((s) => widthsToModules(CODE128_PATTERNS[s]!)).join('');
}

export type BarcodeKind = 'EAN13' | 'CODE128';

/** What a label prints for a code: EAN-13 when it is one, else Code 128 (characters it cannot carry become '?'). */
export function barcodeFor(code: string): { kind: BarcodeKind; modules: string; text: string } {
  const text = code.trim();
  if (isValidEan13(text)) return { kind: 'EAN13', modules: encodeEan13(text), text };
  const safe = text.replace(/[^\x20-\x7e]/g, '?') || '?';
  return { kind: 'CODE128', modules: encodeCode128B(safe), text: safe };
}
