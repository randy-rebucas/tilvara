import { dictionaries, type MessageKey } from '../i18n/messages';
import type { Product } from './api';

/**
 * Products as a CSV file and back (the import reads what the export writes). One row per variant.
 * Headers and words (Yes, Weight, Service) are written in the viewer's language and read in either
 * language. Money stays the API's exact decimal strings, never a float.
 */
export type ColumnKey =
  | 'name' | 'variantName' | 'sku' | 'barcodes' | 'category' | 'unit' | 'tax' | 'soldBy' | 'productType'
  | 'trackInventory' | 'tracksExpiry' | 'price' | 'referenceCost' | 'attributes' | 'status';

export const COLUMNS: readonly { key: ColumnKey; label: MessageKey }[] = [
  { key: 'name', label: 'prod.name' },
  { key: 'variantName', label: 'prod.variantName' },
  { key: 'sku', label: 'prod.sku' },
  { key: 'barcodes', label: 'pio.col.barcodes' },
  { key: 'category', label: 'prod.category' },
  { key: 'unit', label: 'prod.unit' },
  { key: 'tax', label: 'prod.tax' },
  { key: 'soldBy', label: 'prod.soldBy' },
  { key: 'productType', label: 'pio.col.type' },
  { key: 'trackInventory', label: 'pio.col.trackStock' },
  { key: 'tracksExpiry', label: 'pio.col.expiry' },
  { key: 'price', label: 'prod.price' },
  { key: 'referenceCost', label: 'prod.refCost' },
  { key: 'attributes', label: 'pio.col.attributes' },
  { key: 'status', label: 'common.status' },
];

/** As `PRODUCT_IMPORT_MAX_ROWS` in @1pos/validation (the API refuses more). */
export const IMPORT_MAX_ROWS = 2000;

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;
type Cell = string | number | null | undefined;

/** "22.0000" → "22.00", "1.2340" → "1.234": exact, by the string. */
export function trimAmount(amount: string): string {
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.(\d?)$/, (_m, d: string) => `.${d.padEnd(2, '0')}`) : amount;
}

/** "Size: M; Colour: Black" */
export const formatAttributes = (a: Record<string, string> | null | undefined) =>
  Object.entries(a ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ');

export interface ExportContext {
  categoryPath: Map<string, string>;
  unitCode: Map<string, string>;
  taxCode: Map<string, string>;
  /** Default price list, in force now, by variant id. */
  price: Map<string, string>;
}

type ExportVariant = Product['variants'][number] & { referenceCost?: string | null };
export type ExportProduct = Omit<Product, 'variants'> & { taxCategoryId?: string; variants: ExportVariant[] };

/** Header + one row per variant (an active product's archived variants are left out). */
export function productExportRows(products: readonly ExportProduct[], ctx: ExportContext, t: T): Cell[][] {
  const yesNo = (b: boolean | undefined) => (b ? t('pio.yes') : t('pio.no'));
  return [
    COLUMNS.map((c) => t(c.label)),
    ...products.flatMap((p) =>
      p.variants
        .filter((v) => p.archivedAt || !v.archivedAt)
        .map((v) => {
          const values: Record<ColumnKey, Cell> = {
            name: p.name,
            variantName: v.name ?? '',
            sku: v.sku,
            barcodes: v.barcodes.join(' '),
            category: p.categoryId ? (ctx.categoryPath.get(p.categoryId) ?? '') : '',
            unit: p.uomId ? (ctx.unitCode.get(p.uomId) ?? '') : '',
            tax: p.taxCategoryId ? (ctx.taxCode.get(p.taxCategoryId) ?? '') : '',
            soldBy: p.soldBy === 'WEIGHT' ? t('prod.byWeight') : t('prod.byUnit'),
            productType: p.productType === 'SERVICE' ? t('prod.kind.SERVICE') : t('pio.goods'),
            trackInventory: yesNo(p.trackInventory),
            tracksExpiry: yesNo(p.tracksExpiry),
            price: ctx.price.has(v.id) ? trimAmount(ctx.price.get(v.id)!) : '',
            referenceCost: v.referenceCost ? trimAmount(v.referenceCost) : '',
            attributes: formatAttributes(v.attributes),
            status: p.archivedAt || v.archivedAt ? t('prod.archived') : t('common.active'),
          };
          return COLUMNS.map((c) => values[c.key]);
        }),
    ),
  ];
}

/**
 * A file's text: UTF-8 (with or without BOM) when it is valid UTF-8, else Windows-1252, which is what
 * Excel on Windows writes for "CSV (Comma delimited)" (ñ in Piña would otherwise come back as �).
 */
export function decodeCsvFile(bytes: ArrayBuffer | Uint8Array): { text: string; encoding: 'utf-8' | 'windows-1252' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // By hand: some runtimes (Node) decode "windows-1252" as Latin-1, which gets 0x80–0x9F (€, ‘ ’, “ ”) wrong.
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let text = '';
    for (const x of b) text += x >= 0x80 && x <= 0x9f ? (CP1252_HIGH[x - 0x80] ?? '') : String.fromCharCode(x);
    return { text, encoding: 'windows-1252' };
  }
}

/** Windows-1252 bytes 0x80–0x9F (the five it leaves undefined decode as nothing). */
const CP1252_HIGH = '€\u0000‚ƒ„…†‡ˆ‰Š‹Œ\u0000Ž\u0000\u0000‘’“”•–—˜™š›œ\u0000žŸ'.split('').map((c) => (c === '\u0000' ? '' : c));

/** Bytes the API takes in one import request (bootstrap.ts: 2 MB for the import routes only). */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * RFC 4180 CSV: quoted fields with "" and line breaks, CRLF or LF, a leading BOM. A file saved with
 * semicolons (a spreadsheet set to a comma-decimal language) is read too.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvLines(text).map((r) => r.cells);
}

/** As parseCsv, with the file line each row starts on (1-based; blank lines and line breaks in quotes counted). */
export function parseCsvLines(text: string): { cells: string[]; line: number }[] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else {
        if (c === '\n' || (c === '\r' && src[i + 1] !== '\n')) line++;
        field += c;
      }
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push({ cells: row, line: start });
      row = [];
      field = '';
      start = ++line;
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push({ cells: row, line: start });
  }
  return rows.filter((r) => r.cells.some((f) => f.trim() !== ''));
}

/** A row for `POST /v1/products/import` (see productImportRowSchema in @1pos/validation). */
export interface ImportRow {
  line: number;
  name: string;
  sku: string;
  variantName?: string;
  barcodes: string[];
  category?: string;
  unit?: string;
  tax?: string;
  productType?: 'STANDARD' | 'SERVICE';
  soldBy?: 'UNIT' | 'WEIGHT';
  trackInventory?: boolean;
  tracksExpiry?: boolean;
  price?: string;
  referenceCost?: string;
  attributes?: Record<string, string>;
}

export interface ImportProblem {
  line: number;
  /** As written in the file (it may be the problem). */
  sku: string;
  key: MessageKey;
  /** The column the message names (its header in the viewer's language goes in `{col}`). */
  col?: ColumnKey;
  vars?: Record<string, string | number>;
}

/** A column's header, for a message's `{col}`. */
export const columnLabel = (key: ColumnKey): MessageKey => COLUMNS.find((c) => c.key === key)!.label;

export interface ReadImport {
  rows: ImportRow[];
  problems: ImportProblem[];
  /** Required columns the header lacks. */
  missing: ColumnKey[];
  /** Header cells that name no column (ignored). */
  unknown: string[];
  /** Rows marked Archived (as an export of archived items writes them): skipped. */
  archived: number;
}

const norm = (s: string) => s.trim().toLocaleLowerCase('en').replace(/\s*\((optional|opsyonal)\)\s*$/, '').replace(/\s+/g, ' ');
const both = (key: MessageKey) => [dictionaries.en[key], dictionaries.fil[key]].map(norm);
const words = (keys: MessageKey[], extra: string[]) => new Set([...keys.flatMap(both), ...extra.map(norm)]);

const YES = words(['pio.yes'], ['yes', 'y', 'true', '1', 'oo']);
const NO = words(['pio.no'], ['no', 'n', 'false', '0', 'hindi']);
const WEIGHT = words(['prod.byWeight'], ['weight', 'weighed', 'kg']);
const UNIT = words(['prod.byUnit'], ['unit', 'piece', 'pc']);
const SERVICE = words(['prod.kind.SERVICE'], ['service']);
const GOODS = words(['pio.goods'], ['goods', 'standard', 'item', 'product']);
const ARCHIVED = words(['prod.archived'], ['archived']);

/** Which column each header cell names: its label in English or Filipino, or the column's own key. */
export function headerColumns(header: readonly string[]): { columns: (ColumnKey | null)[]; unknown: string[] } {
  const byName = new Map<string, ColumnKey>();
  for (const c of COLUMNS) {
    for (const n of [...both(c.label), norm(c.key)]) byName.set(n, c.key);
  }
  // "Price" without the peso sign, "Barcode" in the singular.
  byName.set('price', 'price');
  byName.set('presyo', 'price');
  byName.set('barcode', 'barcodes');
  const columns = header.map((h) => byName.get(norm(h)) ?? byName.get(norm(h.replace(/\(₱\)/, ''))) ?? null);
  return { columns, unknown: header.filter((h, i) => h.trim() && !columns[i]) };
}

const AMOUNT = /^\d{1,16}(\.\d{1,4})?$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const BARCODE = /^[A-Za-z0-9-]{1,64}$/;

/** "₱1,234.50" → "1234.50"; null when it is not an amount. */
export function readAmount(s: string): string | null {
  let v = s.trim().replace(/^₱\s*/, '').replace(/^PHP\s*/i, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) v = v.replace(/,/g, '');
  return AMOUNT.test(v) ? v : null;
}

/** "Size: M; Colour: Black" → { Size: 'M', Colour: 'Black' }; null when malformed. */
export function readAttributes(s: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of s.split(/[;|]/).map((p) => p.trim()).filter(Boolean)) {
    const at = part.search(/[:=]/);
    if (at <= 0) return null;
    const k = part.slice(0, at).trim();
    const v = part.slice(at + 1).trim();
    if (!k || !v || k.length > 50 || v.length > 100) return null;
    out[k] = v;
  }
  return Object.keys(out).length <= 10 ? out : null;
}

/**
 * The rows of a parsed file, checked as far as the file alone allows (the API checks the rest:
 * SKUs, barcodes, units and tax categories against what the shop already has). The file's line
 * numbers count the header as line 1; `lines` (from parseCsvLines) gives each row's own line.
 */
export function readImport(table: readonly string[][], lines?: readonly number[]): ReadImport {
  const [header = [], ...body] = table;
  const { columns, unknown } = headerColumns(header);
  const missing = (['name', 'sku'] as const).filter((k) => !columns.includes(k));
  const rows: ImportRow[] = [];
  const problems: ImportProblem[] = [];
  let archived = 0;
  if (missing.length) return { rows, problems, missing, unknown, archived };
  for (const [i, cells] of body.entries()) {
    const line = lines?.[i + 1] ?? i + 2;
    const get = (k: ColumnKey) => {
      const at = columns.indexOf(k);
      // The export puts ' before a cell that starts like a formula (csvField): taken off again here.
      return at >= 0 ? (cells[at] ?? '').trim().replace(/^'(?=[=+\-@])/, '') : '';
    };
    const problem = (key: MessageKey, col?: ColumnKey, vars?: Record<string, string | number>) => problems.push({ line, sku: get('sku'), key, ...(col && { col }), ...(vars && { vars }) });
    if (ARCHIVED.has(norm(get('status')))) {
      archived++;
      continue;
    }
    const before = problems.length;
    const row: ImportRow = { line, name: get('name'), sku: get('sku'), barcodes: [] };
    if (!row.name) problem('pio.err.required', 'name');
    else if (row.name.length > 200) problem('pio.err.tooLong', 'name');
    if (!row.sku) problem('pio.err.required', 'sku');
    else if (!SKU.test(row.sku)) problem('pio.err.sku');
    const text = (k: 'variantName' | 'category' | 'unit' | 'tax', max: number) => {
      const v = get(k);
      if (v.length > max) problem('pio.err.tooLong', k);
      else if (v) row[k] = v;
    };
    text('variantName', 200);
    text('category', 500);
    text('unit', 10);
    text('tax', 200);
    for (const code of get('barcodes').split(/[\s,;|]+/).filter(Boolean)) {
      if (BARCODE.test(code)) row.barcodes.push(code);
      else problem('pio.err.barcode', 'barcodes', { code });
    }
    if (row.barcodes.length > 20) problem('pio.err.tooMany', 'barcodes', { max: 20 });
    const choice = <V>(k: ColumnKey, options: [Set<string>, V][], err: MessageKey): V | undefined => {
      const v = norm(get(k));
      if (!v) return undefined;
      const hit = options.find(([set]) => set.has(v));
      if (!hit) problem(err, k);
      return hit?.[1];
    };
    const soldBy = choice('soldBy', [[UNIT, 'UNIT' as const], [WEIGHT, 'WEIGHT' as const]], 'pio.err.soldBy');
    const productType = choice('productType', [[GOODS, 'STANDARD' as const], [SERVICE, 'SERVICE' as const]], 'pio.err.type');
    const trackInventory = choice('trackInventory', [[YES, true], [NO, false]], 'pio.err.yesNo');
    const tracksExpiry = choice('tracksExpiry', [[YES, true], [NO, false]], 'pio.err.yesNo');
    if (soldBy) row.soldBy = soldBy;
    if (productType) row.productType = productType;
    if (trackInventory !== undefined) row.trackInventory = trackInventory;
    if (tracksExpiry !== undefined) row.tracksExpiry = tracksExpiry;
    for (const k of ['price', 'referenceCost'] as const) {
      const v = get(k);
      if (!v) continue;
      const amount = readAmount(v);
      if (amount) row[k] = amount;
      else problem('pio.err.amount', k);
    }
    const attrs = get('attributes');
    if (attrs) {
      const a = readAttributes(attrs);
      if (a) row.attributes = a;
      else problem('pio.err.attributes', 'attributes');
    }
    if (problems.length === before) rows.push(row);
  }
  return { rows, problems, missing, unknown, archived };
}
