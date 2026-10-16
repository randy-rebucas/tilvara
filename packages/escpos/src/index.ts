/**
 * Receipts for thermal printers (ADR-0015 slice 3): a neutral receipt model, laid out in fixed-width
 * columns and encoded as ESC/POS bytes. Pure: no I/O, no DOM. The till converts its online (server) and
 * offline receipts into `PrintableReceipt`; a device adapter sends the bytes (Tauri shell, slice 5).
 */

export interface PrintableReceipt {
  /** Seller name, registered name, address, TIN — centred. */
  header: string[];
  /** Compliance notice, printed exactly as given (e.g. "THIS IS NOT AN OFFICIAL INVOICE") — centred, bold. */
  notice: string;
  /** Left/right pairs under the header: reference and time, register, cashier. */
  meta: [string, string][];
  /** Item lines: name left, amount right (with its tax flag); `detail` (e.g. "2 x 22.40") below in small. */
  items: { name: string; amount: string; detail?: string }[];
  /** Totals in print order; `emphasis` prints double height (TOTAL DUE). */
  totals: { label: string; amount: string; emphasis?: boolean }[];
  /** Tenders, tendered and change. */
  payments: { label: string; amount: string }[];
  /** Blocks after the payments, each under a rule: e.g. an SC/PWD beneficiary with a signature line. */
  blocks?: { lines: string[]; pairs?: [string, string][]; signature?: string }[];
  /** Centred lines at the end (flag legend, thanks). */
  footer: string[];
}

/** 80 mm paper prints 48 columns in font A; 58 mm prints 32. */
export type PaperWidth = 32 | 42 | 48;

export type Line =
  | { kind: 'text'; text: string; align: 'left' | 'center'; bold?: boolean; double?: boolean }
  | { kind: 'rule' }
  | { kind: 'feed' };

/** Characters a receipt printer's code page (CP437) lacks, spelled the way a cashier would. */
const SPELL: Record<string, string> = {
  '₱': 'PHP ', '—': '-', '–': '-', '−': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '×': 'x', '·': '-', ' ': ' ',
};
/** CP437 positions for the letters Filipino and Spanish names use. */
const CP437: Record<string, number> = {
  'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85, 'ç': 0x87, 'ê': 0x88, 'ë': 0x89, 'è': 0x8a, 'ï': 0x8b, 'î': 0x8c,
  'ì': 0x8d, 'Ä': 0x8e, 'É': 0x90, 'ô': 0x93, 'ö': 0x94, 'ò': 0x95, 'û': 0x96, 'ù': 0x97, 'Ö': 0x99, 'Ü': 0x9a, 'á': 0xa0, 'í': 0xa1,
  'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, '°': 0xf8,
};

/** One printable column per character: spell what the code page lacks, unknowns become '?'. */
export function printable(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    if (SPELL[ch] !== undefined) out += SPELL[ch];
    else if ((ch >= ' ' && ch <= '~') || CP437[ch] !== undefined) out += ch;
    else if (ch === '\t') out += ' ';
    else out += '?';
  }
  return out;
}

/** Words wrapped to `width` columns; a word longer than the line is cut. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > width) {
      if (line) { out.push(line); line = ''; }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else { out.push(line); line = w; }
  }
  if (line || !out.length) out.push(line);
  return out;
}

/**
 * Left text and right text on one line. A long left side wraps at full width and the right side ends
 * its last line, or takes a line of its own when it does not fit there.
 */
function pair(left: string, right: string, width: number): string[] {
  const lines = wrap(left, width);
  const last = lines.pop()!;
  if (last.length + 1 + right.length <= width) return [...lines, `${last}${' '.repeat(width - last.length - right.length)}${right}`];
  return [...lines, last, right.slice(-width).padStart(width)];
}

/** The receipt as print lines at a paper width; every text line fits the width. */
export function layout(r: PrintableReceipt, width: PaperWidth): Line[] {
  const text = (t: string, align: 'left' | 'center' = 'left', style: { bold?: boolean; double?: boolean } = {}): Line[] =>
    wrap(printable(t), width).map((x) => ({ kind: 'text', text: x, align, ...style }));
  const pairs = (l: string, rgt: string, style: { bold?: boolean; double?: boolean } = {}): Line[] =>
    pair(printable(l), printable(rgt), width).map((x) => ({ kind: 'text', text: x, align: 'left', ...style }));
  const out: Line[] = [];
  for (const h of r.header) out.push(...text(h, 'center'));
  out.push(...text(r.notice, 'center', { bold: true }), { kind: 'rule' });
  for (const [l, rgt] of r.meta) out.push(...pairs(l, rgt));
  out.push({ kind: 'rule' });
  for (const i of r.items) {
    out.push(...pairs(i.name, i.amount));
    if (i.detail) out.push(...wrap(printable(i.detail), width - 2).map((x): Line => ({ kind: 'text', text: `  ${x}`, align: 'left' })));
  }
  out.push({ kind: 'rule' });
  for (const t of r.totals) out.push(...pairs(t.label, t.amount, t.emphasis ? { bold: true, double: true } : {}));
  if (r.payments.length) out.push({ kind: 'rule' });
  for (const p of r.payments) out.push(...pairs(p.label, p.amount));
  for (const b of r.blocks ?? []) {
    out.push({ kind: 'rule' });
    for (const l of b.lines) out.push(...text(l));
    for (const [l, rgt] of b.pairs ?? []) out.push(...pairs(l, rgt));
    if (b.signature) out.push({ kind: 'feed' }, { kind: 'feed' }, { kind: 'text', text: '_'.repeat(width), align: 'left' }, ...text(b.signature, 'center'));
  }
  if (r.footer.length) out.push({ kind: 'feed' });
  for (const f of r.footer) out.push(...text(f, 'center'));
  return out;
}

/** Plain-text preview (tests, logs, a screen fallback). */
export function toText(r: PrintableReceipt, width: PaperWidth): string {
  return layout(r, width)
    .map((l) => {
      if (l.kind === 'rule') return '-'.repeat(width);
      if (l.kind === 'feed') return '';
      if (l.align === 'center') {
        const pad = Math.floor((width - l.text.length) / 2);
        return `${' '.repeat(pad)}${l.text}`.trimEnd();
      }
      return l.text.trimEnd();
    })
    .join('\n');
}

const ESC = 0x1b;
const GS = 0x1d;

export interface EncodeOptions {
  width?: PaperWidth;
  /** Feed and cut after the receipt (GS V B 3). Default true. */
  cut?: boolean;
  /** Kick the cash drawer on pin 2 before printing (ESC p 0). Default false. */
  openDrawer?: boolean;
}

/**
 * ESC/POS bytes for a receipt: initialize, CP437, then each line with its alignment and style.
 * Double-height lines keep normal width, so columns never overflow.
 */
export function encodeEscPos(r: PrintableReceipt, o: EncodeOptions = {}): Uint8Array {
  const width = o.width ?? 48;
  const bytes: number[] = [ESC, 0x40, ESC, 0x74, 0x00]; // ESC @ initialize · ESC t 0 = CP437
  if (o.openDrawer) bytes.push(ESC, 0x70, 0x00, 0x19, 0xfa); // pulse pin 2: 50 ms on, 500 ms off
  const put = (s: string) => {
    for (const ch of s) bytes.push(CP437[ch] ?? (ch.charCodeAt(0) <= 0x7e ? ch.charCodeAt(0) : 0x3f));
  };
  let align = 0;
  for (const l of layout(r, width)) {
    if (l.kind === 'feed') {
      bytes.push(0x0a);
      continue;
    }
    if (l.kind === 'rule') {
      if (align !== 0) { bytes.push(ESC, 0x61, 0x00); align = 0; }
      put('-'.repeat(width));
      bytes.push(0x0a);
      continue;
    }
    const want = l.align === 'center' ? 1 : 0;
    if (want !== align) { bytes.push(ESC, 0x61, want); align = want; } // ESC a n
    if (l.bold) bytes.push(ESC, 0x45, 0x01); // ESC E 1
    if (l.double) bytes.push(GS, 0x21, 0x01); // GS ! 0x01 = double height only
    put(l.text);
    bytes.push(0x0a);
    if (l.double) bytes.push(GS, 0x21, 0x00);
    if (l.bold) bytes.push(ESC, 0x45, 0x00);
  }
  if (o.cut ?? true) bytes.push(GS, 0x56, 0x42, 0x03); // feed 3 lines, partial cut
  return Uint8Array.from(bytes);
}
