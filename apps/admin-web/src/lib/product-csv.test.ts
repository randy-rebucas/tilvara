import { describe, expect, it } from 'vitest';
import { translate, type Lang, type MessageKey } from '../i18n/messages';
import { COLUMNS, decodeCsvFile, parseCsv, parseCsvLines, productExportRows, readAmount, readAttributes, readImport, trimAmount, type ExportContext, type ExportProduct } from './product-csv';
import { activeFilterCount, filtersToSearch, productApiQuery, readProductFilters } from './product-filters';
import { toCsv } from './report-csv';

const tIn = (lang: Lang) => (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars);

const product: ExportProduct = {
  id: 'p1',
  name: '-Sale- Shirt',
  productType: 'STANDARD',
  soldBy: 'UNIT',
  trackInventory: true,
  tracksExpiry: false,
  categoryId: 'c1',
  uomId: 'u1',
  taxCategoryId: 'x1',
  archivedAt: null,
  variants: [
    { id: 'v1', sku: 'SH-S', name: 'Small, blue', barcodes: ['4800000000017', '29123'], archivedAt: null, attributes: { Size: 'S', Colour: 'Blue' }, referenceCost: '120.5000' },
    { id: 'v2', sku: 'SH-OLD', name: null, barcodes: [], archivedAt: '2026-10-01T00:00:00Z', attributes: {} },
  ],
};
const ctx: ExportContext = {
  categoryPath: new Map([['c1', 'Clothes › Shirts']]),
  unitCode: new Map([['u1', 'PC']]),
  taxCode: new Map([['x1', 'VAT']]),
  price: new Map([['v1', '299.5000']]),
};

describe('product CSV', () => {
  it('trims amounts by the string, never through a float', () => {
    expect(['22.0000', '12.5000', '1.2340', '10', '0.0000', '1234567890123456.1200'].map(trimAmount)).toEqual(['22.00', '12.50', '1.234', '10', '0.00', '1234567890123456.12']);
  });

  it('exports one row per active variant, in the viewer’s language', () => {
    const rows = productExportRows([product], ctx, tIn('en'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(COLUMNS.map((c) => translate('en', c.label)));
    expect(rows[1]).toEqual(['-Sale- Shirt', 'Small, blue', 'SH-S', '4800000000017 29123', 'Clothes › Shirts', 'PC', 'VAT', 'Unit', 'Goods', 'Yes', 'No', '299.50', '120.50', 'Size: S; Colour: Blue', 'Active']);
    const fil = productExportRows([{ ...product, archivedAt: '2026-10-01T00:00:00Z' }], ctx, tIn('fil'));
    // An archived product lists all its variants, each marked archived.
    expect(fil.slice(1).map((r) => r.at(-1))).toEqual(['Naka-archive', 'Naka-archive']);
    expect(fil[1]![7]).toBe('Piraso');
  });

  it('reads back what it exports (quotes, the formula guard, BOM), in either language', () => {
    for (const lang of ['en', 'fil'] as const) {
      const csv = toCsv(productExportRows([product], ctx, tIn(lang)));
      const read = readImport(parseCsv(csv));
      expect(read).toMatchObject({ missing: [], unknown: [], problems: [], archived: 0 });
      expect(read.rows).toEqual([
        {
          line: 2, name: '-Sale- Shirt', sku: 'SH-S', variantName: 'Small, blue', barcodes: ['4800000000017', '29123'], category: 'Clothes › Shirts',
          unit: 'PC', tax: 'VAT', soldBy: 'UNIT', productType: 'STANDARD', trackInventory: true, tracksExpiry: false, price: '299.50', referenceCost: '120.50',
          attributes: { Size: 'S', Colour: 'Blue' },
        },
      ]);
    }
  });

  it('parses quoted fields, CRLF and LF, blank lines, and semicolon files', () => {
    expect(parseCsv('a,b\r\n"x, ""y""","line\nbreak"\r\n\r\n,\nlast,row')).toEqual([['a', 'b'], ['x, "y"', 'line\nbreak'], ['last', 'row']]);
    expect(parseCsv('﻿Name;SKU\nSoap;S1\n')).toEqual([['Name', 'SKU'], ['Soap', 'S1']]);
  });

  it('needs the name and SKU columns; other columns are optional and unknown ones reported', () => {
    expect(readImport(parseCsv('Name,Price\nSoap,10')).missing).toEqual(['sku']);
    const r = readImport(parseCsv('sku,Product name,Price,Remarks\nS1,Soap,"₱1,234.50",fragile'));
    expect(r.unknown).toEqual(['Remarks']);
    expect(r.rows).toEqual([{ line: 2, name: 'Soap', sku: 'S1', barcodes: [], price: '1234.50' }]);
  });

  it('names each bad cell by line and column, and skips archived rows', () => {
    const csv = [
      'Product name,SKU,Barcodes,Sold by,Type,Track stock,Price,Sizes and colours,Status',
      'Soap,S1,,Weight,Service,oo,10,,',
      ',S2,,,,,,,',
      'Bad,bad sku!,12 x?y,Litre,Thing,maybe,ten,Size,',
      'Old,S9,,,,,,,Archived',
    ].join('\n');
    const r = readImport(parseCsv(csv));
    expect(r.rows.map((x) => x.sku)).toEqual(['S1']);
    expect(r.rows[0]).toMatchObject({ soldBy: 'WEIGHT', productType: 'SERVICE', trackInventory: true, price: '10' });
    expect(r.archived).toBe(1);
    expect(r.problems.map((p) => [p.line, p.key, p.col ?? null])).toEqual([
      [3, 'pio.err.required', 'name'],
      [4, 'pio.err.sku', null],
      [4, 'pio.err.barcode', 'barcodes'],
      [4, 'pio.err.soldBy', 'soldBy'],
      [4, 'pio.err.type', 'productType'],
      [4, 'pio.err.yesNo', 'trackInventory'],
      [4, 'pio.err.amount', 'price'],
      [4, 'pio.err.attributes', 'attributes'],
    ]);
  });

  it('gives each row the line it starts on in the file (blank lines and line breaks in quotes counted)', () => {
    const csv = 'Product name,SKU,Sizes and colours\n\nSoap,S1,\n"Two\nlines",S2,\nBad,bad sku!,\r\n\r\nLast,S3,Size';
    const parsed = parseCsvLines(csv);
    expect(parsed.map((r) => r.line)).toEqual([1, 3, 4, 6, 8]);
    const r = readImport(parsed.map((x) => x.cells), parsed.map((x) => x.line));
    expect(r.rows.map((x) => [x.line, x.sku])).toEqual([[3, 'S1'], [4, 'S2']]);
    expect(r.problems.map((p) => [p.line, p.key])).toEqual([[6, 'pio.err.sku'], [8, 'pio.err.attributes']]);
  });

  it('reads a UTF-8 file (with or without BOM) as UTF-8 and an Excel ANSI file as Windows-1252', () => {
    const utf8 = new TextEncoder().encode('\uFEFFProduct name,SKU\nPiña,S1\n');
    // The decoder drops the BOM; parseCsv takes it off too when a reader leaves it.
    expect(decodeCsvFile(utf8)).toEqual({ text: 'Product name,SKU\nPiña,S1\n', encoding: 'utf-8' });
    // "Niño,S2" as Excel's "CSV (Comma delimited)" writes it: ñ is the single byte 0xF1, invalid in UTF-8.
    const ansi = Uint8Array.from([0x4e, 0x69, 0xf1, 0x6f, 0x2c, 0x53, 0x32]);
    expect(decodeCsvFile(ansi)).toEqual({ text: 'Niño,S2', encoding: 'windows-1252' });
    expect(decodeCsvFile(Uint8Array.from([0x80])).text).toBe('€');
  });

  it('reads amounts and sizes and colours', () => {
    expect(['49.75', '₱ 1,000', 'PHP 5', '1,00', '-3', '1.23456'].map(readAmount)).toEqual(['49.75', '1000', '5', null, null, null]);
    expect(readAttributes('Size: M; Colour=Black')).toEqual({ Size: 'M', Colour: 'Black' });
    expect(readAttributes('M')).toBeNull();
  });
});

describe('product filters', () => {
  const cat = '0199c000-0000-7000-8000-000000000001';
  it('keeps only known values and maps them to the API query', () => {
    const f = readProductFilters({ q: ' coke ', category: cat, status: 'archived', price: 'false', sort: 'name', stock: 'maybe', tax: 'nope', cursor: 'x' });
    expect(f).toEqual({ q: 'coke', category: cat, status: 'archived', price: 'false', sort: 'name' });
    expect(activeFilterCount(f)).toBe(3);
    expect(Object.fromEntries(productApiQuery(f, { limit: 200, cursor: 'c' }))).toEqual({
      limit: '200', q: 'coke', categoryId: cat, withSubcategories: 'true', status: 'archived', hasPrice: 'false', sort: 'name', cursor: 'c',
    });
    expect(Object.fromEntries(productApiQuery(readProductFilters({ category: 'none' }), { limit: 50 }))).toEqual({ limit: '50', categoryId: 'none' });
    expect(filtersToSearch(f, { cursor: 'n' }).toString()).toBe(`q=coke&category=${cat}&status=archived&price=false&sort=name&cursor=n`);
  });
});
