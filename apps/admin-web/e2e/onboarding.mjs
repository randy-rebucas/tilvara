// End-to-end test of onboarding and support in the admin (ADR-0016 slice 6): the trial's sample
// items, the business's copy of its records (needs the worker running against the same database),
// and support access: the owner gives it, a 1POS staff member opens it read-only, the owner sees
// what was read and ends it. Phone width and Filipino.
// The staff account is added with the ops CLI (DATABASE_MIGRATOR_URL from .env, the dev database
// the API under test uses).
// Usage: node e2e/onboarding.mjs [baseUrl] [screenshotDir] [apiUrl]
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of text.replace(/\s/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, offset = 0) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const call = client(API);
const stamp = Date.now().toString(36);
const ownerEmail = `onb-${stamp}@example.ph`;
await call('POST', '/v1/auth/signup', null, { email: ownerEmail, password: PASSWORD, displayName: 'Marites', businessName: `Kapihan ni Marites ${stamp}`, tenantSlug: `onb-${stamp}` });
// The staff member: an account of their own with two-step sign-in, then added by ops.
const staffEmail = `staff-${stamp}@1pos.example`;
const staff = await call('POST', '/v1/auth/signup', null, { email: staffEmail, password: PASSWORD, displayName: 'Sam Support', businessName: `Support desk ${stamp}`, tenantSlug: `desk-${stamp}` });
const enrol = await call('POST', '/v1/auth/mfa/enroll', staff.tokens.accessToken, { password: PASSWORD });
const staffSecret = base32(enrol.secret);
await call('POST', '/v1/auth/mfa/confirm', staff.tokens.accessToken, { code: totp(staffSecret) });
const ROOT = new URL('../../../', import.meta.url);
execFileSync(process.execPath, ['--env-file=.env', 'packages/database/dist/support-cli.js', 'staff-add', '--email', staffEmail, '--reason', 'E2E support desk', '--actor', 'e2e'], {
  cwd: ROOT,
  stdio: 'inherit',
});

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9347 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
/** Status words and action names are set in small caps by CSS; innerText returns them uppercased. */
const lower = async () => (await text()).toLowerCase();
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const clickPrimary = () => evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
const clickButton = (label) => evaluate(`[...document.querySelectorAll('button')].filter((x) => x.getClientRects().length).find((x) => x.textContent.trim() === ${JSON.stringify(label)}).click()`);
const acceptConfirms = () => evaluate('window.confirm = () => true');
const bff = (method, path, body) => evaluate(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json', 'x-onepos-request': '1', 'idempotency-key': '${randomUUID()}' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
const signIn = async (email, secret) => {
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await clickPrimary();
  if (secret) {
    await shown('Enter your sign-in code');
    await fill('code', totp(secret, 1));
    await clickPrimary();
  }
};
const signOut = async () => {
  await evaluate(`fetch('/api/auth/logout', { method: 'POST', headers: { 'x-onepos-request': '1' } })`);
  await sleep(200);
};

try {
  await viewport(1440, 900);
  // 1. Sample items.
  await signIn(ownerEmail);
  await waitFor(`document.body.innerText.includes('Overview')`);
  check('a new trial business is offered the sample items', await shown('Try it with sample items'));
  await clickButton('Add sample items');
  check('8 labelled sample items are added', await shown('8 sample items are on your list'));
  await shot('onboarding-sample.png');
  await go('/products');
  check('products show them tagged Sample and named “(sample)”', (await text()).includes('Iced coffee 16oz (sample)') && (await evaluate(`[...document.querySelectorAll('.tag')].filter((x) => x.textContent === 'Sample').length`)) === 8);

  // 2. Support access, given by the owner.
  await go('/subscription/support');
  const tabs = await evaluate(`[...document.querySelectorAll('nav[aria-label="Subscription sections"] a')].map((a) => a.textContent)`);
  check('subscription has Plan · Your records · Support access tabs', JSON.stringify(tabs) === JSON.stringify(['Plan', 'Your records', 'Support access']));
  check('the page says support cannot see the business unless allowed', await shown('1POS support cannot see your business unless you allow it here.'));
  await clickText('Give support access');
  await fill('purpose', 'Please check why the sample coffee price shows twice');
  await evaluate(`(() => { const s = document.querySelector('select[name="hours"]'); s.value = '4'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await fill('ticketRef', 'T-2026-77');
  await clickText('Allow read-only access');
  check('the grant is listed open, not used yet, with its ticket', await shown('Not used yet') && (await text()).includes('T-2026-77') && (await lower()).includes('open ·'));
  await shot('onboarding-support-owner.png');

  // 3. A copy of the records (the worker makes it).
  await go('/subscription/export');
  check('the export page explains the copy and the privacy of the file', await shown('Download a copy of everything your business has recorded'));
  await clickButton('Prepare a copy');
  check('the copy is being prepared', await shown('Preparing'));
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(1500);
    await go('/subscription/export');
    ready = (await text()).includes('Ready');
  }
  check('the worker finishes it (Ready, with a checksum)', ready && (await text()).includes('Checksum (SHA-256)'));
  await shot('onboarding-export.png');
  const dl = await evaluate(`(async () => {
    const exports = await (await fetch('/api/v1/data-exports')).json();
    const id = exports.data.find((e) => e.status === 'READY').id;
    const link = await (await fetch('/api/v1/data-exports/' + id + '/link', { method: 'POST', headers: { 'x-onepos-request': '1' } })).json();
    const r = await fetch('/api' + link.url);
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type'), pk: bytes[0] === 0x50 && bytes[1] === 0x4b, size: bytes.length, expected: exports.data.find((e) => e.id === id).sizeBytes, disposition: r.headers.get('content-disposition') };
  })()`);
  check('the download through the back office is the exact ZIP (bytes, size, file name)', dl.status === 200 && dl.type === 'application/zip' && dl.pk && dl.size === dl.expected && /attachment; filename="1pos-export-/.test(dl.disposition ?? ''));

  // 4. The staff member opens it, read-only.
  await signOut();
  await signIn(staffEmail, staffSecret);
  await waitFor(`document.body.innerText.includes('Overview')`);
  await go('/support');
  check('staff see the business that asked, with its purpose', await shown(`Kapihan ni Marites ${stamp}`) && (await text()).includes('Please check why the sample coffee price shows twice'));
  await shot('onboarding-staff-list.png');
  await evaluate(`[...document.querySelectorAll('.note')].find((n) => n.innerText.includes(${JSON.stringify(`Kapihan ni Marites ${stamp}`)})).querySelector('button').click()`);
  check('the support view shows a read-only banner naming the business', await shown('Support view of') && (await text()).includes(`Kapihan ni Marites ${stamp}`) && (await text()).includes('read-only'));
  await shot('onboarding-staff-view.png');
  await go('/products');
  check('staff can read the products', await shown('Iced coffee 16oz (sample)'));
  const write = await bff('POST', '/api/v1/categories', { name: 'Support was here' });
  check('a write from the support view is refused (SUPPORT_READ_ONLY)', write.status === 403 && write.body?.error?.code === 'SUPPORT_READ_ONLY');
  await viewport(390, 844, true);
  await go('/');
  check('390px: the support banner fits without horizontal scroll', await noHorizontalScroll());
  await viewport(1440, 900);
  await clickText('Leave support view');
  check('leaving returns to the support page', await shown('Support requests'));
  await signOut();

  // 5. The owner sees the use and ends it.
  await signIn(ownerEmail);
  await waitFor(`document.body.innerText.includes('Overview')`);
  await go('/subscription/support');
  check('the owner sees it was opened, by whom, and the refused change', await shown('Opened 1×') && (await text()).includes('Sam Support') && (await text()).includes('1 changes refused'));
  await acceptConfirms();
  await clickButton('End access now');
  await sleep(800);
  check('ending it marks it Ended', (await lower()).includes('ended ·'));
  await go('/audit?action=support');
  check('the audit log lists support steps by the staff member', await shown('(1POS support)') && (await lower()).includes('support.session_opened'));
  await shot('onboarding-audit.png');

  // 6. Sample items removed; phone width; Filipino.
  await go('/');
  await acceptConfirms();
  await clickButton('Remove sample items');
  await sleep(800);
  await go('/products');
  check('removing the sample items empties the list', !(await text()).includes('(sample)'));
  await viewport(390, 844, true);
  for (const path of ['/subscription/support', '/subscription/export']) {
    await go(path);
    check(`390px: ${path} without horizontal scroll`, await noHorizontalScroll());
  }
  await shot('onboarding-support-390.png');
  await viewport(1440, 900);
  await clickText('FIL');
  await go('/subscription/support');
  check('Filipino: support access page', await shown('Access ng support') && (await text()).includes('Hindi makikita ng 1POS support'));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
