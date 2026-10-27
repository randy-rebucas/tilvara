import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, PASSWORD, signup, uniq } from './helpers.js';

/** Branding (session 39): settings, images, /me, the till's snapshot, receipts and the public sign-in page. */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
const code = (res: request.Response) => res.body.error?.code as string | undefined;

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** A JPEG's head: SOI, an APP0 segment, then a baseline frame 300 wide and 200 high. */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.from([0xff, 0xd9]),
]);
const b64 = (b: Buffer) => b.toString('base64');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, tradeName: 'Tindahan', vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'R1' }).expect(201)).body.id as string;
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const cashier = bearer(await loginToken(app, c.email));
  return { ...t, auth, branchId, registerId, cashier };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const sql = <T = Record<string, unknown>>(s: Shop, q: string, params: unknown[] = []) =>
  asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(q, params)).rows as T[]);

const SETTINGS = {
  displayName: 'Tindahan ni Aling Nena',
  brandColor: '#7A1F3D',
  receiptHeader: 'Bukas araw-araw',
  receiptFooter: 'Salamat po!\nReturns within 7 days with this slip',
  contactPhone: '+63 917 123 4567',
  contactEmail: 'Shop@Example.ph',
  website: 'nena.example.ph',
  facebook: '@TindahanNiNena',
  instagram: 'nena.store',
  displayWelcome: 'Maligayang pagdating!',
  displayThanks: 'Salamat, balik po kayo!',
  publicSignIn: false,
};

describe('branding settings', () => {
  it('starts as Tilvara’s look; every member reads it; only tenant.manage changes it (audited by field name)', async () => {
    const s = await shop('brand-set');
    const empty = (await http().get('/v1/business/branding').set(s.cashier).expect(200)).body;
    expect(empty).toMatchObject({ displayName: null, brandColor: null, logo: null, background: null, publicSignIn: false, updatedAt: null });
    expect((await http().get('/v1/me').set(s.auth).expect(200)).body.activeTenant.branding).toEqual({ displayName: null, brandColor: null, logoSha256: null, backgroundSha256: null });

    expect(code(await http().put('/v1/business/branding').set(s.cashier).send(SETTINGS).expect(403))).toBe('FORBIDDEN');
    const saved = (await http().put('/v1/business/branding').set(s.auth).send(SETTINGS).expect(200)).body;
    expect(saved).toMatchObject({
      displayName: 'Tindahan ni Aling Nena', brandColor: '#7a1f3d', contactEmail: 'shop@example.ph',
      website: 'https://nena.example.ph', facebook: 'TindahanNiNena', instagram: 'nena.store',
      receiptFooter: 'Salamat po!\nReturns within 7 days with this slip',
    });
    expect((await http().get('/v1/me').set(s.cashier).expect(200)).body.activeTenant.branding).toMatchObject({ displayName: 'Tindahan ni Aling Nena', brandColor: '#7a1f3d' });

    // The same settings again record nothing; blanks clear a field.
    await http().put('/v1/business/branding').set(s.auth).send(SETTINGS).expect(200);
    const cleared = (await http().put('/v1/business/branding').set(s.auth).send({ ...SETTINGS, instagram: '', receiptHeader: '  ' }).expect(200)).body;
    expect(cleared).toMatchObject({ instagram: null, receiptHeader: null });
    const audits = await sql<{ metadata: { fields: string[] } }>(s, `SELECT metadata FROM audit_logs WHERE action = 'tenant.branding_updated' ORDER BY occurred_at`);
    expect(audits.map((a) => a.metadata.fields)).toEqual([
      ['displayName', 'brandColor', 'receiptHeader', 'receiptFooter', 'contactPhone', 'contactEmail', 'website', 'facebook', 'instagram', 'displayWelcome', 'displayThanks'],
      ['receiptHeader', 'instagram'],
    ]);
    // Never the values: the contact details may be the owner's own.
    expect(JSON.stringify(audits)).not.toContain('917');
  });

  it('refuses a colour white text cannot be read on, and bad contact details', async () => {
    const s = await shop('brand-bad');
    for (const bad of [
      { brandColor: '#ffff00' }, { brandColor: 'red' }, { website: 'javascript:alert(1)' }, { website: 'ftp://x.example' },
      { facebook: 'facebook.com/x y' }, { contactEmail: 'nope' }, { receiptFooter: 'a\nb\nc\nd' }, { displayName: 'x'.repeat(41) },
    ]) {
      expect(code(await http().put('/v1/business/branding').set(s.auth).send({ ...SETTINGS, ...bad }).expect(400)), JSON.stringify(bad)).toBe('VALIDATION_FAILED');
    }
    expect(await sql(s, 'SELECT * FROM tenant_branding')).toEqual([]);
  });

  it('a change bumps the catalog version, so tills fetch it', async () => {
    const s = await shop('brand-ver');
    const version = async () => Number((await sql<{ v: string }>(s, 'SELECT coalesce(max(version), 0)::text AS v FROM catalog_versions'))[0]!.v);
    const before = await version();
    await http().put('/v1/business/branding').set(s.auth).send(SETTINGS).expect(200);
    expect(await version()).toBeGreaterThan(before);
  });
});

describe('brand images', () => {
  it('takes a PNG, JPEG or WebP (read from the bytes), serves it, replaces and removes it', async () => {
    const s = await shop('brand-img');
    const set = await http().put('/v1/business/branding/logo').set(s.auth).send({ data: b64(PNG) }).expect(200);
    expect(set.body.logo).toEqual({ sha256: sha(PNG), contentType: 'image/png', width: 1, height: 1, sizeBytes: PNG.length });
    const got = await http().get('/v1/business/branding/logo').set(s.cashier).buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    }).expect(200);
    expect(Buffer.compare(got.body as Buffer, PNG)).toBe(0);
    expect(got.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff', etag: `"${sha(PNG)}"` });
    expect((await http().get('/v1/me').set(s.auth).expect(200)).body.activeTenant.branding.logoSha256).toBe(sha(PNG));

    // A replacement deletes the image it replaces.
    const jpeg = (await http().put('/v1/business/branding/logo').set(s.auth).send({ data: b64(JPEG) }).expect(200)).body.logo;
    expect(jpeg).toMatchObject({ contentType: 'image/jpeg', width: 300, height: 200 });
    expect(await sql(s, 'SELECT kind, sha256 FROM brand_assets')).toEqual([{ kind: 'LOGO', sha256: sha(JPEG) }]);
    await http().put('/v1/business/branding/background').set(s.auth).send({ data: b64(PNG) }).expect(200);

    // Removing it leaves the background alone; removing nothing is no change.
    const removed = (await http().put('/v1/business/branding/logo').set(s.auth).send({ data: null }).expect(200)).body;
    expect(removed).toMatchObject({ logo: null, background: { sha256: sha(PNG) } });
    await http().put('/v1/business/branding/logo').set(s.auth).send({ data: null }).expect(200);
    expect(code(await http().get('/v1/business/branding/logo').set(s.auth).expect(404))).toBe('NOT_FOUND');
    expect(await sql(s, 'SELECT kind FROM brand_assets')).toEqual([{ kind: 'BACKGROUND' }]);
    const actions = await sql<{ action: string; metadata: { kind: string } }>(s, `SELECT action, metadata FROM audit_logs WHERE action LIKE 'tenant.branding_image%' ORDER BY occurred_at`);
    expect(actions.map((a) => `${a.action} ${a.metadata.kind}`)).toEqual([
      'tenant.branding_image_set LOGO', 'tenant.branding_image_set LOGO', 'tenant.branding_image_set BACKGROUND', 'tenant.branding_image_removed LOGO',
    ]);
  });

  it('refuses SVG and other files, images over the limit, and anyone without tenant.manage', async () => {
    const s = await shop('brand-refuse');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    expect(code(await http().put('/v1/business/branding/logo').set(s.auth).send({ data: b64(svg) }).expect(422))).toBe('IMAGE_INVALID');
    expect(code(await http().put('/v1/business/branding/logo').set(s.auth).send({ data: b64(Buffer.from('GIF89a')) }).expect(422))).toBe('IMAGE_INVALID');
    expect(code(await http().put('/v1/business/branding/logo').set(s.auth).send({ data: '' }).expect(422))).toBe('IMAGE_INVALID');
    expect(code(await http().put('/v1/business/branding/logo').set(s.auth).send({ data: 'not base64!' }).expect(400))).toBe('VALIDATION_FAILED');
    // A 300 KB logo is over 256 KB; the same bytes are a fine background (up to 1 MB).
    const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024 - PNG.length)]);
    expect(code(await http().put('/v1/business/branding/logo').set(s.auth).send({ data: b64(big) }).expect(422))).toBe('IMAGE_TOO_LARGE');
    expect((await http().put('/v1/business/branding/background').set(s.auth).send({ data: b64(big) }).expect(200)).body.background.sizeBytes).toBe(big.length);
    const huge = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    expect([400, 413, 422]).toContain((await http().put('/v1/business/branding/background').set(s.auth).send({ data: b64(huge) })).status);
    expect(code(await http().put('/v1/business/branding/logo').set(s.cashier).send({ data: b64(PNG) }).expect(403))).toBe('FORBIDDEN');
    expect(await sql(s, 'SELECT kind FROM brand_assets')).toEqual([{ kind: 'BACKGROUND' }]);
  });
});

describe('branding on the till and receipts', () => {
  it('the snapshot carries the look and receipt lines; the terminal fetches the images; receipts print the messages', async () => {
    const s = await shop('brand-till');
    await http().put('/v1/business/branding').set(s.auth).send(SETTINGS).expect(200);
    await http().put('/v1/business/branding/logo').set(s.auth).send({ data: b64(PNG) }).expect(200);
    const res = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.registerId, name: 'Till' }).expect(201)).body;
    const headers = { 'x-terminal-id': res.terminal.id, Authorization: `Terminal ${res.credential}` };
    const snap = (await http().get('/v1/terminal/snapshot').set(headers).expect(200)).body;
    expect(snap.branding).toEqual({
      displayName: 'Tindahan ni Aling Nena', brandColor: '#7a1f3d', logoSha256: sha(PNG), backgroundSha256: null,
      displayWelcome: 'Maligayang pagdating!', displayThanks: 'Salamat, balik po kayo!',
      receipt: {
        header: ['Bukas araw-araw'],
        footer: ['Salamat po!', 'Returns within 7 days with this slip'],
        contact: ['+63 917 123 4567', 'shop@example.ph', 'nena.example.ph', 'facebook.com/TindahanNiNena', 'instagram.com/nena.store'],
      },
    });
    const logo = await http().get('/v1/terminal/branding/logo').set(headers).expect(200);
    expect(logo.headers['content-type']).toBe('image/png');
    await http().get('/v1/terminal/branding/logo').expect(401);
    expect(code(await http().get('/v1/terminal/branding/background').set(headers).expect(404))).toBe('NOT_FOUND');

    // An online sale's receipt: the legal names stay; the messages and contact lines come with it.
    const vat = ((await http().get('/v1/tax-categories').set(s.auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
    const pc = ((await http().get('/v1/uoms').set(s.auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
    const variantId = (await http().post('/v1/products').set(s.auth).send({ name: 'Cola', uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SKU'), price: '20.00' }] }).expect(201)).body.variants[0].id;
    await http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Opening', items: [{ variantId, quantity: '5', unitCost: '10.00' }] }).expect(201);
    const session = (await http().post('/v1/cashier-sessions').set(s.cashier).send({ registerId: s.registerId, openingFloat: '500.00' }).expect(201)).body;
    const sale = (await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: session.id, clientTransactionId: randomUUID(), lines: [{ variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '50.00' }] }).expect(201)).body;
    const receipt = (await http().get(`/v1/sales/${sale.id}/receipt`).set(s.cashier).expect(200)).body;
    expect(receipt.seller).toMatchObject({ name: 'Tindahan', registeredName: 'brand-till Corp' });
    expect(receipt.branding).toEqual({ ...snap.branding.receipt, logoSha256: sha(PNG) });
  });
});

describe('public sign-in page', () => {
  it('shows nothing until the business switches it on, then its name, colour and images only', async () => {
    const s = await shop('brand-pub');
    const slug = ((await http().get('/v1/business').set(s.auth).expect(200)).body.slug) as string;
    expect(code(await http().get(`/v1/public/shops/${slug}`).expect(404))).toBe('NOT_FOUND');
    await http().put('/v1/business/branding').set(s.auth).send(SETTINGS).expect(200);
    await http().put('/v1/business/branding/background').set(s.auth).send({ data: b64(JPEG) }).expect(200);
    expect(code(await http().get(`/v1/public/shops/${slug}`).expect(404))).toBe('NOT_FOUND');
    expect(code(await http().get(`/v1/public/shops/${slug}/background`).expect(404))).toBe('NOT_FOUND');

    await http().put('/v1/business/branding').set(s.auth).send({ ...SETTINGS, publicSignIn: true }).expect(200);
    expect((await http().get(`/v1/public/shops/${slug}`).expect(200)).body).toEqual({
      tenantId: s.tenantId, name: 'Tindahan ni Aling Nena', brandColor: '#7a1f3d', logoSha256: null, backgroundSha256: sha(JPEG),
    });
    const bg = await http().get(`/v1/public/shops/${slug}/background`).expect(200);
    expect(bg.headers).toMatchObject({ 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' });
    expect(code(await http().get(`/v1/public/shops/${slug}/logo`).expect(404))).toBe('NOT_FOUND');
    expect(code(await http().get(`/v1/public/shops/${uniq('nobody')}`).expect(404))).toBe('NOT_FOUND');
    expect(code(await http().get('/v1/public/shops/Not_A_Slug').expect(400))).toBe('VALIDATION_FAILED');
  });

  it('hands a sign-in over to the business’s own address once, for that business only (session 41)', async () => {
    const s = await shop('brand-hand');
    const other = await shop('brand-hand-x');
    expect(code(await http().post('/v1/auth/handoff').set(s.auth).expect(409))).toBe('NO_OWN_ADDRESS');
    await http().put('/v1/business/branding').set(s.auth).send({ ...SETTINGS, publicSignIn: true }).expect(200);
    const slug = ((await http().get('/v1/business').set(s.auth).expect(200)).body.slug) as string;

    const h = await http().post('/v1/auth/handoff').set(s.auth).expect(200);
    expect(h.body).toMatchObject({ tenantSlug: slug, code: expect.any(String) });
    expect(new Date(h.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    // Not for another business: refused, and the code is spent with it (bound to its business, 0126).
    const h2 = await http().post('/v1/auth/handoff').set(s.auth).expect(200);
    expect(code(await http().post('/v1/auth/refresh').send({ refreshToken: h2.body.code, tenantId: other.tenantId }).expect(401))).toBe('INVALID_REFRESH_TOKEN');
    expect(code(await http().post('/v1/auth/refresh').send({ refreshToken: h2.body.code, tenantId: s.tenantId }).expect(401))).toBe('INVALID_REFRESH_TOKEN');

    const r = await http().post('/v1/auth/refresh').send({ refreshToken: h.body.code, tenantId: s.tenantId }).expect(200);
    expect(r.body.activeTenantId).toBe(s.tenantId);
    const me = await http().get('/v1/me').set(bearer(r.body.tokens.accessToken)).expect(200);
    expect(me.body.activeTenant.tenantId).toBe(s.tenantId);
    // A second use is refresh-token reuse: refused, and the session it opened ends with it.
    expect(code(await http().post('/v1/auth/refresh').send({ refreshToken: h.body.code, tenantId: s.tenantId }).expect(401))).toBe('INVALID_REFRESH_TOKEN');
    expect(code(await http().post('/v1/auth/refresh').send({ refreshToken: r.body.tokens.refreshToken, tenantId: s.tenantId }).expect(401))).toBe('INVALID_REFRESH_TOKEN');
    const audit = await sql<{ action: string }>(s, "SELECT action FROM audit_logs WHERE tenant_id = $1 AND action = 'auth.handoff'", [s.tenantId]);
    expect(audit).toHaveLength(2);
  });

  it('a hand-off serves its own business only, even for someone in two, and ends with the session that made it (2026-10-27)', async () => {
    const s = await shop('brand-bound');
    const second = await shop('brand-bound-2');
    await http().put('/v1/business/branding').set(s.auth).send({ ...SETTINGS, publicSignIn: true }).expect(200);
    // The owner of s is also on the team of a second business.
    await asOwnerInTenant(owner, second.tenantId, (c) => c.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2)', [second.tenantId, s.userId]));
    const login = (await http().post('/v1/auth/login').send({ email: s.email, password: PASSWORD, tenantId: s.tenantId }).expect(200)).body;
    const main = bearer(login.tokens.accessToken);

    // Redeemed without naming a business, the code is still its own business's.
    const h = (await http().post('/v1/auth/handoff').set(main).expect(200)).body;
    const r = (await http().post('/v1/auth/refresh').send({ refreshToken: h.code }).expect(200)).body;
    expect(r.activeTenantId).toBe(s.tenantId);
    // Its session cannot be taken to the person's other business: by refresh (it ends) …
    const r2 = (await http().post('/v1/auth/refresh').send({ refreshToken: r.tokens.refreshToken, tenantId: s.tenantId }).expect(200)).body;
    const sw = (await http().post('/v1/auth/switch-tenant').set(bearer(r2.tokens.accessToken)).send({ tenantId: second.tenantId }).expect(200)).body;
    // … or by switching: the new token is refused at the next request.
    expect(code(await http().get('/v1/me').set(bearer(sw.accessToken)).expect(401))).toBeDefined();
    expect(code(await http().post('/v1/auth/refresh').send({ refreshToken: r2.tokens.refreshToken, tenantId: second.tenantId }).expect(401))).toBe('INVALID_REFRESH_TOKEN');
    expect(code(await http().post('/v1/auth/refresh').send({ refreshToken: r2.tokens.refreshToken, tenantId: s.tenantId }).expect(401))).toBe('INVALID_REFRESH_TOKEN');
    // The main address's session itself still serves both businesses.
    await http().post('/v1/auth/switch-tenant').set(main).send({ tenantId: second.tenantId }).expect(200);

    // Signing out where the hand-off was made ends the hand-off's session too.
    const h3 = (await http().post('/v1/auth/handoff').set(main).expect(200)).body;
    const r3 = (await http().post('/v1/auth/refresh').send({ refreshToken: h3.code, tenantId: s.tenantId }).expect(200)).body;
    await http().get('/v1/me').set(bearer(r3.tokens.accessToken)).expect(200);
    await http().post('/v1/auth/logout').set(main).expect(204);
    await http().get('/v1/me').set(bearer(r3.tokens.accessToken)).expect(401);
    expect(code(await http().post('/v1/auth/refresh').send({ refreshToken: r3.tokens.refreshToken, tenantId: s.tenantId }).expect(401))).toBe('INVALID_REFRESH_TOKEN');
  });
});
