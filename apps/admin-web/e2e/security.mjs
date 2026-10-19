// End-to-end test of account security in the admin (ADR-0016 slice 1): two-step sign-in set-up with
// the QR code, signing in with a code and with a recovery code, the redirect for a session older than
// the enrolment, the password-reset screens, headers, phone width and Filipino.
// The reset link itself is mailed by DevMailer inside the API process; that flow is covered by
// apps/api/test/integration/account-security.test.ts.
// Usage: node e2e/security.mjs [baseUrl] [screenshotDir] [apiUrl]
import { createHmac } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

// RFC 6238 (SHA-1, 6 digits, 30 s) — what an authenticator app computes.
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
const signup = async (prefix, name) => {
  const slug = `${prefix}-${Date.now().toString(36)}`;
  const email = `${slug}@example.ph`;
  const r = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: name, businessName: `Tindahan ni ${name}`, tenantSlug: slug });
  return { email, token: r.tokens.accessToken };
};
const owner = await signup('sec', 'Lorna');
const second = await signup('sec2', 'Ramon');

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9345 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const clickPrimary = () => evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
const signIn = async (email) => {
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await clickPrimary();
};
const signOut = async () => {
  await evaluate(`fetch('/api/auth/logout', { method: 'POST', headers: { 'x-onepos-request': '1' } })`);
  await sleep(200);
};

try {
  const headers = (await fetch(`${BASE}/sign-in`)).headers;
  check('admin pages carry a CSP that forbids framing and other origins', (headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'") && (headers.get('content-security-policy') ?? '').includes("default-src 'self'"));
  // Scripts by nonce only (session 16): a fresh nonce per response, on every script the page sends.
  const page = async () => {
    const r = await fetch(`${BASE}/sign-in`);
    const policy = r.headers.get('content-security-policy') ?? '';
    return { policy, nonce: /'nonce-([^']+)'/.exec(policy)?.[1], html: await r.text() };
  };
  const [p1, p2] = [await page(), await page()];
  const scripts = [...p1.html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  check('admin scripts run by nonce only: no unsafe-inline for scripts, strict-dynamic', /script-src [^;]*'strict-dynamic'/.test(p1.policy) && !/script-src [^;]*'unsafe-inline'/.test(p1.policy));
  check('a fresh nonce per response, and every script the page sends carries it', Boolean(p1.nonce && p2.nonce && p1.nonce !== p2.nonce) && scripts.length > 0 && scripts.every((s) => s.includes(`nonce="${p1.nonce}"`)));
  const apiHeaders = (await fetch(`${API}/v1/health/live`)).headers;
  check('API answers carry HSTS and a no-content CSP', (apiHeaders.get('strict-transport-security') ?? '').includes('max-age=31536000') && (apiHeaders.get('content-security-policy') ?? '').includes("default-src 'none'"));

  await viewport(1440, 900);
  await signIn(owner.email);
  await waitFor(`document.body.innerText.includes('Overview')`);
  check('a new owner sees the two-step sign-in banner with its date', await shown('Your role requires two-step sign-in from'));
  // The main nav scrolls sideways when it does not fit; at 1440px every tab must fit without scrolling.
  check('1440px band: every nav tab is fully visible (none clipped)', await evaluate(`(() => {
    const nav = document.querySelector('header nav');
    return nav.querySelectorAll('a').length > 10 && nav.scrollWidth <= nav.clientWidth + 1;
  })()`));
  check('the name in the band opens the account page', await evaluate(`[...document.querySelectorAll('header a')].some((a) => a.getAttribute('href') === '/account')`));
  await shot('security-banner.png');

  await evaluate(`[...document.querySelectorAll('a')].find((a) => a.textContent === 'Set it up now').click()`);
  check('security page: status Off, required by the role', await shown('Two-step sign-in') && (await text()).includes('Off') && (await text()).includes('Your role in this business requires it.'));
  await fill('password', 'not my password');
  await clickPrimary();
  check('a wrong password is refused in words', await shown('Your password is not right.'));
  await fill('password', PASSWORD);
  await clickPrimary();
  check('scan step: a QR code and the set-up key', await waitFor(`document.querySelector('svg[role="img"] path') && document.querySelector('[data-testid="mfa-secret"]')`).then(() => true, () => false));
  await shot('security-scan.png');
  const secret = base32(await evaluate(`document.querySelector('[data-testid="mfa-secret"]').textContent`));
  await fill('code', totp(secret, 7));
  await clickPrimary();
  check('a wrong code does not turn it on', await shown('That code is not right.'));
  await fill('code', totp(secret));
  await clickPrimary();
  check('ten recovery codes are shown once', await waitFor(`document.querySelectorAll('[data-testid="recovery-codes"] li').length === 10`).then(() => true, () => false));
  const recovery = await evaluate(`document.querySelector('[data-testid="recovery-codes"] li').textContent`);
  await shot('security-codes.png');
  await clickText('I saved them');
  await waitFor(`document.body.innerText.includes('Overview')`);
  check('back in the back office, the banner is gone', !(await text()).includes('Your role requires two-step sign-in from'));

  await signOut();
  await signIn(owner.email);
  check('sign-in now asks for the code', await shown('Enter your sign-in code'));
  await shot('security-signin-code.png');
  await fill('code', totp(secret, 9));
  await clickPrimary();
  check('a wrong code is refused in words', await shown('That code is not right. Try the newest code from your app.'));
  await fill('code', totp(secret, 1));
  const usedStep = Math.floor(Date.now() / 30_000) + 1;
  await clickPrimary();
  check('the right code opens the back office', await waitFor(`document.body.innerText.includes('Overview')`).then(() => true, () => false));

  await signOut();
  await signIn(owner.email);
  await shown('Enter your sign-in code');
  await clickText('Use a recovery code instead');
  await fill('recoveryCode', recovery);
  await clickPrimary();
  check('a recovery code also signs in', await waitFor(`document.body.innerText.includes('Overview')`).then(() => true, () => false));
  await go('/security');
  check('security page: On, nine recovery codes left, cannot be turned off for this role', await shown('Recovery codes left') && (await text()).includes('9') && (await text()).includes('cannot be turned off'));
  check('a privileged member is offered new recovery codes, not "Turn off"', await shown('New recovery codes') && !(await evaluate(`[...document.querySelectorAll('button')].some((x) => x.textContent === 'Turn off')`)));
  await shot('security-on.png');
  // Each time step works once: wait for a step later than the one spent signing in.
  while (Math.floor(Date.now() / 30_000) + 1 <= usedStep) await sleep(500);
  await fill('password', PASSWORD);
  await fill('code', totp(secret, 1));
  await clickPrimary();
  check('new recovery codes: ten, none of the old ones', await waitFor(`document.querySelectorAll('[data-testid="recovery-codes"] li').length === 10`).then(() => true, () => false)
    && !(await evaluate(`[...document.querySelectorAll('[data-testid="recovery-codes"] li')].map((x) => x.textContent)`)).includes(recovery));
  await clickText('I saved them');
  await waitFor(`document.body.innerText.includes('Overview')`);
  await go('/security');
  check('ten recovery codes left again', await shown('Recovery codes left') && /Recovery codes left\s*10/.test(await text()));

  // A session that began before the enrolment is sent to sign in again.
  await signOut();
  await signIn(second.email);
  await waitFor(`document.body.innerText.includes('Overview')`);
  const started = await call('POST', '/v1/auth/mfa/enroll', second.token, { password: PASSWORD });
  await call('POST', '/v1/auth/mfa/confirm', second.token, { code: totp(base32(started.secret)) });
  await go('/');
  check('an older session is redirected to sign in again', await shown('Sign out and sign in again'));
  await shot('security-reauth.png');

  await signOut();
  await go('/sign-in');
  await clickText('Forgot your password?');
  await waitFor(`document.querySelector('[name="email"]')`);
  await fill('email', 'nobody-at-all@example.ph');
  await clickPrimary();
  check('forgot password answers the same for any email', await shown('If an account uses this email, a link is on its way.'));
  await go('/reset-password?token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  await fill('password', 'a long new passphrase');
  await clickPrimary();
  check('a bad reset link is explained, with a way to ask again', await shown('This link has expired or was already used.') && (await text()).includes('Send the link'));

  await viewport(390, 844, true);
  await signIn(owner.email);
  await shown('Enter your sign-in code');
  check('390px: code step without horizontal scroll', await noHorizontalScroll());
  await shot('security-signin-code-390.png');
  await viewport(1440, 900);
  await clickText('FIL');
  check('Filipino code step', await shown('Ilagay ang sign-in code'));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
