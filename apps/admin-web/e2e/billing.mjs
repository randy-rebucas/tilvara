// End-to-end test of subscription billing (ADR-0027) in the admin: a trial owner chooses a plan, pays the bill
// on the payment page (the API's dev simulator), comes back to "received", sees the bill paid and the plan
// active; stops at the end of the period and resumes; moves to a cheaper plan from the next renewal; a cashier
// sees no plan or bills; Filipino; 390px.
// The API must run with BILLING_PROVIDER=dev, APP_PUBLIC_URL=<this admin> and API_PUBLIC_URL=<that API>, so the
// payment page is reachable and sends the browser back here. Plan prices are set in the dev database as the
// migrator (support plan-price) and put back at the end.
// Usage: node apps/admin-web/e2e/billing.mjs [baseUrl] [screenshotDir] [apiUrl]
import { createRequire } from 'node:module';
import { client, PASSWORD } from '../../pos-desktop/e2e/api.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
process.loadEnvFile(new URL('../../../.env', import.meta.url));
const pg = createRequire(new URL('../../../packages/database/package.json', import.meta.url))('pg');

// The prices migration 0133 ships (VAT included); set again in case a run left others, and put back at the end.
const PRICES = { starter: '999.00', growth: '2499.00', enterprise: '5999.00' };
const call = client(API);
const stamp = Date.now().toString(36);
const email = `bill-${stamp}@example.ph`;
const slug = `bill-${stamp}`;
await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Ana Cruz', businessName: `Tindahan ni Ana ${stamp}`, tenantSlug: slug });

const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
await db.connect();
const before = Object.fromEntries((await db.query(`SELECT code, monthly_price::text AS p FROM plans`)).rows.map((r) => [r.code, r.p]));
for (const [plan, price] of Object.entries(PRICES)) {
  await db.query(`SELECT platform_set_plan_price($1, $2, 'e2e', 'billing E2E prices')`, [plan, price]);
}

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9356 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const text = () => evaluate('document.body.innerText');
const signIn = async (who) => {
  await go('/sign-in');
  await fill('email', who);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);
};
const clickVisible = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getClientRects().length)?.click()`);

try {
  await viewport(1440, 900);
  await signIn(email);
  await go('/subscription');
  // Lower-cased: prices are drawn in the serial style (innerText follows text-transform).
  const lower = async () => (await text()).toLowerCase();
  await shown('Choose a plan', 8000);
  const plansText = await lower();
  check('Plan lists the three plans with their monthly price', ['₱999.00 a month', '₱2,499.00 a month', '₱5,999.00 a month'].every((p) => plansText.includes(p)));
  check('the trial’s plan is marked “Your plan”', await evaluate(`[...document.querySelectorAll('[data-testid="plan-offers"] li')].find((li) => li.innerText.includes('Growth'))?.innerText.includes('Your plan')`));
  check('Bills says there are none yet', (await text()).includes('No bills yet'));
  check('the old “billing is coming” note is gone', !(await text()).includes('Online billing (PayMongo) is coming'));
  await shot('billing-plans-1440.png', false);

  await clickVisible('button[data-plan="growth"]');
  check('choosing Growth issues bill B-000001 with a Pay button', await shown('B-000001', 8000) && (await evaluate(`!!document.querySelector('button[data-bill]')`)));
  check('the bill reads Unpaid and ₱2,499.00, VAT included ₱267.75', (await text()).includes('Unpaid') && (await text()).includes('₱2,499.00') && (await text()).includes('VAT included: ₱267.75'));
  check('the help says to pay the full amount', (await text()).includes('a part payment does not settle a bill'));
  check('no reminder above the page while the bill is due in two weeks', !(await evaluate(`!!document.querySelector('[data-testid="bill-due-link"]')`)));
  // Stage the bill as due in two days (its dates are fixed by a guard: off for this one update, as the migrator).
  const tenantId = (await db.query(`SELECT tenant_id FROM platform_subscription_of($1)`, [slug])).rows[0].tenant_id;
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  await db.query('ALTER TABLE billing_bills DISABLE TRIGGER billing_bills_guard');
  await db.query(`UPDATE billing_bills SET due_at = now() + interval '2 days' WHERE status = 'OPEN'`);
  await db.query('ALTER TABLE billing_bills ENABLE TRIGGER billing_bills_guard');
  await db.query('COMMIT');
  await go('/');
  check('due in two days: every page reminds the owner, with a link to pay', await waitFor(`!!document.querySelector('[data-testid="bill-due-link"]')`, 8000).then(() => true, () => false) && (await text()).includes('Bill B-000001 (₱2,499.00, VAT included) is due'));
  await shot('billing-reminder-1440.png', false);
  await go('/subscription');
  await waitFor(`!!document.querySelector('button[data-bill]')`, 8000);
  await shot('billing-bill-open-1440.png', false);

  await clickVisible('button[data-bill]');
  check('Pay opens the payment page', await waitFor(`location.pathname === '/v1/billing/dev-checkout'`, 10_000).then(() => true, () => false));
  await shot('billing-dev-checkout.png', false);
  await evaluate(`document.querySelector('#dev-pay').click()`);
  await waitFor(`location.pathname === '/subscription' && location.search.includes('paid=B-000001')`, 15_000);
  check('back on Plan: “The payment for B-000001 is received.”', await shown('The payment for B-000001 is received.', 8000));
  const after = await lower();
  check('the bill reads Paid, and the plan Active with its paid-until date', /paid \w/.test(after) && after.includes('active') && after.includes('paid until'));
  check('no Pay button is left, and no reminder above the page', !(await evaluate(`!!document.querySelector('button[data-bill]') || !!document.querySelector('[data-testid="bill-due-link"]')`)));
  await shot('billing-paid-1440.png', false);
  const receiptLink = await evaluate(`[...document.querySelectorAll('a[data-receipt]')].find((a) => a.getClientRects().length)?.getAttribute('href') ?? ''`);
  check('the paid bill links its receipt (Receipt R-…)', /^\/subscription\/receipts\/[0-9a-f-]{36}$/.test(receiptLink) && /Receipt R-\d{8}/.test(await text()));
  await go(receiptLink);
  await shown('VATable sales', 8000);
  const rc = await text();
  check('the receipt: number, Tilvara, the business, VATable sales ₱2,231.25, VAT ₱267.75, total ₱2,499.00, paid by GCash', /Receipt R-\d{8}/.test(rc) && rc.includes('Tilvara') && rc.includes('Tindahan ni Ana') && rc.includes('₱2,231.25') && rc.includes('₱267.75') && rc.includes('₱2,499.00') && rc.includes('Paid by GCash') && rc.includes('System-generated receipt'));
  check('the receipt has Print', await evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Print'))`));
  await shot('billing-receipt-1440.png', false);
  await viewport(390, 844, true);
  check('390px: the receipt has no sideways scroll', await noHorizontalScroll());
  await shot('billing-receipt-390.png', true);
  await viewport(1440, 900);
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  const receiptMail = (await db.query(`SELECT count(*)::int AS n FROM outbox_events o JOIN billing_receipts r ON r.id::text = o.payload->>'receiptId' WHERE o.topic = 'billing.receipt_issued'`)).rows[0].n;
  await db.query('COMMIT');
  check('the receipt is on its way to the owners by mail (one billing.receipt_issued event)', receiptMail === 1);
  await go('/subscription');
  await shown('Bills', 8000);

  await clickText('Stop at the end of the paid period');
  check('Stop: the plan line says when it ends, the button becomes “Keep my subscription”', await shown('Keep my subscription', 8000) && (await lower()).includes('as you asked'));
  await clickText('Keep my subscription');
  check('Keep: back to “Stop at the end…”', await shown('Stop at the end of the paid period', 8000) && !(await lower()).includes('as you asked'));

  await clickVisible('button[data-plan="starter"]');
  check('a cheaper plan starts at the next renewal (note, and “Moves to Starter on …”)', await shown('at the next renewal', 8000) && (await waitFor(`document.body.innerText.toLowerCase().includes('moves to starter on')`, 8000).then(() => true, () => false)));
  // Audit rows are under FORCE RLS: read them in the business's own context.
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  const audit = (await db.query(`SELECT action FROM audit_logs WHERE action LIKE 'billing.%' OR action LIKE 'subscription.%' ORDER BY occurred_at`)).rows.map((r) => r.action);
  await db.query('COMMIT');
  check('the business’s audit log has the bill, the payment and the plan changes', ['billing.bill_issued', 'billing.payment_recorded', 'billing.bill_paid', 'subscription.changed', 'subscription.cancel_requested', 'subscription.resumed', 'subscription.plan_chosen'].every((a) => audit.includes(a)));

  await clickText('FIL');
  await shown('Natanggap na ang bayad', 8000);
  const fil = await lower();
  check('Filipino: bills, the paid bill and the plan chooser', ['mga singil', 'pumili ng plan', 'kada buwan', 'bayad '].every((w) => fil.includes(w)));
  await shot('billing-fil-1440.png', false);
  await clickText('EN');
  await shown('Bills', 8000);

  await viewport(390, 844, true);
  await go('/subscription');
  await shown('Bills', 8000);
  check('390px: no sideways scroll', await noHorizontalScroll());
  await shot('billing-390.png', true);
  await viewport(1440, 900);
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
} finally {
  b.close();
  for (const [plan, price] of Object.entries(before)) {
    await db.query(`SELECT platform_set_plan_price($1, $2, 'e2e', 'billing E2E: prices put back')`, [plan, price]).catch((e) => console.error('could not put the price back', plan, e.message));
  }
  await db.end();
}
finish();
