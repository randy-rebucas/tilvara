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
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`location.pathname === '/' || document.querySelector('[role=alert]')`);
  const signupError = await evaluate(`document.querySelector('[role=alert]')?.textContent ?? ''`);
  if (signupError) throw new Error(`sign-up failed: ${signupError}`);
  await waitFor(`document.body.innerText.includes('Overview')`);
  check('sign-up lands on overview', true);
  check('tokens are not readable by page JS', !(await evaluate(`document.cookie.includes('onepos_at') || document.cookie.includes('onepos_rt')`)));
  await shot('overview-empty.png');

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

  // 7. Filipino
  await bff('POST', '/api/auth/lang', { lang: 'fil' });
  await go('/');
  check('Filipino UI renders', await evaluate(`document.body.innerText.includes('Buod') && document.documentElement.lang === 'fil'`));
  await shot('overview-fil.png', false);
  await bff('POST', '/api/auth/lang', { lang: 'en' });

  // 8. Mobile
  await viewport(390, 844, true);
  await go('/');
  check('no horizontal page scroll at 390px', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  await shot('mobile.png');
  await viewport(1440, 900);

  // 9. Sign out revokes the session
  await bff('POST', '/api/auth/logout', {});
  await go('/');
  check('after sign-out, app redirects to sign-in', (await evaluate('location.pathname')) === '/sign-in');
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
