// Sample data for a fresh dev database: one ready-to-use retail shop, made through the real API so every
// row passes the same rules, books and audit as real data (like the load seed and the E2E scripts).
//
//   pnpm seed:sample [--api http://127.0.0.1:4320] [--name Lunara] [--slug lunara] [--email …] [--password …]
//
// Needs the API running (`pnpm dev:api`). Makes: the owner's account and business, a VAT legal entity,
// two branches with a register each, categories, 24 items with store barcodes and prices, a supplier and
// goods received at both branches (stock, cost and payables), three customers, a "3 for" promotion, the
// shop's colour and its own sign-in page (`<slug>.<ONEPOS_SHOP_DOMAIN>`), and a closed shift of sales so
// the reports have something to show. Staff are invited from the admin (Team): invitations go by email.
// Run it on an empty database or pick another --slug/--email; it stops at the first refusal.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4320' },
    name: { type: 'string', default: 'Lunara' },
    slug: { type: 'string', default: 'lunara' },
    email: { type: 'string' },
    password: { type: 'string', default: 'correct horse battery staple' },
  },
});
const API = opt.api.replace(/\/+$/, '').replace(/\/v1$/, '');
const email = opt.email ?? `owner@${opt.slug}.example.ph`;

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data?.error ?? data)}`);
  return data;
}
const idem = () => ({ 'idempotency-key': randomUUID() });
const step = (m) => console.log(`· ${m}`);

/** EAN-13 in the in-store range 200…, so a sample code never belongs to a real product. */
let next = 1;
function storeBarcode() {
  const first12 = `200${String(next++).padStart(9, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 ? 3 : 1);
  return `${first12}${(10 - (sum % 10)) % 10}`;
}

// name, category, VAT-inclusive price, unit cost, opening quantity at the main branch (half at the kiosk)
const ITEMS = [
  ['Coke Mismo 290ml', 'Drinks', '22.00', '15.50', 96],
  ['Royal Tru-Orange 1.5L', 'Drinks', '75.00', '58.00', 24],
  ['Nature Spring Water 500ml', 'Drinks', '15.00', '9.00', 120],
  ['Kopiko Brown Coffee 10s', 'Drinks', '78.00', '61.00', 30],
  ['C2 Green Tea Apple 230ml', 'Drinks', '20.00', '14.25', 72],
  ['Piattos Cheese 85g', 'Snacks', '38.00', '28.00', 48],
  ['Nova Multigrain 78g', 'Snacks', '36.00', '26.50', 48],
  ['Skyflakes Crackers 10s', 'Snacks', '62.00', '47.00', 30],
  ['Choco Mucho Bar', 'Snacks', '12.00', '8.40', 100],
  ['Boy Bawang Cornick 100g', 'Snacks', '28.00', '20.00', 40],
  ['Lucky Me Pancit Canton', 'Pantry', '17.00', '12.60', 120],
  ['Century Tuna Flakes 155g', 'Pantry', '42.00', '33.00', 60],
  ['Argentina Corned Beef 150g', 'Pantry', '45.00', '35.50', 48],
  ['Silver Swan Soy Sauce 385ml', 'Pantry', '28.00', '20.75', 36],
  ['Datu Puti Vinegar 385ml', 'Pantry', '24.00', '17.50', 36],
  ['Bear Brand Powdered Milk 320g', 'Pantry', '135.00', '108.00', 20],
  ['Safeguard Bar Soap 130g', 'Personal care', '52.00', '39.00', 40],
  ['Colgate Toothpaste 150ml', 'Personal care', '118.00', '92.00', 24],
  ['Palmolive Shampoo Sachet', 'Personal care', '8.00', '5.40', 200],
  ['Modess Napkin 8s', 'Personal care', '48.00', '36.00', 30],
  ['Joy Dishwashing Liquid 250ml', 'Household', '62.00', '47.50', 24],
  ['Surf Powder Detergent 1kg', 'Household', '110.00', '86.00', 20],
  ['Zonrox Bleach 500ml', 'Household', '38.00', '27.00', 24],
  ['Baygon Mosquito Coil 10s', 'Household', '55.00', '41.00', 18],
];

step(`API ${API}`);
await call('GET', '/v1/health/ready');

const owner = await call('POST', '/v1/auth/signup', null, { email, password: opt.password, displayName: `${opt.name} Owner`, businessName: opt.name, tenantSlug: opt.slug });
const tk = owner.tokens.accessToken;
step(`business "${opt.name}" (${opt.slug}), owner ${email}`);

const le = await call('POST', '/v1/legal-entities', tk, { registeredName: `${opt.name} Trading`, tradeName: opt.name, tin: '123-456-789', vatStatus: 'VAT' });
const main = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'MAIN', name: 'Main store', birBranchCode: '00000' });
const kiosk = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'KIOSK', name: 'Mall kiosk', birBranchCode: '00001' });
const mainReg = await call('POST', '/v1/registers', tk, { branchId: main.id, code: 'R1', name: 'Counter 1' });
await call('POST', '/v1/registers', tk, { branchId: kiosk.id, code: 'R1', name: 'Kiosk counter' });
step('legal entity, 2 branches, 2 registers');

const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((t) => t.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const categories = {};
for (const name of new Set(ITEMS.map((i) => i[1]))) categories[name] = (await call('POST', '/v1/categories', tk, { name })).id;
const variants = [];
for (const [name, category, price, cost, qty] of ITEMS) {
  const sku = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  const p = await call('POST', '/v1/products', tk, { name, categoryId: categories[category], taxCategoryId: vat, uomId: pc, variants: [{ sku, barcodes: [storeBarcode()], price }] }, idem());
  variants.push({ id: p.variants[0].id, name, price, cost, qty });
}
step(`${Object.keys(categories).length} categories, ${variants.length} items`);

const supplier = await call('POST', '/v1/suppliers', tk, { code: 'SARI-DIST', name: 'Sari-Sari Distributors Inc.' });
await call('POST', '/v1/goods-receipts', tk, { branchId: main.id, supplierId: supplier.id, lines: variants.map((v) => ({ variantId: v.id, quantity: String(v.qty), unitCost: v.cost })) }, idem());
await call('POST', '/v1/goods-receipts', tk, { branchId: kiosk.id, supplierId: supplier.id, lines: variants.map((v) => ({ variantId: v.id, quantity: String(Math.ceil(v.qty / 2)), unitCost: v.cost })) }, idem());
step('supplier and goods received at both branches');

const customers = [];
for (const c of [
  { displayName: 'Maria Santos', phone: '0917 555 0101' },
  { displayName: 'Jose Ramos', phone: '0918 555 0202', email: 'jose.ramos@example.ph' },
  { displayName: 'Carmen Dela Cruz', code: 'SUKI-003' },
]) customers.push(await call('POST', '/v1/customers', tk, c, idem()));
step(`${customers.length} customers`);

const choco = variants.find((v) => v.name.startsWith('Choco Mucho'));
await call('POST', '/v1/promotions', tk, { name: 'Choco Mucho 3 for 33', kind: 'MULTI_BUY', variantIds: [choco.id], quantity: 3, price: '33.00' }, idem());
step('a promotion (Choco Mucho 3 for 33)');

await call('PUT', '/v1/business/branding', tk, { displayName: opt.name, brandColor: '#3B2A7A', receiptFooter: 'Salamat po! Balik po kayo.', publicSignIn: true });
step('branding: colour, receipt footer, own sign-in page');

const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: mainReg.id, openingFloat: '1000.00' });
const pick = (n) => variants[n % variants.length].id;
const baskets = [
  [[0, '2'], [5, '1'], [10, '3']],
  [[8, '3']],
  [[11, '2'], [12, '1'], [13, '1'], [14, '1']],
  [[2, '6']],
  [[16, '2'], [17, '1'], [18, '5']],
  [[20, '1'], [21, '1'], [22, '2']],
  [[3, '1'], [15, '1']],
  [[1, '2'], [6, '2'], [9, '2'], [8, '6']],
];
let sales = 0;
for (const [i, lines] of baskets.entries()) {
  await call('POST', '/v1/sales', tk, {
    cashierSessionId: shift.id,
    clientTransactionId: randomUUID(),
    ...(i % 3 === 0 ? { customerId: customers[(i / 3) % customers.length].id } : {}),
    lines: lines.map(([n, quantity]) => ({ variantId: pick(n), quantity })),
    tenders: [{ method: 'CASH', tendered: '2000.00' }],
  }, idem());
  sales++;
}
const expected = (await call('GET', `/v1/cashier-sessions/${shift.id}`, tk)).expectedCash;
await call('POST', `/v1/cashier-sessions/${shift.id}/close`, tk, { countedCash: expected });
step(`a shift at Counter 1: ${sales} sales, closed with ₱${expected} counted`);

console.log(`\nDone. Sign in at the admin with ${email} / ${opt.password}`);
console.log(`(with ONEPOS_SHOP_DOMAIN=localhost, also at http://${opt.slug}.localhost:3320/sign-in).`);
