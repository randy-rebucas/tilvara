// End-to-end smoke test for the admin web, driven over the Chrome DevTools Protocol with a
// locally installed Edge/Chrome (no Playwright download needed on this machine).
// Usage: node e2e/smoke.mjs [baseUrl] [screenshotDir]
// Requires the API (4320) and admin web (3320) to be running.
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, bff } = b;

try {
  await viewport(1440, 900);

  // 1. Unauthenticated visit redirects to sign-in
  await go('/products');
  check('signed-out visitor is sent to sign-in', (await evaluate('location.pathname')) === '/sign-in');
  await shot('sign-in.png', false);

  // 2. Sign up through the real form
  const slug = `smoke-${Date.now().toString(36)}`;
  await go('/sign-up');
  await fill('businessName', 'Sari-Sari Smoke Test');
  await fill('tenantSlug', slug);
  await fill('displayName', 'Maria Santos');
  await fill('email', `${slug}@example.ph`);
  await fill('password', 'correct horse battery staple');
  await evaluate(`document.querySelector('input[name=businessType][value=RETAIL]').click()`);
  await b.finishSteps();
  await waitFor(`location.pathname === '/' || document.querySelector('[role=alert]')`);
  const signupError = await evaluate(`document.querySelector('[role=alert]')?.textContent ?? ''`);
  if (signupError) throw new Error(`sign-up failed: ${signupError}`);
  await waitFor(`document.body.innerText.includes('Overview')`);
  check('sign-up lands on overview', true);
  check('tokens are not readable by page JS', !(await evaluate(`document.cookie.includes('onepos_at') || document.cookie.includes('onepos_rt')`)));
  await shot('overview-empty.png');

  // 2b. Business type: a retail shop sees no appointments; changing the type brings them into view.
  const navHas = (label) => evaluate(`[...document.querySelectorAll('nav[data-testid=main-nav] a')].some((a) => a.textContent === ${JSON.stringify(label)})`);
  check('retail shop: no Appointments tab', !(await navHas('Appointments')));
  await go('/appointments');
  check('retail shop: appointments say they are off', await evaluate(`document.body.innerText.includes('are for a salon, spa or barber shop')`));
  await go('/subscription/business');
  check('business page shows the type chosen at sign-up', await evaluate(`document.querySelector('input[name=businessType][value=RETAIL]').checked`));
  await shot('business-type.png');
  await evaluate(`document.querySelector('input[name=businessType][value=SALON]').click()`);
  // The type's own form (the page also has the business name form, session 22).
  await evaluate(`document.querySelector('input[name=businessType]').closest('form').querySelector('button.btn-primary').click()`);
  await waitFor(`[...document.querySelectorAll('[role=status]')].some((x) => x.textContent.startsWith('Saved'))`);
  await go('/');
  check('after changing to Salon: Appointments tab shown', await navHas('Appointments'));

  // 3. CSRF: a mutation without the custom header is refused by the BFF
  const csrf = await evaluate(`fetch('/api/v1/categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' }).then((r) => r.status)`);
  check('BFF refuses mutation without CSRF header (403)', csrf === 403);

  // 4. Add a legal entity through the UI form
  await go('/locations');
  await clickText('Add legal entity');
  await waitFor(`document.querySelector('[name="registeredName"]')`);
  await fill('registeredName', 'Sari-Sari Smoke Trading Corp');
  await fill('tin', '123-456-789');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  // The TIN hint also shows "123-456-789", so wait for the saved name (input values are not innerText).
  await waitFor(`document.body.innerText.includes('Sari-Sari Smoke Trading Corp')`);
  check('legal entity created via UI with formatted TIN', await evaluate(`document.body.innerText.includes('123-456-789')`));

  // 5. Rest of the setup through the BFF proxy
  const entities = await bff('GET', '/api/v1/legal-entities');
  const entityId = (await evaluate(`fetch('/api/v1/legal-entities').then((r) => r.json())`)).data[0].id;
  void entities;
  const br = await bff('POST', '/api/v1/branches', { legalEntityId: entityId, code: 'MKT-01', name: 'Makati Main' }, true);
  if (br.status !== 201) console.log('branch response:', JSON.stringify(br));
  check('branch created through BFF (201)', br.status === 201);
  const reg = await bff('POST', '/api/v1/registers', { branchId: br.body.id, code: 'R1', name: 'Counter 1' }, true);
  check('register created (201)', reg.status === 201);
  const term = await bff('POST', '/api/v1/terminals', { registerId: reg.body.id, name: 'iPad Counter 1' });
  check('terminal paired, one-time credential returned', term.status === 201 && term.body.credential.startsWith('tpk_'));
  const uoms = await evaluate(`fetch('/api/v1/uoms').then((r) => r.json())`);
  const taxes = await evaluate(`fetch('/api/v1/tax-categories').then((r) => r.json())`);
  const pc = uoms.data.find((u) => u.code === 'PC').id;
  const vat = taxes.data.find((x) => x.code === 'VAT').id;
  const items = [
    ['Lucky Me Pancit Canton Chilimansi', 'LM-PC-CHILI', '4807770270017', '16.50'],
    ['Coke Mismo 290ml', 'CK-290', '4801981116072', '22.00'],
    ['Bear Brand Powdered Milk 33g', 'BB-33', '4800361001234', '12.75'],
    ['Gift wrap', 'SV-WRAP', null, null],
  ];
  for (const [name, sku, code, price] of items) {
    const r = await bff('POST', '/api/v1/products', {
      name, taxCategoryId: vat, uomId: pc,
      variants: [{ sku, barcodes: code ? [code] : [], ...(price ? { price } : {}) }],
    }, true);
    check(`product ${sku} created`, r.status === 201);
  }

  // 6. Pages render with data
  await go('/');
  check('overview shows priced product in ₱', await evaluate(`document.body.innerText.includes('₱16.50')`));
  check('overview flags the unpriced item', await evaluate(`document.body.innerText.toLowerCase().includes('without a price: 1')`));
  await shot('desktop.png');
  await go('/locations'); await shot('locations.png');
  await go('/products?q=coke');
  check('product search finds Coke', await evaluate(`document.body.innerText.includes('Coke Mismo')`) && !(await evaluate(`document.body.innerText.includes('Lucky Me')`)));
  await go('/products'); await shot('products.png');
  await go('/prices'); await shot('prices.png');
  await go('/team'); await shot('team.png');
  await go('/subscription');
  check('subscription shows trial and limits', await evaluate(`document.body.innerText.includes('Growth trial') && document.body.innerText.includes('1 / 30')`));
  await shot('subscription.png');

  // 7. Phase 3 through the UI: purchasing → receiving → stock at cost → transfer → count → books
  const text = (s) => evaluate(`document.body.innerText.includes(${JSON.stringify(s)})`);
  const submitForm = () => evaluate(`document.querySelector('form button:not([type=button])').click()`);
  const noAlert = async (label) => {
    const alert = await evaluate(`[...document.querySelectorAll('[role=alert]')].map((x) => x.textContent).join(' | ')`);
    if (alert) throw new Error(`${label}: ${alert}`);
  };
  check('nav shows Inventory, Purchasing and Books', await evaluate(`['Inventory', 'Purchasing', 'Books'].every((x) => [...document.querySelectorAll('nav a')].some((a) => a.textContent === x))`));
  const bgc = await bff('POST', '/api/v1/branches', { legalEntityId: entityId, code: 'BGC-02', name: 'BGC Annex', birBranchCode: '00001' }, true);
  if (bgc.status !== 201) console.log('second branch response:', JSON.stringify(bgc));
  check('second branch of the same entity (201)', bgc.status === 201);
  const variants = (await bff('GET', '/api/v1/products?limit=50')).body.data.flatMap((p) => p.variants);
  const coke = variants.find((v) => v.sku === 'CK-290').id;
  const canton = variants.find((v) => v.sku === 'LM-PC-CHILI').id;

  await go('/purchasing');
  await clickText('Add supplier');
  await waitFor(`document.querySelector('[name="code"]')`);
  await fill('name', 'Coca-Cola Beverages Phils');
  await fill('code', 'ccbpi');
  await submitForm();
  await waitFor(`document.body.innerText.includes('CCBPI')`);
  check('supplier added via UI (code upper-cased)', true);

  await clickText('New purchase order');
  await waitFor(`document.querySelector('[name="lines.0.variantId"]')`);
  await fill('branchId', br.body.id);
  await fill('lines.0.variantId', coke);
  await fill('lines.0.quantity', '24');
  await fill('lines.0.unitCost', '15.00');
  await clickText('Add line');
  await waitFor(`document.querySelector('[name="lines.1.variantId"]')`);
  await fill('lines.1.variantId', canton);
  await fill('lines.1.quantity', '48');
  await fill('lines.1.unitCost', '11.50');
  await submitForm();
  await waitFor(`location.pathname.startsWith('/purchasing/orders/') || document.querySelector('[role=alert]')`);
  await noAlert('create purchase order');
  await waitFor(`document.body.innerText.includes('Purchase order 000001')`);
  check('PO drafted via UI: ₱912.00, draft changes no stock', (await text('₱912.00')) && (await text('A draft does not change stock')));
  await shot('po-draft.png');

  await clickText('Approve order');
  await waitFor(`document.body.innerText.includes('Receive goods')`);
  await clickText('Receive goods');
  await waitFor(`document.querySelector('[name="lines.1.quantity"]')`);
  await fill('supplierInvoiceRef', 'SI-1001');
  await fill('lines.0.quantity', '20');
  await fill('lines.0.rejectedQuantity', '4');
  await fill('lines.0.rejectionReason', 'Dented cans');
  await submitForm();
  await waitFor(`document.body.innerText.includes('Goods receipt 000001') || document.querySelector('[role=alert]')`);
  await noAlert('receive goods');
  check('received 20 + 48 with 4 rejected → partly received, ₱852.00', (await text('Partly received')) && (await text('₱852.00')));
  await shot('po-received.png');

  await clickText('Goods receipt 000001');
  await waitFor(`location.pathname.startsWith('/purchasing/receipts/')`);
  await waitFor(`document.body.innerText.includes('Dented cans')`);
  check('receipt shows invoice ref, rejection reason and value', (await text('SI-1001')) && (await text('₱852.00')));
  await clickText('Journal entry');
  await waitFor(`location.pathname === '/books' && document.body.innerText.includes('Showing the entries of one document')`);
  check('receipt → its journal entry (one, ₱852.00)', (await evaluate(`document.querySelectorAll('tbody tr').length`)) === 1 && (await text('₱852.00')));
  await clickText('Goods receipt');
  await waitFor(`location.pathname.startsWith('/purchasing/receipts/')`);
  check('journal entry → back to the receipt', true);

  await go(`/inventory?branch=${br.body.id}`);
  check('stock value at cost ₱852.00 equals the stock ledger', (await text('₱852.00')) && (await text('Equals the stock ledger')));
  await shot('inventory.png');

  await go(`/inventory/transfers?branch=${br.body.id}`);
  await clickText('Send stock');
  await waitFor(`document.querySelector('[name="lines.0.variantId"]')`);
  await fill('lines.0.variantId', coke);
  await fill('lines.0.quantity', '5');
  await submitForm();
  await waitFor(`location.pathname.startsWith('/inventory/transfers/') || document.querySelector('[role=alert]')`);
  await noAlert('dispatch transfer');
  await waitFor(`document.body.innerText.includes('Transfer 000001')`);
  check('transfer dispatched via UI: in transit ₱75.00', (await text('In transit')) && (await text('₱75.00')));
  await clickText('Receive transfer');
  await waitFor(`document.querySelector('[name="lines.0.receivedQuantity"]')`);
  await fill('lines.0.receivedQuantity', '4');
  await submitForm();
  await waitFor(`document.querySelector('[role=alert]')`);
  check('short receipt without a reason is refused', await evaluate(`Boolean(document.querySelector('[role=alert]'))`));
  await fill('lines.0.discrepancyReason', 'One can burst');
  await submitForm();
  await waitFor(`document.body.innerText.includes('Lost in transit')`);
  check('received 4 of 5: ₱15.00 lost in transit, reason shown', (await text('₱15.00')) && (await text('One can burst')));
  await shot('transfer-received.png');

  await go(`/inventory/counts?branch=${br.body.id}`);
  await clickText('Post a count');
  await waitFor(`document.querySelector('[name="lines.0.variantId"]')`);
  await fill('lines.0.variantId', canton);
  await fill('lines.0.countedQuantity', '46');
  await submitForm();
  await waitFor(`location.pathname.startsWith('/inventory/counts/') || document.querySelector('[role=alert]')`);
  await noAlert('post count');
  await waitFor(`document.body.innerText.includes('Count 000001')`);
  check('count 46 vs 48 on hand → −2, −₱23.00', (await text('−2')) && (await text('−₱23.00')));

  await go('/books/trial-balance');
  check('trial balance: debits equal credits', await text('Debits equal credits.'));
  await shot('trial-balance.png');

  await go('/books/periods');
  await clickText('Close month');
  await waitFor(`document.querySelector('[name="month"]')`);
  await submitForm();
  await waitFor(`document.body.innerText.includes('Reopen') || document.querySelector('[role=alert]')`);
  await noAlert('close month');
  check('last month closed via UI', await text('Closed'));
  await clickText('Reopen');
  await waitFor(`document.querySelector('[name="reason"]')`);
  await fill('reason', 'Late supplier invoice');
  await submitForm();
  await waitFor(`!document.body.innerText.includes('Reopen')`);
  check('closed month reopened with a reason', await text('Open'));

  const accounts = (await bff('GET', `/api/v1/accounts?legalEntityId=${entityId}`)).body.data;
  await go('/books');
  await clickText('Manual entry');
  await waitFor(`document.querySelector('[name="lines.1.accountId"]')`);
  await fill('memo', 'Owner cash top-up');
  await fill('lines.0.accountId', accounts.find((a) => a.type === 'ASSET').id);
  await fill('lines.0.debit', '100.00');
  await fill('lines.1.accountId', accounts.find((a) => a.type === 'EQUITY').id);
  await fill('lines.1.credit', '100.00');
  await submitForm();
  await waitFor(`location.pathname.startsWith('/books/entries/') || document.querySelector('[role=alert]')`);
  await noAlert('manual entry');
  await waitFor(`document.body.innerText.includes('Owner cash top-up')`);
  await clickText('Reverse entry');
  await waitFor(`document.querySelector('[name="memo"]')`);
  await fill('memo', 'Posted twice');
  await submitForm();
  await waitFor(`document.body.innerText.includes('Reversed by a later entry') || document.querySelector('[role=alert]')`);
  await noAlert('reverse entry');
  check('manual entry posted and reversed via UI', await text('Reversed by a later entry'));
  await go('/books/trial-balance');
  check('trial balance still balances after manual entry + reversal', await text('Debits equal credits.'));

  // A multi-item adjustment is one document: its journal entry opens it, and it lists every item.
  const adj = await bff('POST', '/api/v1/stock/adjustments', { branchId: br.body.id, kind: 'WASTE', reason: 'Flood damage', items: [{ variantId: coke, quantity: '-1' }, { variantId: canton, quantity: '-2' }] }, true);
  await go(`/books?entity=${entityId}&source=${adj.body.id}`);
  await clickText('Stock adjustment');
  await waitFor(`location.pathname.startsWith('/inventory/adjustments/')`);
  await waitFor(`document.body.innerText.includes('Flood damage')`);
  check('adjustment entry → its document with every item (−₱38.00)', (await text('CK-290')) && (await text('LM-PC-CHILI')) && (await text('−₱38.00')));

  // 8. Filipino
  await bff('POST', '/api/auth/lang', { lang: 'fil' });
  await go('/');
  check('Filipino UI renders', await evaluate(`document.body.innerText.includes('Buod') && document.documentElement.lang === 'fil'`));
  await shot('overview-fil.png', false);
  await bff('POST', '/api/auth/lang', { lang: 'en' });

  // 9. Mobile
  await viewport(390, 844, true);
  await go('/');
  check('no horizontal page scroll at 390px', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  await shot('mobile.png');
  for (const path of [`/inventory?branch=${br.body.id}`, '/purchasing', '/books', '/books/trial-balance']) {
    await go(path);
    check(`${path.split('?')[0]}: no horizontal scroll at 390px, figures visible`, await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.innerText.includes('₱')`));
  }
  await viewport(1440, 900);

  // 10. Sign out revokes the session
  await bff('POST', '/api/auth/logout', {});
  await go('/');
  check('after sign-out, app redirects to sign-in', (await evaluate('location.pathname')) === '/sign-in');
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
