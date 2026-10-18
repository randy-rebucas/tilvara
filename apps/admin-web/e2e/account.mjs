// End-to-end test of a person's own account in the admin (privacy pack, ADR-0016 slice 8 follow-up):
// the band link, correcting one's name, asking for a new sign-in email (the link itself is mailed by
// DevMailer inside the API process, so the test plants a known token), the confirm-email screen
// (a link opened while signed in as someone else keeps that browser signed in; the same account's
// own browser is signed out), closing the account (refused while still in a business, then done), phone
// width and Filipino. Last, the error reference: a second `next start` against a stub API that
// answers 500 shows the API's correlation id on the error page and in a form error.
// A person who no longer belongs to any business is arranged in the dev database as the migrator
// (DATABASE_MIGRATOR_URL from .env), as invitation links never leave the API process.
// Usage: node apps/admin-web/e2e/account.mjs [baseUrl] [screenshotDir] [apiUrl]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const STUB_ADMIN_PORT = 3398;

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const pg = createRequire(new URL('../../../packages/database/package.json', import.meta.url))('pg');

const call = client(API);
const stamp = Date.now().toString(36);
const signup = async (prefix, name, business) => {
  const email = `${prefix}-${stamp}@example.ph`;
  const r = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: name, businessName: business, tenantSlug: `${prefix}-${stamp}` });
  return { email, userId: r.user.id, tenantId: r.activeTenantId };
};
// A long business name on purpose: the band must still fit every tab at 1440px.
const BUSINESS = `Sari-sari Store at Karinderya ni Aling Lorna sa Kanto ng Mabini ${stamp}`;
const owner = await signup('acct', 'Lorna Reyes', BUSINESS);
// Arrange: Ramon has an account but belongs to no business (as after an owner removed him; a
// business itself can never lose its last owner). Hashed by the API's own PasswordService.
const leaver = { email: `leave-${stamp}@example.ph` };
{
  const { PasswordService } = await import('../../api/dist/auth/password.service.js');
  const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  await db.connect();
  await db.query('SELECT auth_register_user($1, $2, $3)', [leaver.email, 'Ramon Cruz', await new PasswordService().hash(PASSWORD)]);
  await db.end();
}

// The confirm link is mailed inside the API process: give the newest pending link a token we know.
const plantEmailLink = async (userId) => {
  const { createHash, randomBytes } = await import('node:crypto');
  const token = randomBytes(32).toString('base64url');
  const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE onepos_platform');
    const r = await db.query('UPDATE email_change_tokens SET token_hash = $2 WHERE user_id = $1 AND used_at IS NULL', [userId, createHash('sha256').update(token).digest('hex')]);
    if (r.rowCount !== 1) throw new Error(`expected one pending email link, found ${r.rowCount}`);
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
  return token;
};

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9347 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, bff, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const clickPrimary = () => evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
const signIn = async (email) => {
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await clickPrimary();
};
const formOf = (heading) => `[...document.querySelectorAll('form')].find((f) => f.querySelector('h2')?.textContent.includes(${JSON.stringify(heading)}))`;

try {
  await viewport(1440, 900);
  await signIn(owner.email);
  await waitFor(`location.pathname === '/'`);
  check('the name in the band opens the account page', await evaluate(`[...document.querySelectorAll('header a')].some((a) => a.getAttribute('href') === '/account')`));
  check('1440px with a long business name: every tab fits without scrolling, the full name is in the tooltip', await evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label="Main"]');
    const link = [...document.querySelectorAll('header a')].find((a) => a.getAttribute('href') === '/account');
    return nav.querySelectorAll('a').length > 10 && nav.scrollWidth <= nav.clientWidth + 1 && link.title.includes(${JSON.stringify(BUSINESS)});
  })()`));
  await shot('account-band-long-name.png', false);
  check('setup checklist: a new business has a First sale step, not yet done', await evaluate(`(() => {
    const li = [...document.querySelectorAll('aside li')].find((x) => x.textContent.includes('First sale'));
    return Boolean(li) && !li.querySelector('[aria-label="Done"]');
  })()`));

  await go('/account');
  check('account page: name, email and two-step sign-in status', await shown('Your account') && (await text()).includes(owner.email) && (await text()).includes('Lorna Reyes') && (await text()).includes('Manage two-step sign-in'));
  check('an owner cannot close the account while in the business, and is told which one', (await text()).includes('You still belong to these businesses') && (await text()).includes(BUSINESS));
  check('no close button while closing is refused', await evaluate(`![...document.querySelectorAll('button')].some((x) => x.textContent.includes('Close my account'))`));
  await shot('account.png');

  // Name.
  await fill('displayName', 'Lorna R. Reyes');
  await clickText('Save');
  check('the corrected name is saved', await shown('Your name is saved.'));
  await go('/');
  check('…and shown in the back office band', (await evaluate(`document.querySelector('header').innerText`)).includes('Lorna R. Reyes'));
  await go('/account');
  check('…and on the account page after a reload', (await evaluate(`document.querySelector('[data-testid="account-name"]').textContent`)) === 'Lorna R. Reyes');

  // Email.
  const newEmail = `acct-moved-${stamp}@example.ph`;
  await fill('newEmail', newEmail);
  await fill('password', 'not my password at all');
  await clickText('Send the link');
  check('a wrong password is refused in words', await shown('Your password is not right.'));
  await fill('newEmail', owner.email);
  await fill('password', PASSWORD);
  await clickText('Send the link');
  check('the current address is refused', await shown('This is already your sign-in email.'));
  await fill('newEmail', newEmail);
  await clickText('Send the link');
  check('a link is sent to the new address; the email does not change yet', await shown(`Open the link we sent to ${newEmail}`) && (await evaluate(`document.querySelector('[data-testid="account-email"]').textContent`)) === owner.email);
  await shot('account-email-sent.png');

  await go('/confirm-email?token=' + 'x'.repeat(43));
  await clickText('Use this email');
  check('a bad confirm link is explained, with the way back to the account page', await shown('This link has expired or was already used.') && await evaluate(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/account')`));
  await go('/confirm-email');
  check('a confirm link without its token is explained', await shown('This link is incomplete.'));

  // Lorna's link opened in a browser signed in as Ramon: Lorna's sessions end, Ramon's stays.
  await bff('POST', '/api/auth/logout');
  await signIn(leaver.email);
  await waitFor(`location.pathname === '/select-business'`).catch(() => undefined);
  await go(`/confirm-email?token=${await plantEmailLink(owner.userId)}`);
  await clickText('Use this email');
  check('a link opened while signed in as someone else confirms the change', await shown('Your sign-in email is changed'));
  await go('/account');
  check('…and that browser stays signed in as its own account', await shown('Your account') && (await evaluate(`document.querySelector('[data-testid="account-email"]').textContent`)) === leaver.email);
  // Lorna, now on the new address, moves again and opens the link in her own browser: signed out.
  await bff('POST', '/api/auth/logout');
  await signIn(newEmail);
  await waitFor(`location.pathname === '/'`);
  await go('/account');
  await fill('newEmail', `acct-again-${stamp}@example.ph`);
  await fill('password', PASSWORD);
  await clickText('Send the link');
  await shown('Open the link we sent to');
  await go(`/confirm-email?token=${await plantEmailLink(owner.userId)}`);
  await clickText('Use this email');
  await shown('Your sign-in email is changed');
  await go('/account');
  check('the same account opening its own link is signed out', await waitFor(`location.pathname === '/sign-in'`).then(() => true, () => false));
  await signIn(`acct-again-${stamp}@example.ph`);
  await waitFor(`location.pathname === '/'`);

  // Phone width and Filipino.
  await go('/account');
  await viewport(390, 844, true);
  await sleep(300);
  check('390px: the account page has no horizontal scroll', await noHorizontalScroll());
  await shot('account-390.png');
  await go('/');
  check('390px with a long business name: the wordmark and the account link share the first line (the name is cut)', await evaluate(`(() => {
    const row = document.querySelector('header').firstElementChild;
    const mark = row.querySelector('a[href="/"]').getBoundingClientRect();
    const link = [...row.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/account');
    const acct = link.getBoundingClientRect();
    const lang = Math.max(...[...row.querySelectorAll('button')].filter((x) => ['EN', 'FIL'].includes(x.textContent.trim())).map((x) => x.getBoundingClientRect().right));
    const names = [...link.querySelectorAll('span')].map((s) => s.getBoundingClientRect());
    return Math.abs((mark.top + mark.bottom) / 2 - (acct.top + acct.bottom) / 2) < 8 && acct.right <= innerWidth && names.every((n) => n.left >= lang);
  })()`));
  await shot('account-band-390.png', false);
  await viewport(1440, 900);
  await bff('POST', '/api/auth/lang', { lang: 'fil' });
  await go('/account');
  check('Filipino: the account page', await shown('Iyong account') && (await text()).includes('Palitan ang sign-in email') && (await text()).includes('Kabilang ka pa sa mga negosyong ito'));
  await shot('account-fil.png');
  await bff('POST', '/api/auth/lang', { lang: 'en' });
  await bff('POST', '/api/auth/logout');

  // Closing an account that belongs to no business.
  await signIn(leaver.email);
  await waitFor(`location.pathname === '/select-business'`).catch(() => undefined);
  await go('/account');
  check('someone in no business sees the close form', await shown('Close your account') && await evaluate(`[...document.querySelectorAll('button')].some((x) => x.textContent.includes('Close my account'))`));
  check('the close button waits for the confirmation box', await evaluate(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('Close my account')).disabled`));
  await evaluate(`${formOf('Close your account')}.querySelector('[name="password"]').focus()`);
  await evaluate(`(() => { const el = ${formOf('Close your account')}.querySelector('[name="password"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(PASSWORD)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`${formOf('Close your account')}.querySelector('input[type="checkbox"]').click()`);
  await shot('account-close.png');
  await clickText('Close my account');
  check('closing signs out and says so', await shown('Your account is closed. You have been signed out.') && (await evaluate('location.pathname')) === '/sign-in');
  await signIn(leaver.email);
  check('the closed account cannot sign in', await shown('Email or password is incorrect.'));
  await shot('account-closed.png');
  b.close();

  // The error reference, against a stub API that fails every request with a known correlation id.
  const REF = `e2e-corr-${stamp}`;
  const stub = createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'x-correlation-id': REF });
    res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'An unexpected error occurred.', correlationId: REF } }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const admin = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(STUB_ADMIN_PORT), '-H', '127.0.0.1'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ONEPOS_API_URL: `http://127.0.0.1:${stub.address().port}/v1` },
    stdio: 'ignore',
  });
  try {
    const stubBase = `http://127.0.0.1:${STUB_ADMIN_PORT}`;
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${stubBase}/sign-in`).then((r) => r.ok, () => false)) break;
      await sleep(500);
    }
    const s = await openBrowser({ base: stubBase, out: OUT, port: 9348 });
    try {
      await s.send('Network.enable');
      await s.send('Network.setCookie', { name: 'onepos_at', value: 'stub-token', url: stubBase });
      await s.go('/');
      const ref = await s.waitFor(`document.querySelector('[data-testid="error-reference"]')`).then(() => s.evaluate(`document.querySelector('[data-testid="error-reference"]').innerText`), () => null);
      check('a page that fails on the API shows the API correlation id as its reference', ref === REF);
      check('…with a way to try again', await s.evaluate(`document.body.innerText.includes('This page could not be shown') && document.body.innerText.includes('Try again')`));
      await s.shot('error-reference.png');
      await s.send('Network.deleteCookies', { name: 'onepos_at', url: stubBase });
      await s.go('/sign-in');
      await s.fill('email', 'someone@example.ph');
      await s.fill('password', PASSWORD);
      await s.evaluate(`[...document.querySelectorAll('form button.btn-primary')].at(-1).click()`);
      check('a form whose request fails on the server shows the reference too', await s.waitFor(`document.body.innerText.includes('Reference: ${REF}')`).then(() => true, () => false));
    } finally {
      s.close();
    }
  } finally {
    admin.kill();
    stub.close();
  }
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
