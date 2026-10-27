// End-to-end test of the products list's filters, CSV export and CSV import (session 37):
// - Filters: a sheet beside the search box, "Missing a price", a chip that takes one filter off, sort by name, next page;
// - Export CSV: the products the list shows, one row per variant; the blank file;
// - Import CSV: a file with a bad row is refused row by row and nothing changes; the fixed file shows
//   what each row does, then imports (a price changed, a product with sizes, a category path made);
//   the same file again changes nothing;
// - the guide line; Filipino; phone width.
// Usage: node apps/admin-web/e2e/products-io.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/api.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

const slug = `pio-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Cruz', businessName: 'Nena Store', tenantSlug: slug });
const tk = owner.tokens.accessToken;
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const uoms = (await call('GET', '/v1/uoms', tk)).data;
const pc = uoms.find((u) => u.code === 'PC').id;
const kg = uoms.find((u) => u.code === 'KG').id;
const tag = slug.slice(-5).toUpperCase();
const COLA = `COLA-${tag}`;
await call('POST', '/v1/products', tk, { name: 'Cola 290ml', taxCategoryId: vat, uomId: pc, variants: [{ sku: COLA, price: '20.00', barcodes: [`480${Date.now().toString().slice(-10)}`] }] }, idem());
await call('POST', '/v1/products', tk, { name: 'Rice (loose)', taxCategoryId: vat, uomId: kg, soldBy: 'WEIGHT', variants: [{ sku: `RICE-${tag}` }] }, idem());
await call('POST', '/v1/products', tk, { name: 'Gift wrap', productType: 'SERVICE', trackInventory: false, taxCategoryId: vat, uomId: pc, variants: [{ sku: `WRAP-${tag}` }] }, idem());
for (let i = 0; i < 52; i++) {
  await call('POST', '/v1/products', tk, { name: `Bulk item ${String(i).padStart(2, '0')}`, taxCategoryId: vat, uomId: pc, variants: [{ sku: `BULK-${tag}-${i}`, price: '5.00' }] }, idem());
}

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9361 });
const { evaluate, viewport, waitFor, go, fill, clickText, openSheet, shot, noHorizontalScroll } = b;
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const listed = () => evaluate(`[...document.querySelectorAll('main table tbody tr td:first-child a')].map((a) => a.textContent.trim())`);
const choose = (name, value) => evaluate(`(() => {
  const el = document.querySelector('dialog.sheet[open] select[name=${JSON.stringify(name)}]');
  el.value = ${JSON.stringify(value)};
  return el.value;
})()`);
/** Put a CSV file into the import sheet's file box, as a person picking it would. */
const pickFile = (name, text) => evaluate(`(() => {
  const input = document.querySelector('dialog.sheet[open] input[type=file]');
  const dt = new DataTransfer();
  dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: 'text/csv' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.files.length;
})()`);
const sheetButton = (text) => evaluate(`(() => {
  const b = [...document.querySelectorAll('dialog.sheet[open] button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}));
  if (!b) throw new Error('no button: ${text}');
  b.click();
})()`);
const fetchText = (path) => evaluate(`fetch(${JSON.stringify(path)}).then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), text: await r.text() }))`);

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);

  // ---- filters ----
  await go('/products');
  check('the list has Filters, Export CSV and Import CSV', await shown('Filters') && await shown('Export CSV') && await shown('Import CSV'));
  check('Filters sits beside the search box', await evaluate(`(() => {
    const s = document.getElementById('q').getBoundingClientRect(), f = document.querySelector('[data-testid="product-filters"]').getBoundingClientRect();
    return Math.abs(s.top - f.top) < 4 && f.left > s.right;
  })()`));
  await go('/products?q=e');
  await openSheet('Filters');
  check('the filters open in a sheet', await evaluate(`!!document.querySelector('dialog.sheet[open] select[name="price"]')`));
  await sleep(500);
  await shot('products-filters-sheet.png', false);
  await choose('price', 'false');
  await sheetButton('Show');
  await waitFor(`location.search.includes('price=false')`);
  check('Show closes the sheet, keeps the search, and leaves Any fields out of the address', await evaluate(`!document.querySelector('dialog.sheet[open]') && location.search === '?q=e&price=false'`));
  await go('/products?price=false');
  await sleep(300);
  const unpriced = await listed();
  check('“Missing a price” lists the rice and the gift wrap only', JSON.stringify([...unpriced].sort()) === JSON.stringify(['Gift wrap', 'Rice (loose)']));
  check('the filter in force is a chip, and the button counts it', await shown('Missing a price') && await shown('Filters (1)'));
  await evaluate(`document.getElementById('q').value = 'Rice'; document.querySelector('form[role=search]').requestSubmit()`);
  await waitFor(`location.search.includes('q=Rice')`);
  check('a new search keeps the filter', await evaluate(`location.search.includes('price=false')`) && JSON.stringify(await listed()) === JSON.stringify(['Rice (loose)']));
  await go('/products?price=false');
  await shot('products-filters.png', false);
  await evaluate(`document.querySelector('[data-testid="category-filter"] a').click()`);
  await waitFor(`!location.search.includes('price=false')`);
  check('the chip’s × takes the filter off', (await listed()).length === 50);
  await go('/products?sort=name&type=STANDARD');
  const byName = await listed();
  check('Name A–Z with Goods only: sorted by name, no service', byName[0] === 'Bulk item 00' && !byName.includes('Gift wrap') && byName.length === 50);
  await clickText('Next page');
  await waitFor(`location.search.includes('cursor=')`);
  await sleep(300);
  const page2 = await listed();
  check('the next page keeps the sort and the filter', await evaluate(`location.search.includes('sort=name') && location.search.includes('type=STANDARD')`));
  check('page 2 by name: the last bulk items, the cola and the rice', JSON.stringify(page2) === JSON.stringify(['Bulk item 50', 'Bulk item 51', 'Cola 290ml', 'Rice (loose)']));

  // ---- export ----
  const exp = await fetchText('/products/export?price=false');
  const lines = exp.text.replace(/^﻿/, '').trim().split('\r\n');
  check('Export CSV: a CSV download of what the list shows (2 unpriced items + header)', exp.status === 200 && exp.type.startsWith('text/csv') && /attachment; filename="tilvara-products-/.test(exp.disposition) && lines.length === 3);
  check('the export’s header is the import’s columns', lines[0].startsWith('Product name,Variant name,SKU,Barcodes,Category,Unit,Tax,Sold by,Type,Track stock,Expiry dates,Price (₱),Reference cost,Sizes and colours,Status'));
  check('the rice row reads back in words', lines.some((l) => l.startsWith(`Rice (loose),,RICE-${tag},,,KG,VAT-able,Weight,Goods,Yes,No,,,,Active`)));
  const blank = await fetchText('/products/export?template=1');
  check('the blank file is the header alone', blank.text.replace(/^﻿/, '').trim().split('\r\n').length === 1 && blank.text.includes('Product name'));
  const hrefOk = await evaluate(`[...document.querySelectorAll('a[download]')].some((a) => a.getAttribute('href') === '/products/export?type=STANDARD&sort=name')`);
  check('the Export CSV link carries the list’s filters', hrefOk);

  // ---- import: a bad file, then the fixed one ----
  await go('/products');
  await openSheet('Import CSV');
  check('the import sheet explains matching by SKU and offers the blank file', await shown('found by its SKU') && await shown('Download a blank file'));
  const bad = [
    'Product name,Variant name,SKU,Price (₱),Category,Sizes and colours',
    `Cola 290ml,,${COLA},22.50,Drinks › Soft drinks,`,
    `Polo shirt,Small,POLO-${tag}-S,450,Clothes,Size: S`,
    `Polo shirt,Medium,POLO-${tag}-M,abc,Clothes,Size: M`,
  ].join('\n');
  await pickFile('products.csv', bad);
  await sheetButton('Check the file');
  check('a bad cell is named by its line and column, and nothing can be imported yet', await shown('write a number such as 49.75') && await shown('Nothing is imported until every row is right') && !(await evaluate(`[...document.querySelectorAll('dialog.sheet[open] button')].some((b) => b.textContent.startsWith('Import '))`)));
  await shot('products-import-bad.png', false);
  check('nothing changed by checking', (await call('GET', '/v1/products?q=Polo', tk)).data.length === 0);
  const good = bad.replace(',abc,', ',450,');
  await pickFile('products.csv', good);
  await sheetButton('Check the file');
  check('the fixed file: 1 new product, 1 new variant, 1 update, the new categories', await shown('New products: 1') && await shown('New variants: 1') && await shown('Updated: 1') && await shown('Drinks › Soft drinks'));
  check('the update shows each change before → after', await shown('Drinks › Soft drinks') && await shown('₱20.00 → ₱22.50'));
  await shot('products-import-preview.png', false);
  await sheetButton('Import 3 rows');
  check('imported, with the counts', await shown('Imported. New products: 1, new variants: 1, updated: 1.', 15000));
  const polo = (await call('GET', '/v1/products?q=Polo', tk)).data[0];
  const lists = (await call('GET', '/v1/price-lists', tk)).data;
  const prices = (await call('GET', `/v1/price-lists/${lists.find((l) => l.isDefault).id}/prices`, tk)).data;
  check('the polo has both sizes, and the cola costs 22.50 now', polo?.variants.length === 2 && polo.variants[0].attributes.Size === 'S' && prices.find((p) => p.sku === COLA)?.amount === '22.5000');
  await clickText('Close');
  await sleep(300);
  await openSheet('Import CSV');
  await pickFile('products.csv', good);
  await sheetButton('Check the file');
  check('the same file again: nothing to change', await shown('Nothing to change'));
  await clickText('Cancel');

  // ---- round trip: export everything, import it back unchanged ----
  const all = await fetchText('/products/export');
  await openSheet('Import CSV');
  await pickFile('all.csv', all.text);
  await sheetButton('Check the file');
  check('an export imported back changes nothing (57 rows)', await shown('No change: 57') && await shown('Nothing to change'));
  await clickText('Cancel');

  // ---- guide, Filipino, phone width ----
  await go('/help');
  check('the guide tells how to import and export', await shown('Import CSV” reads a spreadsheet saved as CSV', 10000));
  await go('/products?price=false');
  await clickText('FIL');
  check('Filipino: the filters and the buttons', await shown('Kulang sa presyo', 10000) && await shown('I-export ang CSV') && await shown('Mag-import ng CSV'));
  const fil = await fetchText('/products/export?template=1');
  check('Filipino: the blank file’s header', fil.text.includes('Pangalan ng produkto') || fil.text.includes('Pangalan'));
  await viewport(390, 844);
  await sleep(400);
  check('phone width: the products page has no horizontal scroll', await noHorizontalScroll());
  await shot('products-filters-390.png', false);
  await openSheet('Mag-import ng CSV');
  await sleep(300);
  check('phone width: the import sheet has no horizontal scroll', await noHorizontalScroll());
  await shot('products-import-390.png', false);
  b.close();
} catch (e) {
  console.error(e);
  b.close();
  check('no unexpected error', false);
}
finish();
