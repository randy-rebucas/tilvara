// End-to-end test of two-step sign-in at the counter (ADR-0016 slice 1): an owner with an
// authenticator app signs in to the POS with a code, after a wrong one, then with a recovery code.
// Usage: node apps/pos-desktop/e2e/mfa.mjs [posUrl] [screenshotDir] [apiUrl]
// Requires the API (RATE_LIMITS_ENABLED=false) and the POS (vite preview) running.
import { createHmac } from 'node:crypto';
import { checklist, openBrowser } from '../../admin-web/e2e/cdp.mjs';
import { client, PASSWORD } from './restaurant.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32 = (text) => {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of text.replace(/\s/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};
const totp = (secret, offset = 0) => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

// --- an owner with a register and two-step sign-in on
const call = client(API);
const slug = `posmfa-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Nena', tenantSlug: slug });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Cubao' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Counter 1' });
const started = await call('POST', '/v1/auth/mfa/enroll', tk, { password: PASSWORD });
const secret = base32(started.secret);
const { recoveryCodes } = await call('POST', '/v1/auth/mfa/confirm', tk, { code: totp(secret) });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9347 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const shown = (s) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`).then(() => true, () => false);
const submit = () => evaluate(`[...document.querySelectorAll('form .btn-primary')].find((e) => e.getClientRects().length).click()`);
const signIn = async () => {
  await go('/');
  await waitFor(`document.querySelector('[name="email"]')`);
  await fill('email', email);
  await fill('password', PASSWORD);
  await submit();
};

try {
  await viewport(1440, 900);
  await signIn();
  check('the counter asks for the code after the password', await shown('type the 6-digit code for 1POS'));
  await shot('mfa-code.png', false);
  await fill('code', totp(secret, 8));
  await submit();
  check('a wrong code is refused in words', await shown('That code is not right.'));
  await fill('code', totp(secret, 1));
  await submit();
  check('the right code opens the register picker', await shown('Counter 1'));

  await viewport(390, 844, true);
  await signIn();
  await shown('type the 6-digit code for 1POS');
  check('390px: code step without horizontal scroll', await noHorizontalScroll());
  await clickText('Use a recovery code instead');
  await fill('recoveryCode', recoveryCodes[0]);
  await submit();
  check('a recovery code also signs in at the counter', await shown('Counter 1'));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
