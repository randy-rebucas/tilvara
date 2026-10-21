import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { appointmentReminderMail } from '@1pos/database';
import { httpTransport, LocalStore, OfflineEngine, OfflineSaleError } from '@1pos/pos-offline';
import { nodeSqliteDriver } from '@1pos/pos-offline/node-sqlite';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Salons, spas and barber shops (ADR-0022): the SALON type, service staff and their hours, appointments
 * without double-booking, ringing an appointment up with staff on the lines, prepaid packages owed until
 * used, tips split among staff, commissions, client notes, supplies used per service, reminders, offline.
 */
let app: INestApplication;
let owner: pg.Pool;
let base: string;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

type Auth = { Authorization: string };
const idem = (auth: Auth) => ({ ...auth, 'Idempotency-Key': randomUUID() });

/** A Manila date `days` from today, and an instant on it at a local time (branches default to Asia/Manila). */
const manilaDate = (days: number) => new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
const at = (days: number, hhmm: string) => `${manilaDate(days)}T${hhmm}:00+08:00`;
const weekdayOf = (days: number) => new Date(`${manilaDate(days)}T00:00:00Z`).getUTCDay();

/**
 * A VAT salon (type SALON) with one branch: a haircut (₱560, 30 min) and a colour (₱1,120, 90 min),
 * shampoo for sale and hair dye as a supply; two stylists (Ana does everything at 10 %, Ben only cuts
 * at 5 % with 20 % on cuts) working 09:00–18:00 on the test day; a front desk member with a drawer.
 */
async function salon(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  await http().patch('/v1/business').set(auth).send({ businessType: 'SALON' }).expect(200);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const b1 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'Main', birBranchCode: '00001' }).expect(201)).body.id as string;
  const r1 = (await http().post('/v1/registers').set(auth).send({ branchId: b1, code: 'R1', name: 'Front' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const service = async (name: string, price: string, minutes: number) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: vat, productType: 'SERVICE', variants: [{ sku: uniq('SVC'), price, serviceMinutes: minutes }] }).expect(201)).body.variants[0].id as string;
  const cut = await service('Haircut', '560.00', 30);
  const colour = await service('Hair colour', '1120.00', 90);
  const shampoo = (await http().post('/v1/products').set(auth).send({ name: 'Shampoo', uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SHP'), price: '224.00' }] }).expect(201)).body.variants[0].id as string;
  const dye = (await http().post('/v1/products').set(auth).send({ name: 'Hair dye', uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('DYE') }] }).expect(201)).body.variants[0].id as string;
  await http().post('/v1/stock/adjustments').set(idem(auth))
    .send({ branchId: b1, reason: 'Opening', items: [{ variantId: shampoo, quantity: '20', unitCost: '100.00' }, { variantId: dye, quantity: '10', unitCost: '80.00' }] }).expect(201);

  const staff = async (body: object) => (await http().post('/v1/service-staff').set(idem(auth)).send({ branchId: b1, ...body }).expect(201)).body as { id: string };
  const ana = await staff({ displayName: 'Ana Cruz', commissionRate: '0.10', color: '#7a4cc2' });
  const ben = await staff({ displayName: 'Ben Santos', commissionRate: '0.05' });
  await http().put(`/v1/service-staff/${ben.id}/services`).set(auth).send({ services: [{ variantId: cut, commissionRate: '0.20' }] }).expect(200);
  const day = 3;
  for (const s of [ana, ben]) {
    await http().put(`/v1/service-staff/${s.id}/hours`).set(auth).send({ hours: [{ weekday: weekdayOf(day), startsAt: '09:00', endsAt: '18:00' }] }).expect(200);
  }
  const fd = await addMember(owner, t.tenantId, 'front_desk', { type: 'BRANCH', id: b1 });
  const desk = bearer(await loginToken(app, fd.email));
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: b1 });
  const manager = bearer(await loginToken(app, m.email));
  const session = (await http().post('/v1/cashier-sessions').set(desk).send({ registerId: r1, openingFloat: '2000.00' }).expect(201)).body.id as string;
  const customer = (await http().post('/v1/customers').set(desk).send({ displayName: 'Liza Reyes', email: `${uniq('liza')}@example.ph`, phone: '09170000000' }).expect(201)).body.id as string;
  return { t, tenantId: t.tenantId, auth, le: le.body.id as string, b1, r1, vat, pc, cut, colour, shampoo, dye, ana: ana.id, ben: ben.id, day, desk, deskId: fd.userId, manager, session, customer };
}
type S = Awaited<ReturnType<typeof salon>>;

const sql = <T = Record<string, unknown>>(s: S, q: string, params: unknown[] = []) => asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const sell = (s: S, body: object, auth: Auth = s.desk) =>
  http().post('/v1/sales').set(idem(auth)).send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '5000.00' }], ...body });
const book = (s: S, body: object, auth: Auth = s.desk) => http().post('/v1/appointments').set(idem(auth)).send({ branchId: s.b1, ...body });
const gl = async (s: S, key: string) =>
  Number((await sql<{ v: string }>(s, `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.system_key = $1`, [key]))[0]!.v);

describe('a salon business', () => {
  it('takes appointments and gets the salon roles; other types are refused, and restaurant service stays off', async () => {
    const s = await salon('salon-type');
    const roles = await sql<{ key: string }>(s, `SELECT key FROM roles WHERE is_system ORDER BY key`);
    expect(roles.map((r) => r.key)).toEqual(expect.arrayContaining(['front_desk', 'stylist']));
    await http().post('/v1/restaurant/floors').set(s.auth).send({ branchId: s.b1, name: 'Floor' }).expect((r) => expect([403, 404]).toContain(r.status));

    const shop = await signup(app, 'salon-retail');
    const shopAuth = bearer(shop.access);
    await http().patch('/v1/business').set(shopAuth).send({ businessType: 'RETAIL' }).expect(200);
    const le = await http().post('/v1/legal-entities').set(shopAuth).send({ registeredName: 'Shop Corp', vatStatus: 'VAT' }).expect(201);
    const b = (await http().post('/v1/branches').set(shopAuth).send({ legalEntityId: le.body.id, code: 'B1', name: 'Main', birBranchCode: '00001' }).expect(201)).body.id;
    const refused = await http().post('/v1/service-staff').set(idem(shopAuth)).send({ branchId: b, displayName: 'Nope' }).expect(403);
    expect(refused.body.error.code).toBe('BUSINESS_TYPE_EXCLUDES_FEATURE');
  });
});

describe('service staff', () => {
  it('keeps hours, services and time off; commission rates are shown only to those who manage staff', async () => {
    const s = await salon('salon-staff');
    const seen = (await http().get('/v1/service-staff').query({ branchId: s.b1 }).set(s.desk).expect(200)).body.data as { displayName: string; commissionRate?: string; services: unknown[]; hours: unknown[] }[];
    expect(seen.map((x) => x.displayName)).toEqual(['Ana Cruz', 'Ben Santos']);
    expect(seen.every((x) => x.commissionRate === undefined)).toBe(true);
    const managed = (await http().get('/v1/service-staff').query({ branchId: s.b1 }).set(s.manager).expect(200)).body.data as { commissionRate: string; services: { commissionRate: string }[] }[];
    expect(managed.map((x) => x.commissionRate)).toEqual(['0.1', '0.05']);
    expect(managed[1]!.services).toEqual([{ variantId: s.cut, commissionRate: '0.2' }]);
    // The front desk may book and note time off but not change staff.
    await http().patch(`/v1/service-staff/${s.ana}`).set(s.desk).send({ commissionRate: '0.5' }).expect(403);
    const off = (await http().post(`/v1/service-staff/${s.ana}/time-off`).set(idem(s.desk)).send({ startsAt: at(s.day, '13:00'), endsAt: at(s.day, '14:00'), reason: 'Lunch' }).expect(201)).body;
    const ana = (await http().get(`/v1/service-staff/${s.ana}`).set(s.manager).expect(200)).body;
    expect(ana.timeOff.map((x: { id: string }) => x.id)).toEqual([off.id]);
    expect(ana.hours).toEqual([{ weekday: weekdayOf(s.day), startsAt: '09:00', endsAt: '18:00' }]);
    // Overlapping hours on one day are refused before anything is stored; only services can be assigned.
    await http().put(`/v1/service-staff/${s.ana}/hours`).set(s.auth).send({ hours: [{ weekday: 1, startsAt: '09:00', endsAt: '12:00' }, { weekday: 1, startsAt: '11:00', endsAt: '13:00' }] }).expect(400);
    const notService = await http().put(`/v1/service-staff/${s.ana}/services`).set(s.auth).send({ services: [{ variantId: s.shampoo }] }).expect(422);
    expect(notService.body.error.code).toBe('NOT_A_SERVICE');
  });
});

describe('appointments', () => {
  it('books inside hours, never double-books a staff member, frees the time when cancelled, and suggests free times', async () => {
    const s = await salon('salon-book');
    const a = (await book(s, { customerId: s.customer, services: [{ variantId: s.colour, staffId: s.ana, startsAt: at(s.day, '10:00') }, { variantId: s.cut, staffId: s.ben, startsAt: at(s.day, '11:30') }], notes: 'Ash brown' }).expect(201)).body;
    expect(a.status).toBe('BOOKED');
    expect([a.startsAt, a.endsAt].map((x: string) => new Date(x).toISOString())).toEqual([new Date(at(s.day, '10:00')).toISOString(), new Date(at(s.day, '12:00')).toISOString()]);
    expect(a.services.map((x: { staffName: string }) => x.staffName)).toEqual(['Ana Cruz', 'Ben Santos']);
    expect(a.remind).toBe(true); // the customer has an email

    // Ana is busy 10:00–11:30.
    const clash = await book(s, { guestName: 'Walk-in', services: [{ variantId: s.cut, staffId: s.ana, startsAt: at(s.day, '11:00') }] }).expect(409);
    expect(clash.body.error.code).toBe('STAFF_DOUBLE_BOOKED');
    // Two desks booking the same slot at once: one wins (the exclusion constraint), the other is told so.
    const race = await Promise.all([1, 2].map(() => book(s, { guestName: 'Race', services: [{ variantId: s.cut, staffId: s.ben, startsAt: at(s.day, '15:00') }] })));
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(race.find((r) => r.status === 409)!.body.error.code).toBe('STAFF_DOUBLE_BOOKED');
    // Outside hours, in time off, and a service the staff member does not do.
    const late = await book(s, { guestName: 'Late', services: [{ variantId: s.cut, staffId: s.ana, startsAt: at(s.day, '17:45') }] }).expect(422);
    expect(late.body.error.code).toBe('OUTSIDE_WORKING_HOURS');
    await book(s, { guestName: 'Late', outsideHours: true, services: [{ variantId: s.cut, staffId: s.ana, startsAt: at(s.day, '17:45') }] }).expect(201);
    const benColour = await book(s, { guestName: 'X', services: [{ variantId: s.colour, staffId: s.ben, startsAt: at(s.day, '09:00') }] }).expect(422);
    expect(benColour.body.error.code).toBe('STAFF_DOES_NOT_DO_SERVICE');
    // A stylist sees the calendar but cannot book.
    const st = await addMember(owner, s.tenantId, 'stylist', { type: 'BRANCH', id: s.b1 });
    const stylist = bearer(await loginToken(app, st.email));
    const cal = (await http().get('/v1/appointments').query({ branchId: s.b1, from: at(s.day, '00:00'), to: at(s.day + 1, '00:00') }).set(stylist).expect(200)).body.data;
    expect(cal.length).toBe(3);
    await book(s, { guestName: 'Y', services: [{ variantId: s.cut, staffId: s.ana, startsAt: at(s.day, '16:00') }] }, stylist).expect(403);

    // Free times for a cut with Ben: not 11:30–12:00 or 15:00–15:30, not past 17:30.
    const free = (await http().get('/v1/appointments/availability').query({ branchId: s.b1, variantId: s.cut, date: manilaDate(s.day), staffId: s.ben }).set(s.desk).expect(200)).body;
    const bens = free.staff[0].slots.map((x: string) => new Date(x).getTime());
    expect(bens).toContain(new Date(at(s.day, '09:00')).getTime());
    expect(bens).not.toContain(new Date(at(s.day, '11:30')).getTime());
    expect(bens).not.toContain(new Date(at(s.day, '15:15')).getTime());
    expect(bens).not.toContain(new Date(at(s.day, '17:45')).getTime());

    // Cancelling frees Ana; rescheduling moves the appointment and resets its reminder.
    await http().post(`/v1/appointments/${a.id}/status`).set(s.desk).send({ status: 'CANCELLED' }).expect(400);
    await http().post(`/v1/appointments/${a.id}/status`).set(s.desk).send({ status: 'CANCELLED', reason: 'Client called' }).expect(200);
    await book(s, { guestName: 'Next', services: [{ variantId: s.cut, staffId: s.ana, startsAt: at(s.day, '11:00') }] }).expect(201);
    const again = await http().post(`/v1/appointments/${a.id}/status`).set(s.desk).send({ status: 'ARRIVED' }).expect(409);
    expect(again.body.error.code).toBe('APPOINTMENT_NOT_OPEN');
    const audit = await sql<{ action: string }>(s, `SELECT action FROM audit_logs WHERE resource_id = $1 ORDER BY occurred_at`, [a.id]);
    expect(audit.map((x) => x.action)).toEqual(['appointment.booked', 'appointment.cancelled']);
  });

  it('is rung up once with its staff on the lines and their commission rates', async () => {
    const s = await salon('salon-ring');
    const a = (await book(s, { customerId: s.customer, services: [{ variantId: s.cut, staffId: s.ben, startsAt: at(s.day, '10:00') }] }).expect(201)).body;
    await http().post(`/v1/appointments/${a.id}/status`).set(s.desk).send({ status: 'ARRIVED' }).expect(200);
    const sale = (await sell(s, {
      appointmentId: a.id, customerId: s.customer,
      lines: [{ variantId: s.cut, quantity: '1', staffId: s.ben }, { variantId: s.shampoo, quantity: '1', staffId: s.ana }],
    }).expect(201)).body;
    expect(sale.lines.map((l: { serviceStaffId: string; commissionRate: string }) => [l.serviceStaffId, Number(l.commissionRate)])).toEqual([[s.ben, 0.2], [s.ana, 0.1]]);
    const receipt = (await http().get(`/v1/sales/${sale.id}/receipt`).set(s.desk).expect(200)).body;
    expect(receipt.lines.map((l: { staff?: string }) => l.staff)).toEqual(['Ben', 'Ana']);
    const sku = sale.lines[0].sku as string;
    expect((await http().get('/v1/catalog/lookup').query({ code: sku, branchId: s.b1 }).set(s.desk).expect(200)).body.productType).toBe('SERVICE');
    const services = (await http().get('/v1/products').query({ productType: 'SERVICE' }).set(s.desk).expect(200)).body.data as { name: string }[];
    expect(services.map((p) => p.name).sort()).toEqual(['Hair colour', 'Haircut']);
    const after = (await http().get(`/v1/appointments/${a.id}`).set(s.desk).expect(200)).body;
    expect([after.status, after.saleId]).toEqual(['COMPLETED', sale.id]);
    const twice = await sell(s, { appointmentId: a.id, customerId: s.customer, lines: [{ variantId: s.cut, quantity: '1' }] }).expect(409);
    expect(twice.body.error.code).toBe('APPOINTMENT_NOT_OPEN');
    // A staff member of another branch, or an archived one, cannot be named online.
    await http().patch(`/v1/service-staff/${s.ana}`).set(s.auth).send({ archived: true }).expect(200);
    expect((await sell(s, { lines: [{ variantId: s.cut, quantity: '1', staffId: s.ana }] }).expect(422)).body.error.code).toBe('STAFF_ARCHIVED');
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });
});

describe('service packages', () => {
  /** "5 cuts + 1 colour" for ₱2,800 (₱2,500 + ₱300 VAT), valid 90 days. */
  async function pkg(s: S) {
    const v = (await http().post('/v1/products').set(s.auth).send({
      name: 'Cut and colour bundle', uomId: s.pc, taxCategoryId: s.vat, productType: 'PACKAGE', variants: [{ sku: uniq('PKG'), price: '2800.00', packageValidDays: 90 }],
    }).expect(201)).body.variants[0].id as string;
    const items = (await http().put(`/v1/variants/${v}/package-items`).set(s.auth).send({ items: [{ serviceVariantId: s.cut, sessions: 5 }, { serviceVariantId: s.colour, sessions: 1 }] }).expect(200)).body;
    expect(items.items.map((i: { sessions: number }) => i.sessions).sort()).toEqual([1, 5]);
    return v;
  }

  it('are owed until used: sold to a customer, used session by session at zero, and the books follow the sessions', async () => {
    const s = await salon('salon-pkg');
    const bundle = await pkg(s);
    expect((await sell(s, { lines: [{ variantId: bundle, quantity: '1' }] }).expect(422)).body.error.code).toBe('PACKAGE_NEEDS_CUSTOMER');
    const sold = (await sell(s, { customerId: s.customer, lines: [{ variantId: bundle, quantity: '1' }], expectedAmountDue: '2800.00' }).expect(201)).body;
    expect([sold.amountDue, sold.vatAmount]).toEqual(['2800.00', '300.00']);
    // ₱2,500 owed, not sales; VAT is due now.
    expect(await gl(s, 'PREPAID_SERVICES')).toBe(-2500);
    expect(await gl(s, 'SALES')).toBe(0);
    const [p] = (await http().get(`/v1/customers/${s.customer}/packages`).query({ open: 'true' }).set(s.desk).expect(200)).body.data;
    // Split by list price × sessions: cuts 5 × 500 = 2,500, colour 1 × 1,000 = 1,000 → 1,785.71 / 714.29.
    expect(p.valueLeft).toBe('2500.00');
    expect(p.services.map((x: { variantId: string; sessionsLeft: number }) => [x.variantId === s.cut ? 'cut' : 'colour', x.sessionsLeft]).sort()).toEqual([['colour', 1], ['cut', 5]]);
    const cutValue = await sql<{ value: string }>(s, `SELECT value::text FROM customer_package_items WHERE customer_package_id = $1 AND service_variant_id = $2`, [p.id, s.cut]);
    expect(Number(cutValue[0]!.value)).toBe(1785.71);

    // A session: nothing to pay, no VAT; ₱357.14 (1,785.71 ÷ 5) becomes sales, with Ben's 20 % on it.
    const used = (await sell(s, { customerId: s.customer, lines: [{ variantId: s.cut, quantity: '1', packageId: p.id, staffId: s.ben }], tenders: [{ method: 'CASH', tendered: '0.00' }] }).expect(201)).body;
    expect([used.amountDue, used.vatAmount, used.lines[0].unitPrice, Number(used.lines[0].packageValue)]).toEqual(['0.00', '0.00', '0', 357.14]);
    expect((await http().get(`/v1/sales/${used.id}/receipt`).set(s.desk).expect(200)).body.lines[0]).toMatchObject({ packageSession: true, staff: 'Ben', amount: '0.00' });
    expect(await gl(s, 'PREPAID_SERVICES')).toBe(-2142.86);
    expect(await gl(s, 'SALES')).toBe(-357.14);
    // No discount on a session; another customer's package, or a service it does not hold, is refused.
    await http().post('/v1/tax/quote').set(s.manager).send({ branchId: s.b1, lines: [{ variantId: s.cut, quantity: '1', packageId: p.id, discountRate: '0.1' }] }).expect(400);
    const other = (await http().post('/v1/customers').set(s.desk).send({ displayName: 'Other' }).expect(201)).body.id;
    expect((await sell(s, { customerId: other, lines: [{ variantId: s.cut, quantity: '1', packageId: p.id }], tenders: [{ method: 'CASH', tendered: '0.00' }] }).expect(422)).body.error.code).toBe('PACKAGE_CUSTOMER_MISMATCH');
    expect((await sell(s, { customerId: s.customer, lines: [{ variantId: s.shampoo, quantity: '1', packageId: p.id }] }).expect(422)).body.error.code).toBe('PACKAGE_DOES_NOT_COVER');

    // The last colour session, rung on two tills at once: one wins.
    const race = await Promise.all([1, 2].map(() => sell(s, { customerId: s.customer, lines: [{ variantId: s.colour, quantity: '1', packageId: p.id }], tenders: [{ method: 'CASH', tendered: '0.00' }] })));
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(race.find((r) => r.status === 409)!.body.error.code).toBe('PACKAGE_EXHAUSTED');
    // The last session of an item takes exactly the rest of its value.
    expect(Number(race.find((r) => r.status === 201)!.body.lines[0].packageValue)).toBe(714.29);

    // Giving the cut session back restores it and its value.
    const back = (await http().post(`/v1/sales/${used.id}/returns`).set(idem(s.manager))
      .send({ cashierSessionId: s.session, kind: 'RETURN', reason: 'Redo', lines: [{ saleLineId: used.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201)).body;
    expect(back.amountDue).toBe('0.00');
    expect(await gl(s, 'PREPAID_SERVICES')).toBe(-1785.71);
    // The bundle is no longer unused (the colour went): returning it is refused.
    expect((await http().post(`/v1/sales/${sold.id}/returns`).set(idem(s.manager))
      .send({ cashierSessionId: s.session, kind: 'RETURN', reason: 'Changed mind', lines: [{ saleLineId: sold.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(409)).body.error.code).toBe('PACKAGE_USED');

    // The liability is what the package ledger says is left; the report agrees with the books.
    const owed = await sql<{ v: string }>(s, `SELECT coalesce(sum(value), 0)::text AS v FROM customer_package_entries`);
    expect(-(await gl(s, 'PREPAID_SERVICES'))).toBe(Number(owed[0]!.v));
    const report = (await http().get('/v1/reports/service-packages').query({ branchId: s.b1, from: manilaDate(0), to: manilaDate(0) }).set(s.manager).expect(200)).body;
    expect([report.sold, report.owed, report.ledger, report.open.length]).toEqual(['2500.00', '1785.71', '1785.71', 1]);
    // A customer who still has sessions cannot be anonymised.
    expect((await http().post(`/v1/customers/${s.customer}/anonymise`).set(s.auth).send({ reason: 'Asked' }).expect(409)).body.error.code).toBe('CUSTOMER_HAS_PACKAGES');
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('an unused package comes back whole; an expired one cannot be used', async () => {
    const s = await salon('salon-pkg-back');
    const bundle = await pkg(s);
    const sold = (await sell(s, { customerId: s.customer, lines: [{ variantId: bundle, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '5600.00' }] }).expect(201)).body;
    expect(await gl(s, 'PREPAID_SERVICES')).toBe(-5000);
    const back = (await http().post(`/v1/sales/${sold.id}/returns`).set(idem(s.manager))
      .send({ cashierSessionId: s.session, kind: 'RETURN', reason: 'Changed mind', lines: [{ saleLineId: sold.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201)).body;
    expect(back.amountDue).toBe('2800.00');
    expect(await gl(s, 'PREPAID_SERVICES')).toBe(-2500);
    expect(await gl(s, 'SALES_RETURNS')).toBe(0);
    const open = (await http().get(`/v1/customers/${s.customer}/packages`).query({ open: 'true' }).set(s.desk).expect(200)).body.data;
    expect(open).toHaveLength(1);
    // Make the remaining one expired (as the migrator would see it after 90 days).
    await asOwnerInTenant(owner, s.tenantId, async (c) => {
      await c.query('ALTER TABLE customer_packages DISABLE TRIGGER customer_packages_append_only');
      await c.query(`UPDATE customer_packages SET expires_on = current_date - 1 WHERE id = $1`, [open[0].id]);
      await c.query('ALTER TABLE customer_packages ENABLE TRIGGER customer_packages_append_only');
    });
    const expired = await sell(s, { customerId: s.customer, lines: [{ variantId: s.cut, quantity: '1', packageId: open[0].id }], tenders: [{ method: 'CASH', tendered: '0.00' }] }).expect(409);
    expect(expired.body.error.code).toBe('PACKAGE_EXPIRED');
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });
});

describe('tips and commissions', () => {
  it('split a tip among the staff who served, or as given; the reports add them up per staff member', async () => {
    const s = await salon('salon-tips');
    // ₱560 cut by Ben (20 %) and ₱1,120 colour by Ana (10 %), ₱101 cash tip split equally (50.50 each).
    const first = (await sell(s, {
      lines: [{ variantId: s.cut, quantity: '1', staffId: s.ben }, { variantId: s.colour, quantity: '1', staffId: s.ana }], tip: { amount: '101.00' },
    }).expect(201)).body;
    const shares = await sql<{ staff_id: string; amount: string }>(s, `SELECT sh.staff_id, sh.amount::text FROM sale_tip_shares sh JOIN sale_tips t ON t.id = sh.sale_tip_id WHERE t.sale_id = $1 ORDER BY sh.amount DESC`, [first.id]);
    expect(shares.map((x) => [x.staff_id, Number(x.amount)]).sort()).toEqual([[s.ana, 50.5], [s.ben, 50.5]].sort());
    // Given shares must add up to the tip.
    expect((await sell(s, { lines: [{ variantId: s.cut, quantity: '1', staffId: s.ben }], tip: { amount: '50.00', shares: [{ staffId: s.ben, amount: '40.00' }] } }).expect(422)).body.error.code).toBe('TIP_SHARES_MISMATCH');
    await sell(s, { lines: [{ variantId: s.cut, quantity: '1', staffId: s.ben }], tip: { amount: '50.00', shares: [{ staffId: s.ben, amount: '30.00' }, { staffId: s.ana, amount: '20.00' }] } }).expect(201);

    const day = { branchId: s.b1, from: manilaDate(0), to: manilaDate(0) };
    const tips = (await http().get('/v1/reports/tips-by-staff').query(day).set(s.manager).expect(200)).body;
    expect(tips.staff.map((x: { name: string; amount: string }) => [x.name, x.amount])).toEqual([['Ana Cruz', '70.50'], ['Ben Santos', '80.50']]);
    // Commission: Ben 20 % of 500 × 2 = 200; Ana 10 % of 1,000 = 100.
    const com = (await http().get('/v1/reports/commissions').query(day).set(s.manager).expect(200)).body;
    expect(com.staff.map((x: { name: string; netBase: string; commission: string }) => [x.name, x.netBase, x.commission])).toEqual([['Ana Cruz', '1000.00', '100.00'], ['Ben Santos', '1000.00', '200.00']]);
    // A return takes its share of the commission back.
    await http().post(`/v1/sales/${first.id}/returns`).set(idem(s.manager))
      .send({ cashierSessionId: s.session, kind: 'RETURN', reason: 'Unhappy', lines: [{ saleLineId: first.lines[1].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201);
    const after = (await http().get('/v1/reports/commissions').query(day).set(s.manager).expect(200)).body;
    expect(after.staff.find((x: { name: string }) => x.name === 'Ana Cruz')).toMatchObject({ netBase: '0.00', commission: '0.00', returns: '1000.00' });
    // Cashiers do not see the reports.
    await http().get('/v1/reports/commissions').query(day).set(s.desk).expect(403);
  });
});

describe('client history', () => {
  it('keeps service notes (audited by id only), shows visits, exports and forgets them with the customer', async () => {
    const s = await salon('salon-notes');
    const note = (await http().post(`/v1/customers/${s.customer}/notes`).set(idem(s.desk)).send({ body: 'Allergic to PPD; use 6.1 ash, 20 vol', pinned: true }).expect(201)).body;
    await http().patch(`/v1/customers/${s.customer}/notes/${note.id}`).set(s.desk).send({ body: 'Allergic to PPD; use 6.1 ash, 30 vol' }).expect(200);
    const st = await addMember(owner, s.tenantId, 'stylist', { type: 'BRANCH', id: s.b1 });
    const stylist = bearer(await loginToken(app, st.email));
    expect((await http().get(`/v1/customers/${s.customer}/notes`).set(stylist).expect(200)).body.data.map((n: { body: string }) => n.body)).toEqual(['Allergic to PPD; use 6.1 ash, 30 vol']);
    await http().post(`/v1/customers/${s.customer}/notes`).set(idem(stylist)).send({ body: 'x' }).expect(403);
    const audit = await sql<{ metadata: unknown }>(s, `SELECT metadata FROM audit_logs WHERE action LIKE 'customer.note_%'`);
    expect(JSON.stringify(audit)).not.toContain('PPD');

    const a = (await book(s, { customerId: s.customer, services: [{ variantId: s.cut, staffId: s.ben, startsAt: at(s.day, '10:00') }] }).expect(201)).body;
    await sell(s, { appointmentId: a.id, customerId: s.customer, lines: [{ variantId: s.cut, quantity: '1', staffId: s.ben }] }).expect(201);
    const visits = (await http().get(`/v1/customers/${s.customer}/visits`).set(s.desk).expect(200)).body;
    expect(visits.appointments.map((x: { status: string }) => x.status)).toEqual(['COMPLETED']);
    expect(visits.services.map((x: { name: string; staffName: string }) => [x.name, x.staffName])).toEqual([['Haircut', 'Ben Santos']]);

    const exported = (await http().post(`/v1/customers/${s.customer}/export`).set(s.auth).expect(200)).body;
    expect(exported.serviceNotes.map((n: { body: string }) => n.body)).toEqual(['Allergic to PPD; use 6.1 ash, 30 vol']);
    expect(exported.appointments).toHaveLength(1);
    await http().post(`/v1/customers/${s.customer}/anonymise`).set(s.auth).send({ reason: 'Asked to be forgotten' }).expect(200);
    expect(await sql(s, `SELECT 1 FROM customer_notes WHERE customer_id = $1`, [s.customer])).toEqual([]);
  });
});

describe('supplies used per service', () => {
  it('a salon may give a service a recipe; the service consumes its supplies and they run low', async () => {
    const s = await salon('salon-supply');
    await http().post(`/v1/variants/${s.colour}/recipe`).set(s.auth).send({ ingredients: [{ variantId: s.dye, quantity: '1' }] }).expect(201);
    await http().put('/v1/stock/reorder-points').set(s.auth).send({ branchId: s.b1, items: [{ variantId: s.dye, reorderPoint: '9' }] }).expect((r) => expect([200, 201]).toContain(r.status));
    const sale = (await sell(s, { lines: [{ variantId: s.colour, quantity: '1', staffId: s.ana }] }).expect(201)).body;
    const moved = await sql<{ type: string; quantity: string }>(s, `SELECT type, quantity::text FROM stock_movements WHERE sale_id = $1`, [sale.id]);
    expect(moved.map((m) => [m.type, Number(m.quantity)])).toEqual([['CONSUMPTION', -1]]);
    const low = await sql(s, `SELECT 1 FROM outbox_events WHERE topic = 'stock.low'`);
    expect(low.length).toBeGreaterThan(0);
  });
});

describe('reminders', () => {
  it('are flagged once within a day of the appointment and mailed to the customer with the staff first names', async () => {
    const s = await salon('salon-remind');
    const soon = new Date(Date.now() + 5 * 3_600_000);
    soon.setUTCMinutes(0, 0, 0);
    const a = (await book(s, { customerId: s.customer, outsideHours: true, services: [{ variantId: s.cut, staffId: s.ben, startsAt: soon.toISOString() }] }).expect(201)).body;
    const quiet = (await book(s, { customerId: s.customer, remind: false, outsideHours: true, services: [{ variantId: s.cut, staffId: s.ana, startsAt: soon.toISOString() }] }).expect(201)).body;
    const flag = async () => {
      const c = await owner.connect();
      try {
        return Number((await c.query<{ n: number }>('SELECT platform_flag_appointment_reminders() AS n')).rows[0]!.n);
      } finally {
        c.release();
      }
    };
    await flag();
    await flag();
    const events = await sql<{ payload: { appointmentId: string } }>(s, `SELECT payload FROM outbox_events WHERE topic = 'appointment.reminder'`);
    expect(events.map((e) => e.payload.appointmentId)).toEqual([a.id]);
    expect(quiet.remind).toBe(false);
    const mail = await asOwnerInTenant(owner, s.tenantId, (c) => appointmentReminderMail(c, { appointmentId: a.id }));
    expect(mail!.subject).toContain('Main');
    expect(mail!.text).toContain('Hi Liza,');
    expect(mail!.text).toContain('Haircut with Ben');
    expect(mail!.text).not.toContain('Santos');
    // Cancelled since: nothing to send.
    await http().post(`/v1/appointments/${a.id}/status`).set(s.desk).send({ status: 'CANCELLED', reason: 'Sick' }).expect(200);
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => appointmentReminderMail(c, { appointmentId: a.id }))).toBeNull();
  });
});

describe('offline', () => {
  it('the snapshot lists the staff; an offline sale names them, and packages wait for the server', async () => {
    const s = await salon('salon-off');
    const bundle = (await http().post('/v1/products').set(s.auth).send({
      name: 'Bundle', uomId: s.pc, taxCategoryId: s.vat, productType: 'PACKAGE', variants: [{ sku: uniq('PKG'), price: '1000.00' }],
    }).expect(201)).body.variants[0].id as string;
    const reg = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.r1, name: 'Till 1' }).expect(201)).body;
    const engine = new OfflineEngine({
      store: new LocalStore(nodeSqliteDriver(join(mkdtempSync(join(tmpdir(), '1pos-till-')), 'till.db'))),
      transport: httpTransport({ baseUrl: base, terminalId: reg.terminal.id, credential: reg.credential, timeoutMs: 10_000 }),
    });
    await engine.open();
    const snap = await engine.refreshSnapshot();
    expect((snap.staff ?? []).map((x) => x.displayName)).toEqual(['Ana Cruz', 'Ben Santos']);
    expect(snap.items.find((i) => i.variantId === bundle)?.productType).toBe('PACKAGE');
    await expect(engine.ringUp({ cashierUserId: s.deskId, lines: [{ variantId: bundle, quantity: '1' }], tendered: '1000' })).rejects.toMatchObject({ code: 'ONLINE_ONLY' } satisfies Partial<OfflineSaleError>);
    await engine.ringUp({ cashierUserId: s.deskId, lines: [{ variantId: s.cut, quantity: '1', staffId: s.ben }], tendered: '600' });
    // Ben left before the till came back online: the sale still names him (he did the work).
    await http().patch(`/v1/service-staff/${s.ben}`).set(s.auth).send({ archived: true }).expect(200);
    const report = await engine.syncOnce();
    expect(report.results.map((r) => r.status)).toEqual(['RECORDED']);
    const lines = await sql<{ service_staff_id: string; commission_rate: string }>(s, `SELECT l.service_staff_id, l.commission_rate::text FROM sale_lines l JOIN sales x ON x.id = l.sale_id WHERE x.terminal_id = $1`, [reg.terminal.id]);
    expect(lines.map((l) => [l.service_staff_id, Number(l.commission_rate)])).toEqual([[s.ben, 0.2]]);
  });
});
