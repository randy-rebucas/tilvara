// Design-review capture pass: every screen and state not covered by smoke.mjs — auth forms and
// their error states, the business picker, open "add" panels, validation errors, not-found —
// at 1440px and 390px, with a horizontal-scroll check on every 390px capture.
// Usage: node e2e/review.mjs [baseUrl] [screenshotDir] [apiUrl]
// Requires the API (RATE_LIMITS_ENABLED=false) and the admin web to be running, and .env at the
// repo root (the business picker needs a second membership, arranged with the migrator role).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review/screens';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const pg = createRequire(new URL('../../api/package.json', import.meta.url))('pg');

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9334 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, bff, noHorizontalScroll } = b;
const PASSWORD = 'correct horse battery staple';

const desktop = () => viewport(1440, 900);
const mobile = () => viewport(390, 844, true);
const submit = () => evaluate(`document.querySelector('form button.btn-primary, form button[type=submit]').click()`);

/** Capture at both widths; the 390px capture must not scroll sideways. */
async function both(name, prepare = async () => {}) {
  await desktop();
  await prepare();
  await shot(`${name}-1440.png`);
  await mobile();
  await prepare();
  check(`${name}: no horizontal scroll at 390px`, await noHorizontalScroll());
  await shot(`${name}-390.png`);
  await desktop();
}

async function openPanels(labels) {
  for (const label of labels) {
    await clickText(label);
    await sleep(150);
  }
}

try {
  // Auth screens
  await both('sign-up', () => go('/sign-up'));
  await both('sign-up-invalid', async () => {
    await go('/sign-up');
    await fill('email', 'not-an-email');
    await fill('password', 'short');
    await submit();
    await sleep(600);
  });
  await both('sign-in-error', async () => {
    await go('/sign-in');
    await fill('email', 'nobody@example.ph');
    await fill('password', 'wrong password here');
    await submit();
    await waitFor(`document.querySelector('[role=alert]')`);
  });
  check('sign-in error is announced (role=alert)', Boolean(await evaluate(`document.querySelector('[role=alert]')?.textContent`)));
  await both('accept-invite-missing-token', () => go('/accept-invite'));
  await both('accept-invite-bad-token', () => go('/accept-invite?token=' + 'x'.repeat(43)));

  // A signed-up owner with data
  const slug = `review-${Date.now().toString(36)}`;
  const email = `${slug}@example.ph`;
  await go('/sign-up');
  await fill('businessName', 'Tindahan ni Aling Nena');
  await fill('tenantSlug', slug);
  await fill('displayName', 'Nena Reyes');
  await fill('email', email);
  await fill('password', PASSWORD);
  await submit();
  await waitFor(`location.pathname === '/'`);
  const entity = await bff('POST', '/api/v1/legal-entities', { registeredName: 'Nena Reyes Trading', tin: '123-456-789', vatStatus: 'NON_VAT' }, true);
  const branch = await bff('POST', '/api/v1/branches', { legalEntityId: entity.body.id, code: 'QC-01', name: 'Cubao' }, true);
  const register = await bff('POST', '/api/v1/registers', { branchId: branch.body.id, code: 'R1', name: 'Counter 1' }, true);
  check('review fixture: entity, branch, register created', [entity, branch, register].every((r) => r.status === 201));
  const uoms = await bff('GET', '/api/v1/uoms');
  const taxes = await bff('GET', '/api/v1/tax-categories');
  const pc = uoms.body.data.find((u) => u.code === 'PC').id;
  const vat = taxes.body.data.find((x) => x.code === 'VAT_EXEMPT').id;
  for (const [name, sku, price] of [['Pandesal (10 pcs)', 'PDS-10', '35.00'], ['Kape barako 250g', 'KB-250', '180.00'], ['Itlog (tray)', 'EGG-30', null]]) {
    await bff('POST', '/api/v1/products', { name, taxCategoryId: vat, uomId: pc, variants: [{ sku, ...(price ? { price } : {}) }] }, true);
  }

  // App pages with every "add" panel open, and a validation error state
  await both('locations-panels', async () => {
    await go('/locations');
    await openPanels(['Add legal entity', 'Add branch', 'Add register', 'Pair a terminal']);
  });
  await both('products-add', async () => {
    await go('/products');
    await openPanels(['Add product']);
  });
  await both('products-add-invalid', async () => {
    await go('/products');
    await openPanels(['Add product']);
    await fill('price', '12.345678');
    await submit();
    await sleep(800);
  });
  await both('products-empty-search', () => go('/products?q=walang-ganito'));
  await both('prices-set', async () => {
    await go('/prices');
    await openPanels(['Set new price']);
  });
  await both('team-invite', async () => {
    await go('/team');
    await openPanels(['Invite someone']);
  });
  await both('subscription', () => go('/subscription'));
  await both('not-found', () => go('/this-page-does-not-exist'));

  // Business picker: give this user a second business, then sign in again
  const other = await fetch(`${API}/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `owner-${slug}@example.ph`, password: PASSWORD, displayName: 'Ramon Cruz', businessName: 'Cruz Hardware & Trading', tenantSlug: `${slug}-b` }),
  }).then((r) => r.json());
  const me = await bff('GET', '/api/v1/me');
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, max: 1 });
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [other.activeTenantId]);
    const m = await c.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2) RETURNING id', [other.activeTenantId, me.body.userId]);
    await c.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id, scope_type, scope_id)
       SELECT $1, $2, id, 'TENANT', NULL FROM roles WHERE tenant_id = $1 AND key = 'cashier'`,
      [other.activeTenantId, m.rows[0].id],
    );
    await c.query('COMMIT');
  } finally {
    c.release();
    await owner.end();
  }
  await bff('POST', '/api/auth/logout', {});
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await submit();
  await waitFor(`location.pathname === '/select-business'`);
  check('two memberships → business picker after sign-in', true);
  await both('select-business', () => go('/select-business'));

  // Filipino on a form-heavy page (longer strings)
  await bff('POST', '/api/auth/lang', { lang: 'fil' });
  await clickText('Tindahan ni Aling Nena');
  await waitFor(`location.pathname === '/'`);
  await both('locations-panels-fil', async () => {
    await go('/locations');
    await openPanels(['Magdagdag', 'Magdagdag', 'Magdagdag']);
  });
  await bff('POST', '/api/auth/lang', { lang: 'en' });
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
