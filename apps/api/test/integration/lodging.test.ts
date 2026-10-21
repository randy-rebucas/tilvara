import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { OfflineSale, Snapshot } from '@1pos/sync-protocol';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NightAuditScheduler } from '../../src/lodging/night-audit.scheduler.js';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Hotels, resorts and transient houses (ADR-0023): the LODGING type, rooms without double-booking, the
 * stay state machine, check-in/out, the night audit (idempotent, catch-up), VAT and SC/PWD on nights,
 * the accommodation tax, charge to room (limits, entity, offline refusal), returns onto the folio,
 * folio payments and deposits (cash in the drawer), settled folios, permissions and the books.
 */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

type Auth = { Authorization: string };
const idem = (auth: Auth) => ({ ...auth, 'Idempotency-Key': randomUUID() });
/** A Manila date `days` from today (branches default to Asia/Manila). */
const day = (days: number) => new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);

/**
 * A VAT hotel (type LODGING): branch H1 (rooms 101, 102, 103 of type STD at ₱2,800 VAT-inclusive) and an
 * outlet branch H2 of the same entity (a restaurant), a second entity with branch X1; nights due at 00:00;
 * a front desk member with a drawer at H1, a cashier with a drawer at H2, a branch manager at H1.
 */
async function hotel(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  await http().patch('/v1/business').set(auth).send({ businessType: 'LODGING' }).expect(200);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Hotel Corp`, vatStatus: 'VAT' }).expect(201)).body.id as string;
  const branch = async (legalEntityId: string, code: string, birBranchCode?: string) => (await http().post('/v1/branches').set(auth).send({ legalEntityId, code, name: code, ...(birBranchCode && { birBranchCode }) }).expect(201)).body.id as string;
  const h1 = await branch(le, 'H1');
  const h2 = await branch(le, 'H2', '00001');
  const le2 = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Other Corp`, vatStatus: 'VAT' }).expect(201)).body.id as string;
  const x1 = await branch(le2, 'X1');
  const register = async (branchId: string, code: string) => (await http().post('/v1/registers').set(auth).send({ branchId, code, name: code }).expect(201)).body.id as string;
  const [r1, r2, rx] = [await register(h1, 'FD'), await register(h2, 'RS'), await register(x1, 'XX')];
  const type = (await http().post('/v1/room-types').set(idem(auth)).send({ code: 'STD', name: 'Standard', baseOccupancy: 2, maxOccupancy: 3, rackRate: '2800.00' }).expect(201)).body;
  const room = async (number: string) => (await http().post('/v1/rooms').set(idem(auth)).send({ branchId: h1, roomTypeId: type.id, number }).expect(201)).body.id as string;
  const rooms = { r101: await room('101'), r102: await room('102'), r103: await room('103') };
  await http().patch(`/v1/branches/${h1}/lodging-settings`).set(auth).send({ nightAuditTime: '00:00' }).expect(200);
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const dinner = (await http().post('/v1/products').set(auth).send({ name: 'Dinner set', uomId: pc, taxCategoryId: vat, productType: 'SERVICE', trackInventory: false, variants: [{ sku: uniq('DIN'), price: '560.00' }] }).expect(201)).body.variants[0].id as string;
  const fd = await addMember(owner, t.tenantId, 'front_desk', { type: 'BRANCH', id: h1 });
  const desk = bearer(await loginToken(app, fd.email));
  const ca = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: h2 });
  const cashier = bearer(await loginToken(app, ca.email));
  const cx = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: x1 });
  const otherCashier = bearer(await loginToken(app, cx.email));
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: h1 });
  const manager = bearer(await loginToken(app, m.email));
  const hk = await addMember(owner, t.tenantId, 'housekeeping', { type: 'BRANCH', id: h1 });
  const housekeeping = bearer(await loginToken(app, hk.email));
  const deskSession = (await http().post('/v1/cashier-sessions').set(desk).send({ registerId: r1, openingFloat: '5000.00' }).expect(201)).body.id as string;
  const outletSession = (await http().post('/v1/cashier-sessions').set(cashier).send({ registerId: r2, openingFloat: '1000.00' }).expect(201)).body.id as string;
  const otherSession = (await http().post('/v1/cashier-sessions').set(otherCashier).send({ registerId: rx, openingFloat: '1000.00' }).expect(201)).body.id as string;
  return { t, tenantId: t.tenantId, auth, le, le2, h1, h2, x1, r1, r2, type, rooms, dinner, desk, cashier, otherCashier, manager, housekeeping, deskSession, outletSession, otherSession, cashierId: ca.userId };
}
type H = Awaited<ReturnType<typeof hotel>>;

const sql = <T = Record<string, unknown>>(h: H, q: string, params: unknown[] = []) => asOwnerInTenant(owner, h.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const book = (h: H, body: object, auth: Auth = h.desk) => http().post('/v1/stays').set(idem(auth)).send({ branchId: h.h1, roomId: h.rooms.r101, ...body });
const guest = { fullName: 'Liza Reyes', nationality: 'Filipino', idType: 'Passport', idNumber: 'P1234567', address: 'Quezon City' };
/** Book and check in a guest who arrived `fromDays` ago (≤ 0) and leaves `toDays` from today. */
async function inHouse(h: H, roomId: string, fromDays: number, toDays: number, extra: object = {}) {
  return (await book(h, { roomId, arrivalDate: day(fromDays), departureDate: day(toDays), guests: [guest], checkIn: true, ...extra }).expect(201)).body as { id: string; folio: { id: string }; status: string };
}
const folio = async (h: H, id: string, auth: Auth = h.desk) => (await http().get(`/v1/folios/${id}`).set(auth).expect(200)).body;
const gl = (h: H, key: string, le = h.le) =>
  sql<{ v: string }>(h, `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.legal_entity_id = $1 AND a.system_key = $2`, [le, key]).then((r) => r[0]!.v);

describe('business type and set-up', () => {
  it('only a hotel (or HYBRID) writes rooms and stays; reads stay open; it serves tables and gets the lodging roles', async () => {
    const t = await signup(app, 'lod-retail');
    const auth = bearer(t.access);
    await http().patch('/v1/business').set(auth).send({ businessType: 'RETAIL' }).expect(200);
    const refused = await http().post('/v1/room-types').set(idem(auth)).send({ code: 'STD', name: 'Standard', rackRate: '1000.00' }).expect(403);
    expect(refused.body.error).toMatchObject({ code: 'BUSINESS_TYPE_EXCLUDES_FEATURE', details: { feature: 'lodging' } });
    await http().get('/v1/room-types').set(auth).expect(200);
    await http().get('/v1/stays').set(auth).expect(200);

    const h = await hotel('lod-setup');
    expect(h.type).toMatchObject({ code: 'STD', baseOccupancy: 2, maxOccupancy: 3, nightItem: { sku: 'ROOM-STD' } });
    const roles = await sql<{ key: string }>(h, `SELECT key FROM roles WHERE is_system ORDER BY key`);
    expect(roles.map((r) => r.key)).toEqual(expect.arrayContaining(['front_desk', 'housekeeping', 'restaurant_manager', 'kitchen_crew']));
    const desk = await sql<{ code: string }>(h, `SELECT p.permission_code AS code FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE r.key = 'front_desk'`);
    expect(desk.map((d) => d.code)).toEqual(expect.arrayContaining(['lodging.read', 'lodging.manage', 'lodging.housekeeping']));
    // The front desk cannot set up rooms; the housekeeper changes statuses and nothing else.
    await http().post('/v1/rooms').set(idem(h.desk)).send({ branchId: h.h1, roomTypeId: h.type.id, number: '999' }).expect(403);
    await http().post('/v1/rooms').set(idem(h.auth)).send({ branchId: h.h1, roomTypeId: h.type.id, number: '101' }).expect(409);
    await http().post(`/v1/rooms/${h.rooms.r103}/status`).set(h.housekeeping).send({ status: 'DIRTY' }).expect(200);
    await http().post(`/v1/rooms/${h.rooms.r103}/status`).set(h.housekeeping).send({ status: 'OUT_OF_ORDER' }).expect(400); // needs a note
    await book(h, { roomId: h.rooms.r103, arrivalDate: day(1), departureDate: day(2), guestName: 'X' }, h.housekeeping).expect(403);
    const board = (await http().get('/v1/lodging/housekeeping').query({ branchId: h.h1 }).set(h.housekeeping).expect(200)).body;
    expect(board.data.find((r: { number: string }) => r.number === '103')).toMatchObject({ status: 'DIRTY', lastChange: { byName: expect.any(String) } });
    // A business with guests in house keeps its rooms.
    await inHouse(h, h.rooms.r101, 0, 1);
    expect((await http().patch('/v1/business').set(h.auth).send({ businessType: 'RETAIL' }).expect(409)).body.error.code).toBe('OPEN_STAYS');
  });

  it('room types are business-wide: a branch grant cannot set them up; making their night item needs catalog.manage and prices.manage', async () => {
    const h = await hotel('lod-scope');
    await http().post('/v1/roles').set(h.auth).send({ key: 'room_setup', name: 'Room set-up', permissions: ['lodging.setup', 'lodging.read'] }).expect(201);
    const atBranch = bearer(await loginToken(app, (await addMember(owner, h.tenantId, 'room_setup', { type: 'BRANCH', id: h.h1 })).email));
    const wide = bearer(await loginToken(app, (await addMember(owner, h.tenantId, 'room_setup')).email));
    await http().post('/v1/room-types').set(idem(atBranch)).send({ code: 'DLX', name: 'Deluxe', nightVariantId: h.dinner }).expect(403);
    await http().patch(`/v1/room-types/${h.type.id}`).set(atBranch).send({ name: 'Renamed' }).expect(403);
    // Business-wide, but without the catalog: only with a night item that already exists.
    const refused = (await http().post('/v1/room-types').set(idem(wide)).send({ code: 'DLX', name: 'Deluxe', rackRate: '3500.00' }).expect(403)).body.error;
    expect(refused.details.missing).toEqual(['catalog.manage']);
    await http().post('/v1/room-types').set(idem(wide)).send({ code: 'DLX', name: 'Deluxe', nightVariantId: h.dinner }).expect(201);
  });
});

describe('stays', () => {
  it('a room is never double-booked, nor booked while out of order; cancelling frees it', async () => {
    const h = await hotel('lod-dbl');
    const first = (await book(h, { arrivalDate: day(10), departureDate: day(13), guestName: 'Ana' }).expect(201)).body;
    expect((await book(h, { arrivalDate: day(12), departureDate: day(14), guestName: 'Ben' }).expect(409)).body.error.code).toBe('ROOM_DOUBLE_BOOKED');
    await book(h, { arrivalDate: day(13), departureDate: day(14), guestName: 'Ben' }).expect(201); // checks out the morning Ben arrives
    // Two at once: one wins.
    const race = await Promise.all([1, 2].map(() => book(h, { roomId: h.rooms.r102, arrivalDate: day(20), departureDate: day(22), guestName: 'Race' })));
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    // Out of order: a block refuses stays; a block over a booking is refused.
    await http().post('/v1/room-blocks').set(idem(h.manager)).send({ roomId: h.rooms.r103, startsOn: day(30), endsOn: day(32), reason: 'Aircon repair' }).expect(201);
    expect((await book(h, { roomId: h.rooms.r103, arrivalDate: day(31), departureDate: day(33), guestName: 'Cy' }).expect(409)).body.error.code).toBe('ROOM_OUT_OF_ORDER');
    expect((await http().post('/v1/room-blocks').set(idem(h.manager)).send({ roomId: h.rooms.r101, startsOn: day(11), endsOn: day(12), reason: 'Paint' }).expect(409)).body.error.code).toBe('ROOM_BOOKED');
    const avail = (await http().get('/v1/lodging/availability').query({ branchId: h.h1, from: day(30), to: day(32) }).set(h.desk).expect(200)).body;
    expect(avail.nights[0].roomTypes[0]).toMatchObject({ total: 3, available: 2 });
    expect(avail.rooms.find((r: { roomId: string }) => r.roomId === h.rooms.r103).availableAllNights).toBe(false);
    // Cancel: the nights are free again; a cancelled stay does not change any more.
    await http().post(`/v1/stays/${first.id}/cancel`).set(h.desk).send({ reason: 'Plans changed' }).expect(200);
    await book(h, { arrivalDate: day(11), departureDate: day(13), guestName: 'Dee' }).expect(201);
    expect((await http().patch(`/v1/stays/${first.id}`).set(h.desk).send({ notes: 'x' }).expect(409)).body.error.code).toBe('STAY_ENDED');
    // Moving to an occupied room is refused by the same rule.
    const ben = (await sql<{ id: string }>(h, `SELECT id FROM stays WHERE guest_name = 'Ben'`))[0]!.id;
    await book(h, { roomId: h.rooms.r102, arrivalDate: day(13), departureDate: day(14), guestName: 'Eve' }).expect(201);
    expect((await http().patch(`/v1/stays/${ben}`).set(h.desk).send({ roomId: h.rooms.r102 }).expect(409)).body.error.code).toBe('ROOM_DOUBLE_BOOKED');
    // An agreed rate needs lodging.rates (the branch manager), not the front desk.
    await book(h, { roomId: h.rooms.r102, arrivalDate: day(40), departureDate: day(41), guestName: 'Rate', nightlyRate: '2000.00' }).expect(403);
    await book(h, { roomId: h.rooms.r102, arrivalDate: day(40), departureDate: day(41), guestName: 'Rate', nightlyRate: '2000.00' }, h.manager).expect(201);
    expect((await book(h, { roomId: h.rooms.r103, arrivalDate: day(50), departureDate: day(51), guestName: 'Big', adults: 4 }).expect(422)).body.error.code).toBe('OVER_OCCUPANCY');
  });

  it('check-in and check-out follow their rules; the state machine refuses other moves', async () => {
    const h = await hotel('lod-flow');
    const later = (await book(h, { arrivalDate: day(3), departureDate: day(4), guestName: 'Later' }).expect(201)).body;
    expect((await http().post(`/v1/stays/${later.id}/check-in`).set(h.desk).send({}).expect(409)).body.error.code).toBe('TOO_EARLY');
    expect((await http().post(`/v1/stays/${later.id}/no-show`).set(h.desk).send({ reason: 'x' }).expect(409)).body.error.code).toBe('ARRIVAL_NOT_PASSED');
    const stay = (await book(h, { roomId: h.rooms.r102, arrivalDate: day(0), departureDate: day(2), guestName: 'Now' }).expect(201)).body;
    expect((await http().post(`/v1/stays/${stay.id}/check-in`).set(h.desk).send({}).expect(409)).body.error.code).toBe('GUEST_REGISTRY_REQUIRED');
    await http().post(`/v1/rooms/${h.rooms.r102}/status`).set(h.housekeeping).send({ status: 'DIRTY' }).expect(200);
    expect((await http().post(`/v1/stays/${stay.id}/check-in`).set(h.desk).send({ guests: [guest] }).expect(409)).body.error.code).toBe('ROOM_NOT_READY');
    const checkedIn = (await http().post(`/v1/stays/${stay.id}/check-in`).set(h.desk).send({ overrideHousekeeping: true, guests: [guest] }).expect(200)).body;
    expect(checkedIn).toMatchObject({ status: 'IN_HOUSE', guests: [{ fullName: 'Liza Reyes', isPrimary: true }], folio: { status: 'OPEN', balance: '0.00' } });
    const card = (await http().get(`/v1/stays/${stay.id}/registration-card`).set(h.desk).expect(200)).body;
    expect(card).toMatchObject({ stay: { roomNumber: '102' }, guests: [{ fullName: 'Liza Reyes', idNumber: 'P1234567' }] });
    await http().get(`/v1/stays/${stay.id}/registration-card`).set(h.housekeeping).expect(403); // the registry is for the front desk
    expect((await http().post(`/v1/stays/${stay.id}/cancel`).set(h.desk).send({ reason: 'x' }).expect(409)).body.error.code).toBe('STAY_NOT_BOOKED');
    // The database refuses a move the state machine does not allow, and an in-house arrival date change.
    await expect(sql(h, `UPDATE stays SET status = 'BOOKED' WHERE id = $1`, [stay.id])).rejects.toThrow(/cannot go from IN_HOUSE to BOOKED/);
    expect((await http().patch(`/v1/stays/${stay.id}`).set(h.desk).send({ arrivalDate: day(-1) }).expect(409)).body.error.code).toBe('ARRIVAL_FIXED');
    // Check-out: two nights charged, nothing paid → refused; the nights stay charged once prepared.
    const due = (await http().post(`/v1/stays/${stay.id}/check-out`).set(h.desk).send({}).expect(409)).body.error;
    expect(due).toMatchObject({ code: 'FOLIO_BALANCE_DUE', details: { balance: '5600.00' } });
    expect((await http().post(`/v1/stays/${stay.id}/prepare-check-out`).set(h.desk).send({}).expect(200)).body).toMatchObject({ balance: '5600.00' });
    await http().post(`/v1/folios/${checkedIn.folio.id}/payments`).set(h.desk).send({ method: 'CASH', cashierSessionId: h.deskSession, tendered: '6000.00' }).expect(400); // Idempotency-Key required
    const paid = (await http().post(`/v1/folios/${checkedIn.folio.id}/payments`).set(idem(h.desk)).send({ method: 'CASH', cashierSessionId: h.deskSession, tendered: '6000.00' }).expect(201)).body;
    expect(paid).toMatchObject({ payment: { amount: '5600.00', change: '400.00' }, balance: '0.00' });
    const out = (await http().post(`/v1/stays/${stay.id}/check-out`).set(h.desk).send({}).expect(200)).body;
    expect(out).toMatchObject({ status: 'CHECKED_OUT', folio: { status: 'SETTLED' } });
    expect((await http().get(`/v1/rooms/${h.rooms.r102}`).set(h.desk).expect(200)).body.housekeepingStatus).toBe('DIRTY');
    // A settled folio takes nothing more, in the API and in the database.
    expect((await http().post(`/v1/folios/${checkedIn.folio.id}/adjustments`).set(idem(h.manager)).send({ amount: '100.00', reason: 'Late check-out' }).expect(409)).body.error.code).toBe('FOLIO_SETTLED');
    await expect(sql(h, `INSERT INTO folio_entries (tenant_id, folio_id, stay_id, kind, amount, reason, tax_profile_id) SELECT tenant_id, id, stay_id, 'ADJUSTMENT', 1, 'x', (SELECT id FROM tax_profiles LIMIT 1) FROM folios WHERE id = $1`, [checkedIn.folio.id])).rejects.toThrow(/settled/);
    // Leaving early: the stay ends today, later nights are never charged.
    const early = await inHouse(h, h.rooms.r103, -1, 5);
    await http().post(`/v1/stays/${early.id}/prepare-check-out`).set(h.desk).send({ departEarly: true }).expect(200);
    const nights = await sql<{ n: number }>(h, `SELECT count(*)::int AS n FROM folio_entries WHERE stay_id = $1 AND kind = 'ROOM_NIGHT'`, [early.id]);
    expect(nights[0]!.n).toBe(1);
    expect((await http().get(`/v1/stays/${early.id}`).set(h.desk).expect(200)).body.departureDate).toBe(day(0));
    expect(await asOwnerInTenant(owner, h.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it("a guest's data export lists their stays with the registry; anonymising blanks stay notes, ended stays included", async () => {
    const h = await hotel('lod-privacy');
    const customer = (await http().post('/v1/customers').set(h.auth).send({ displayName: 'Liza Reyes' }).expect(201)).body.id as string;
    const staying = await inHouse(h, h.rooms.r101, 0, 2, { customerId: customer, notes: 'Liza asks for a quiet room' });
    const cancelled = (await book(h, { roomId: h.rooms.r102, arrivalDate: day(10), departureDate: day(11), customerId: customer, notes: 'Liza: late arrival' }).expect(201)).body;
    await http().post(`/v1/stays/${cancelled.id}/cancel`).set(h.desk).send({ reason: 'Plans changed' }).expect(200);
    const dump = (await http().post(`/v1/customers/${customer}/export`).set(h.auth).expect(200)).body;
    expect(dump.stays).toHaveLength(2);
    expect(dump.stays.find((s: { status: string }) => s.status === 'IN_HOUSE')).toMatchObject({ notes: 'Liza asks for a quiet room', guests: [{ fullName: 'Liza Reyes', idNumber: 'P1234567', isPrimary: true }] });
    expect(dump.stays.find((s: { status: string }) => s.status === 'CANCELLED')).toMatchObject({ notes: 'Liza: late arrival', cancelReason: 'Plans changed' });

    await http().post(`/v1/customers/${customer}/anonymise`).set(h.auth).send({ reason: 'Asked to be forgotten' }).expect(200);
    expect(await sql(h, `SELECT notes FROM stays WHERE id = ANY($1) ORDER BY id`, [[staying.id, cancelled.id]])).toEqual([{ notes: null }, { notes: null }]);
    expect(await sql(h, `SELECT id FROM stay_guests WHERE stay_id = $1`, [staying.id])).toEqual([]);
    // An ended stay may only have its notes blanked, never rewritten (0107).
    await expect(sql(h, `UPDATE stays SET notes = 'Someone else' WHERE id = $1`, [cancelled.id])).rejects.toThrow(/has ended/);
  });
});

describe('night audit', () => {
  it('posts each due night once, catches up exactly, prices with VAT and SC/PWD, and adds the accommodation tax', async () => {
    const h = await hotel('lod-audit');
    const stay = await inHouse(h, h.rooms.r101, -3, 2);
    const run = async () => (await http().post('/v1/lodging/night-audit').set(h.desk).send({ branchId: h.h1 }).expect(200)).body;
    expect((await run()).nights).toBe(3); // the three nights before today
    expect((await run()).nights).toBe(0); // idempotent
    const f = await folio(h, stay.folio.id);
    expect(f.entries.map((e: { kind: string; nightDate: string; amount: string; vatableSales: string; vatAmount: string }) => [e.kind, e.nightDate, e.amount, e.vatableSales, e.vatAmount]))
      .toEqual([day(-3), day(-2), day(-1)].map((d) => ['ROOM_NIGHT', d, '2800.00', '2500.00', '300.00']));
    const journal = await sql<{ entry_date: string }>(h, `SELECT entry_date::text FROM journal_entries WHERE source_type = 'FOLIO_ENTRY' ORDER BY entry_date`);
    expect(journal.map((j) => j.entry_date)).toEqual([day(-3), day(-2), day(-1)]);
    // The scheduler's pass (system actor) finds nothing more for this business; another stay's due night is posted.
    const second = await inHouse(h, h.rooms.r102, -1, 1);
    const pass = await app.get(NightAuditScheduler).runOnce();
    expect(pass.find((p) => p.tenantId === h.tenantId)).toMatchObject({ nights: 1 });
    expect(await sql(h, `SELECT actor_type FROM audit_logs WHERE action = 'stay.nights_posted' AND resource_id = $1`, [second.id])).toEqual([{ actor_type: 'SYSTEM' }]);
    // A night the night audit cannot see twice: the database refuses a second ROOM_NIGHT for it.
    await expect(sql(h, `INSERT INTO folio_entries (tenant_id, folio_id, stay_id, kind, amount, night_date, variant_id, tax_profile_id)
      SELECT tenant_id, folio_id, stay_id, kind, amount, night_date, variant_id, tax_profile_id FROM folio_entries WHERE stay_id = $1 AND kind = 'ROOM_NIGHT' LIMIT 1`, [second.id])).rejects.toThrow(/folio_entries_night_once/);

    // SC/PWD: a senior sharing a double room takes the discount on half the night.
    await http().patch(`/v1/branches/${h.h1}/lodging-settings`).set(h.manager).send({ accommodationTaxRate: '0.01' }).expect(200);
    const sc = (await book(h, { roomId: h.rooms.r103, arrivalDate: day(-1), departureDate: day(1), adults: 2, guests: [guest] }).expect(201)).body;
    await http().post(`/v1/stays/${sc.id}/beneficiaries`).set(h.desk).send({ scheme: 'SC', name: 'Lola Reyes', idNumber: 'OSCA-1' }).expect(201);
    await http().post(`/v1/stays/${sc.id}/check-in`).set(h.desk).send({}).expect(200);
    await run();
    const scFolio = await folio(h, (await http().get(`/v1/stays/${sc.id}`).set(h.desk)).body.folio.id);
    const [night, tax] = scFolio.entries;
    expect(night).toMatchObject({ kind: 'ROOM_NIGHT', amount: '2400.00', statutoryDiscount: '250.00', vatAmount: '150.00', vatExemptSales: '1250.00', vatableSales: '1250.00' });
    expect(tax).toMatchObject({ kind: 'ACCOMMODATION_TAX', amount: '22.50', relatedEntryId: night.id }); // 1 % of 2,250.00 net ex VAT
    const book_ = (await http().get('/v1/reports/statutory-book').query({ branchId: h.h1, from: day(-1), to: day(-1) }).set(h.auth).expect(200)).body.data;
    expect(book_).toEqual([expect.objectContaining({ document: 'ROOM_NIGHT', name: 'Lola Reyes', discount: '250.00' })]);
    expect(cents(await gl(h, 'ACCOMMODATION_TAX_PAYABLE'))).toBe(-2250);
    const accTax = (await http().get('/v1/reports/accommodation-tax').query({ branchId: h.h1, from: day(-5), to: day(0) }).set(h.auth).expect(200)).body;
    expect(accTax).toMatchObject({ rate: '0.01', totals: { base: '2250.00', tax: '22.50' } });
    // Reversing the night undoes it and its tax, once.
    await http().post(`/v1/folios/${scFolio.id}/night-reversals`).set(idem(h.desk)).send({ entryId: night.id, reason: 'Wrong night' }).expect(403); // lodging.rates
    const back = (await http().post(`/v1/folios/${scFolio.id}/night-reversals`).set(idem(h.manager)).send({ entryId: night.id, reason: 'Wrong night' }).expect(201)).body;
    expect(back.entries.map((e: { amount: string }) => e.amount)).toEqual(['-2400.00', '-22.50']);
    expect(back.balance).toBe('0.00');
    expect((await http().post(`/v1/folios/${scFolio.id}/night-reversals`).set(idem(h.manager)).send({ entryId: night.id, reason: 'Again' }).expect(409)).body.error.code).toBe('ALREADY_REVERSED');
    expect(cents(await gl(h, 'ACCOMMODATION_TAX_PAYABLE'))).toBe(0);

    // Reports: occupancy and the tax summary see the nights.
    const occ = (await http().get('/v1/reports/occupancy').query({ branchId: h.h1, from: day(-3), to: day(-1) }).set(h.auth).expect(200)).body;
    expect(occ.days.map((d: { roomsSold: number }) => d.roomsSold)).toEqual([1, 1, 2]);
    expect(occ.days[0]).toMatchObject({ roomsAvailable: 3, roomRevenueExVat: '2500.00', adr: '2500.00' });
    const taxSummary = (await http().get('/v1/reports/tax-summary').query({ branchId: h.h1, from: day(-3), to: day(-1) }).set(h.auth).expect(200)).body.data;
    expect(taxSummary[0]).toMatchObject({ vatAmount: '1200.00', vatableSales: '10000.00' });
    const summary = (await http().get('/v1/reports/sales-summary').query({ branchId: h.h1, from: day(-3), to: day(-1) }).set(h.auth).expect(200)).body;
    expect(summary.rooms.totals).toMatchObject({ nights: 5, vatAmount: '1200.00' });
    expect(await asOwnerInTenant(owner, h.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });
});

describe('charge to room', () => {
  it('an outlet of the same entity charges an in-house guest within the limit; other entities, booked stays and offline tills cannot', async () => {
    const h = await hotel('lod-charge');
    const stay = await inHouse(h, h.rooms.r101, 0, 2);
    const found = (await http().get('/v1/stays/in-house').query({ branchId: h.h2, q: '101' }).set(h.cashier).expect(200)).body.data;
    expect(found).toEqual([expect.objectContaining({ stayId: stay.id, roomNumber: '101', guestName: 'Liza Reyes', allowCharges: true })]);
    const sell = (auth: Auth, sessionId: string, tenders: object[], extra: object = {}) =>
      http().post('/v1/sales').set(idem(auth)).send({ cashierSessionId: sessionId, clientTransactionId: randomUUID(), lines: [{ variantId: h.dinner, quantity: '1' }], tenders, ...extra });
    const sale = (await sell(h.cashier, h.outletSession, [{ method: 'ROOM_CHARGE', stayId: stay.id }]).expect(201)).body;
    expect(sale.tenders).toEqual([expect.objectContaining({ method: 'ROOM_CHARGE', stayId: stay.id, amount: '560.00', change: '0.00' })]);
    const receipt = (await http().get(`/v1/sales/${sale.id}/receipt`).set(h.cashier).expect(200)).body;
    expect(receipt.roomCharge).toMatchObject({ line: 'Charged to room 101 — Reyes', amount: '560.00' });
    expect((await folio(h, stay.folio.id)).entries).toEqual([expect.objectContaining({ kind: 'CHARGE', amount: '560.00', saleId: sale.id })]);
    expect(cents(await gl(h, 'GUEST_LEDGER'))).toBe(56000);
    // Limits and rules.
    await http().patch(`/v1/stays/${stay.id}`).set(h.desk).send({ chargeLimit: '1000.00' }).expect(200);
    expect((await sell(h.cashier, h.outletSession, [{ method: 'ROOM_CHARGE', stayId: stay.id }]).expect(409)).body.error).toMatchObject({ code: 'ROOM_CHARGE_LIMIT', details: { available: '440.00' } });
    // Part on the room, the rest in cash.
    await sell(h.cashier, h.outletSession, [{ method: 'ROOM_CHARGE', stayId: stay.id, amount: '440.00' }, { method: 'CASH', tendered: '200.00' }]).expect(201);
    await http().patch(`/v1/stays/${stay.id}`).set(h.desk).send({ allowCharges: false, chargeLimit: null }).expect(200);
    expect((await sell(h.cashier, h.outletSession, [{ method: 'ROOM_CHARGE', stayId: stay.id }]).expect(409)).body.error.code).toBe('ROOM_CHARGES_NOT_ALLOWED');
    await http().patch(`/v1/stays/${stay.id}`).set(h.desk).send({ allowCharges: true }).expect(200);
    expect((await sell(h.otherCashier, h.otherSession, [{ method: 'ROOM_CHARGE', stayId: stay.id }]).expect(422)).body.error.code).toBe('ROOM_CHARGE_WRONG_ENTITY');
    const booked = (await book(h, { roomId: h.rooms.r102, arrivalDate: day(5), departureDate: day(6), guestName: 'Soon' }).expect(201)).body;
    expect((await sell(h.cashier, h.outletSession, [{ method: 'ROOM_CHARGE', stayId: booked.id }]).expect(409)).body.error.code).toBe('GUEST_NOT_IN_HOUSE');
    await sell(h.cashier, h.outletSession, [{ method: 'ROOM_CHARGE', stayId: stay.id }, { method: 'ROOM_CHARGE', stayId: stay.id }]).expect(400);

    // A return while the folio is open goes back onto it; no cash leaves the drawer.
    const drawerBefore = (await http().get(`/v1/cashier-sessions/${h.outletSession}`).set(h.cashier).expect(200)).body.expectedCash;
    const manager2 = await addMember(owner, h.tenantId, 'branch_manager', { type: 'BRANCH', id: h.h2 });
    const mgr2 = bearer(await loginToken(app, manager2.email));
    // An exchange would turn the room charge into cash change (audit 2026-10-21): refused, at the preview too.
    const returnLines = [{ saleLineId: sale.lines[0].id, quantity: '1', disposition: 'DAMAGED' }];
    expect((await http().post(`/v1/sales/${sale.id}/returns/preview`).set(mgr2).send({ lines: returnLines }).expect(409)).body.error.code).toBe('EXCHANGE_ROOM_CHARGE');
    const reg9 = (await http().post('/v1/registers').set(h.auth).send({ branchId: h.h2, code: 'R9', name: 'Exchange desk' }).expect(201)).body.id;
    const mgrSession = (await http().post('/v1/cashier-sessions').set(mgr2).send({ registerId: reg9, openingFloat: '1000.00' }).expect(201)).body.id;
    expect((await http().post('/v1/exchanges').set(idem(mgr2)).send({
      cashierSessionId: mgrSession, saleId: sale.id, reason: 'Other dish', returnLines,
      sale: { clientTransactionId: randomUUID(), lines: [{ variantId: h.dinner, quantity: '1' }], tenders: [] },
    }).expect(409)).body.error.code).toBe('EXCHANGE_ROOM_CHARGE');
    const back =(await http().post(`/v1/sales/${sale.id}/returns`).set(idem(mgr2)).send({ cashierSessionId: h.outletSession, kind: 'RETURN', reason: 'Cold', lines: [{ saleLineId: sale.lines[0].id, quantity: '1', disposition: 'DAMAGED' }] }).expect(201)).body;
    expect(back.refundMethod).toBe('ROOM_CHARGE');
    expect((await http().get(`/v1/cashier-sessions/${h.outletSession}`).set(h.cashier).expect(200)).body.expectedCash).toBe(drawerBefore);
    const f = await folio(h, stay.folio.id);
    expect(f.entries.map((e: { kind: string; amount: string }) => [e.kind, e.amount])).toEqual([['CHARGE', '560.00'], ['CHARGE', '440.00'], ['CHARGE_RETURN', '-560.00']]);
    expect(f.balance).toBe('440.00');
    expect(cents(await gl(h, 'GUEST_LEDGER'))).toBe(44000);

    // Offline: an envelope with a room charge is quarantined, never recorded.
    const reg = (await http().post('/v1/terminals').set(h.auth).send({ registerId: h.r2, name: 'Outlet till' }).expect(201)).body;
    const headers = { 'x-terminal-id': reg.terminal.id, Authorization: `Terminal ${reg.credential}` };
    const snap = (await http().get('/v1/terminal/snapshot').set(headers).expect(200)).body as Snapshot;
    const env: OfflineSale = {
      terminalTxnId: randomUUID(), deviceSeq: 1, snapshotId: snap.snapshotId, cashierSessionId: h.outletSession, cashierUserId: h.cashierId,
      occurredAt: new Date().toISOString(), localReference: `RS-T${snap.terminal.credentialHint}-000001`,
      lines: [{ variantId: h.dinner, quantity: '1' }], tenders: [{ method: 'ROOM_CHARGE', stayId: stay.id }], amountDue: '560.00',
    };
    const synced = (await http().post('/v1/sync/sales').set(headers).send({ sales: [env] }).expect(200)).body.results;
    expect(synced).toEqual([expect.objectContaining({ status: 'QUARANTINED', code: 'ROOM_CHARGE_OFFLINE' })]);
    expect((await folio(h, stay.folio.id)).entries).toHaveLength(3);
    expect(await asOwnerInTenant(owner, h.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });
});

describe('folio payments and deposits', () => {
  it('cash folio payments and deposits are in the drawer, not sales; deposits apply, refund and forfeit with their books', async () => {
    const h = await hotel('lod-money');
    // A deposit with a booking, in cash; held without VAT until applied.
    const stay = (await book(h, { arrivalDate: day(0), departureDate: day(1), guests: [guest] }).expect(201)).body;
    await http().post(`/v1/stays/${stay.id}/deposits`).set(idem(h.desk)).send({ method: 'CASH', cashierSessionId: h.deskSession, amount: '1000.00' }).expect(201);
    await http().post(`/v1/stays/${stay.id}/deposits`).set(idem(h.desk)).send({ method: 'BANK_TRANSFER', amount: '500.00', reference: 'BDO-1' }).expect(403); // lodging.rates
    await http().post(`/v1/stays/${stay.id}/deposits`).set(idem(h.manager)).send({ method: 'BANK_TRANSFER', amount: '500.00', reference: 'BDO-1' }).expect(201);
    expect(cents(await gl(h, 'GUEST_DEPOSITS'))).toBe(-150000);
    const session = async () => (await http().get(`/v1/cashier-sessions/${h.deskSession}`).set(h.desk).expect(200)).body;
    expect((await session()).expectedCash).toBe('6000.00');
    // Card at the front desk: a FOLIO payment.
    const tx = randomUUID();
    const card = (await http().post('/v1/payment-intents').set(idem(h.desk)).send({ cashierSessionId: h.deskSession, clientTransactionId: tx, method: 'CARD', amount: '300.00', purpose: 'FOLIO' }).expect(201)).body;
    await http().post(`/v1/stays/${stay.id}/check-in`).set(h.desk).send({ applyDeposits: true }).expect(200);
    const f0 = (await http().get(`/v1/stays/${stay.id}/folio`).set(h.desk).expect(200)).body;
    expect(f0).toMatchObject({ balance: '0.00', depositsHeld: '1500.00' }); // nothing owed yet: nothing applied
    await http().post(`/v1/stays/${stay.id}/prepare-check-out`).set(h.desk).send({}).expect(200);
    const f1 = await folio(h, f0.id);
    expect(f1).toMatchObject({ balance: '1300.00', depositsHeld: '0.00' });
    const pay = (method: object, auth: Auth = h.desk) => http().post(`/v1/folios/${f0.id}/payments`).set(idem(auth)).send({ cashierSessionId: h.deskSession, ...method });
    await pay({ method: 'INTENT', paymentIntentId: card.id }).expect(201);
    await pay({ method: 'INTENT', paymentIntentId: card.id }).expect(409); // consumed once
    expect((await pay({ method: 'BANK_TRANSFER', amount: '2000.00', reference: 'X' }, h.manager).expect(422)).body.error.code).toBe('OVERPAYMENT');
    await pay({ method: 'CASH', tendered: '1000.00' }).expect(201);
    expect((await pay({ method: 'CASH', tendered: '1.00' }).expect(409)).body.error.code).toBe('NOTHING_TO_PAY');
    await http().post(`/v1/stays/${stay.id}/check-out`).set(h.desk).send({}).expect(200);
    // The drawer holds the cash deposit and the cash payment; the session report lists them apart; no sale.
    expect((await session()).expectedCash).toBe('7000.00');
    const report = (await http().get(`/v1/reports/cashier-sessions/${h.deskSession}`).set(h.desk).expect(200)).body;
    expect(report.sales.count).toBe(0);
    expect(report.frontDeskCollections.cash).toBe('2000.00');
    // The shift closes: the card payment belongs to the folio.
    await http().post(`/v1/cashier-sessions/${h.deskSession}/close`).set(h.desk).send({ countedCash: '7000.00' }).expect(200);

    // Cancellation: the branch keeps deposits by default; refunding against that needs lodging.rates.
    const s2 = await (async () => {
      const d2 = (await http().post('/v1/cashier-sessions').set(h.desk).send({ registerId: h.r1, openingFloat: '500.00' }).expect(201)).body.id as string;
      return { d2 };
    })();
    const cancelled = (await book(h, { roomId: h.rooms.r102, arrivalDate: day(7), departureDate: day(9), guestName: 'Keeps' }).expect(201)).body;
    await http().post(`/v1/stays/${cancelled.id}/deposits`).set(idem(h.desk)).send({ method: 'CASH', cashierSessionId: s2.d2, amount: '1120.00' }).expect(201);
    await http().post(`/v1/stays/${cancelled.id}/cancel`).set(h.desk).send({ reason: 'No longer coming' }).expect(200);
    const kept = (await http().get(`/v1/stays/${cancelled.id}/deposits`).set(h.desk).expect(200)).body;
    expect(kept.data.map((d: { kind: string; amount: string; netAmount: string | null; vatAmount: string | null }) => [d.kind, d.amount, d.netAmount, d.vatAmount]))
      .toEqual([['RECEIVED', '1120.00', null, null], ['FORFEITED', '-1120.00', '1000.00', '120.00']]);
    expect(cents(await gl(h, 'CANCELLATION_INCOME'))).toBe(-100000);
    const refunded = (await book(h, { roomId: h.rooms.r103, arrivalDate: day(7), departureDate: day(9), guestName: 'Refund' }).expect(201)).body;
    await http().post(`/v1/stays/${refunded.id}/deposits`).set(idem(h.desk)).send({ method: 'CASH', cashierSessionId: s2.d2, amount: '700.00' }).expect(201);
    await http().post(`/v1/stays/${refunded.id}/cancel`).set(h.desk).send({ reason: 'Typhoon', deposits: 'REFUND', refund: { method: 'CASH', cashierSessionId: s2.d2 } }).expect(403);
    await http().post(`/v1/stays/${refunded.id}/cancel`).set(h.manager).send({ reason: 'Typhoon', deposits: 'REFUND', refund: { method: 'CASH', cashierSessionId: s2.d2 } }).expect(200);
    expect((await http().get(`/v1/cashier-sessions/${s2.d2}`).set(h.desk).expect(200)).body.expectedCash).toBe('1620.00'); // 500 + 1,120 kept; 700 in and out
    expect(cents(await gl(h, 'GUEST_DEPOSITS'))).toBe(0);

    // The guest ledger report ties to the books.
    const ledger = (await http().get('/v1/reports/guest-ledger').query({ legalEntityId: h.le }).set(h.auth).expect(200)).body;
    expect(ledger.totals).toMatchObject({ guestLedgerDifference: '0.00', depositsDifference: '0.00' });
    expect(await asOwnerInTenant(owner, h.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('a goodwill credit and a fee are VAT-inclusive adjustments; nobody pays more than the folio owes', async () => {
    const h = await hotel('lod-adjust');
    const stay = await inHouse(h, h.rooms.r101, 0, 1);
    await http().post(`/v1/stays/${stay.id}/prepare-check-out`).set(h.desk).send({}).expect(200);
    await http().post(`/v1/folios/${stay.folio.id}/adjustments`).set(idem(h.desk)).send({ amount: '-280.00', reason: 'Noisy room' }).expect(403);
    const credit = (await http().post(`/v1/folios/${stay.folio.id}/adjustments`).set(idem(h.manager)).send({ amount: '-280.00', reason: 'Noisy room' }).expect(201)).body;
    expect(credit.entry).toMatchObject({ kind: 'ADJUSTMENT', amount: '-280.00', vatableSales: '-250.00', vatAmount: '-30.00' });
    expect(credit.balance).toBe('2520.00');
    expect((await http().post(`/v1/folios/${stay.folio.id}/adjustments`).set(idem(h.manager)).send({ amount: '-3000.00', reason: 'Too much' }).expect(409)).body.error.code).toBe('FOLIO_OVERPAID');
    expect(cents(await gl(h, 'ROOM_REVENUE'))).toBe(-225000);
  });
});

describe('audit 2026-10-21', () => {
  it('check-in refuses a room a guest still holds; an early check-in starts the stay today; a guest in house moves only to a ready, empty room', async () => {
    const h = await hotel('lod-a-room');
    // A guest past their departure but not checked out still holds 101: the booking rule no longer sees them.
    const overstay = await inHouse(h, h.rooms.r101, -2, -1);
    const next = (await book(h, { roomId: h.rooms.r101, arrivalDate: day(0), departureDate: day(1), guests: [guest] }).expect(201)).body;
    expect((await http().post(`/v1/stays/${next.id}/check-in`).set(h.desk).send({}).expect(409)).body.error).toMatchObject({ code: 'ROOM_OCCUPIED', details: { stayId: overstay.id } });
    // Early (the day before arrival): the stay starts tonight, so tonight is charged and checked against other bookings.
    const early = (await book(h, { roomId: h.rooms.r102, arrivalDate: day(1), departureDate: day(3), guests: [guest] }).expect(201)).body;
    const inEarly = (await http().post(`/v1/stays/${early.id}/check-in`).set(h.desk).send({}).expect(200)).body;
    expect([inEarly.status, inEarly.arrivalDate]).toEqual(['IN_HOUSE', day(0)]);
    expect(await sql(h, `SELECT metadata->>'earlyCheckIn' AS e, metadata->>'previousArrivalDate' AS p FROM audit_logs WHERE action = 'stay.checked_in' AND resource_id = $1`, [early.id]))
      .toEqual([{ e: 'true', p: day(1) }]);
    await inHouse(h, h.rooms.r103, 0, 1);
    const tomorrow = (await book(h, { roomId: h.rooms.r103, arrivalDate: day(1), departureDate: day(2), guests: [guest] }).expect(201)).body;
    expect((await http().post(`/v1/stays/${tomorrow.id}/check-in`).set(h.desk).send({}).expect(409)).body.error.code).toBe('ROOM_OCCUPIED');
    // Moving the early guest: not into a room someone holds, not into a dirty room; the room left is dirty.
    expect((await http().patch(`/v1/stays/${early.id}`).set(h.desk).send({ roomId: h.rooms.r101 }).expect(409)).body.error.code).toBe('ROOM_OCCUPIED');
    await http().post(`/v1/stays/${next.id}/cancel`).set(h.manager).send({ reason: 'Moved' }).expect(200);
    await http().post(`/v1/rooms/${h.rooms.r101}/status`).set(h.housekeeping).send({ status: 'DIRTY' }).expect(200);
    expect((await http().patch(`/v1/stays/${early.id}`).set(h.desk).send({ roomId: h.rooms.r101 }).expect(409)).body.error.code).toBe('ROOM_NOT_READY');
    await http().post(`/v1/rooms/${h.rooms.r101}/status`).set(h.housekeeping).send({ status: 'CLEAN' }).expect(200);
    // 101 is clean but the overstaying guest is still in it.
    expect((await http().patch(`/v1/stays/${early.id}`).set(h.desk).send({ roomId: h.rooms.r101 }).expect(409)).body.error.code).toBe('ROOM_OCCUPIED');
    await sql(h, `UPDATE stays SET status = 'CHECKED_OUT', checked_out_at = now() WHERE id = $1`, [overstay.id]);
    await http().patch(`/v1/stays/${early.id}`).set(h.desk).send({ roomId: h.rooms.r101 }).expect(200);
    expect((await http().get(`/v1/rooms/${h.rooms.r102}`).set(h.desk).expect(200)).body.housekeepingStatus).toBe('DIRTY');
  });

  it('the registry of an ended stay is closed; a guest in house keeps a primary guest', async () => {
    const h = await hotel('lod-a-guests');
    const stay = await inHouse(h, h.rooms.r101, 0, 1);
    const [primary] = (await http().get(`/v1/stays/${stay.id}/guests`).set(h.desk).expect(200)).body.data;
    expect((await http().patch(`/v1/stays/${stay.id}/guests/${primary.id}`).set(h.desk).send({ isPrimary: false }).expect(409)).body.error.code).toBe('PRIMARY_GUEST_REQUIRED');
    const booked = (await book(h, { roomId: h.rooms.r102, arrivalDate: day(3), departureDate: day(4), guests: [guest] }).expect(201)).body;
    const [g] = (await http().get(`/v1/stays/${booked.id}/guests`).set(h.desk).expect(200)).body.data;
    await http().post(`/v1/stays/${booked.id}/cancel`).set(h.manager).send({ reason: 'Plans changed' }).expect(200);
    expect((await http().patch(`/v1/stays/${booked.id}/guests/${g.id}`).set(h.desk).send({ fullName: 'Someone Else' }).expect(409)).body.error.code).toBe('STAY_ENDED');
    expect((await http().delete(`/v1/stays/${booked.id}/guests/${g.id}`).set(h.desk).expect(409)).body.error.code).toBe('STAY_ENDED');
  });

  it("refunding a booking's deposit where the branch keeps deposits needs lodging.rates", async () => {
    const h = await hotel('lod-a-refund');
    const stay = (await book(h, { roomId: h.rooms.r102, arrivalDate: day(5), departureDate: day(6), guestName: 'Ana' }).expect(201)).body;
    await http().post(`/v1/stays/${stay.id}/deposits`).set(idem(h.desk)).send({ method: 'CASH', cashierSessionId: h.deskSession, amount: '500.00' }).expect(201);
    const refund = { reason: 'Guest asked', refund: { method: 'CASH', cashierSessionId: h.deskSession } };
    expect((await http().post(`/v1/stays/${stay.id}/deposits/refund`).set(idem(h.desk)).send(refund).expect(403)).body.error.details.missing).toEqual(['lodging.rates']);
    await http().post(`/v1/stays/${stay.id}/deposits/refund`).set(idem(h.manager)).send({ reason: 'Guest asked', refund: { method: 'BANK_TRANSFER', reference: 'BDO-9' } }).expect(200);
    // A branch that refunds on cancel lets the front desk give it back.
    await http().patch(`/v1/branches/${h.h1}/lodging-settings`).set(h.manager).send({ forfeitOnCancel: false }).expect(200);
    await http().post(`/v1/stays/${stay.id}/deposits`).set(idem(h.desk)).send({ method: 'CASH', cashierSessionId: h.deskSession, amount: '300.00' }).expect(201);
    await http().post(`/v1/stays/${stay.id}/deposits/refund`).set(idem(h.desk)).send(refund).expect(200);
  });

  it("the statement counts a reversed night's accommodation tax with the tax, not with the nights", async () => {
    const h = await hotel('lod-a-stmt');
    await http().patch(`/v1/branches/${h.h1}/lodging-settings`).set(h.manager).send({ accommodationTaxRate: '0.01' }).expect(200);
    const stay = await inHouse(h, h.rooms.r101, -1, 1);
    await http().post('/v1/lodging/night-audit').set(h.desk).send({ branchId: h.h1 }).expect(200);
    const night = (await folio(h, stay.folio.id)).entries.find((e: { kind: string }) => e.kind === 'ROOM_NIGHT');
    const before = (await http().get(`/v1/folios/${stay.folio.id}/statement`).set(h.desk).expect(200)).body.totals;
    expect(before).toMatchObject({ roomNights: '2800.00', accommodationTax: '25.00' });
    await http().post(`/v1/folios/${stay.folio.id}/night-reversals`).set(idem(h.manager)).send({ entryId: night.id, reason: 'Wrong night' }).expect(201);
    const after = (await http().get(`/v1/folios/${stay.folio.id}/statement`).set(h.desk).expect(200)).body.totals;
    expect(after).toMatchObject({ roomNights: '0.00', accommodationTax: '0.00', balance: '0.00' });
  });

  it("a folio's writers take its locks in one order: a payment, an adjustment, a room charge and a check-out at once never deadlock", async () => {
    const h = await hotel('lod-a-locks');
    for (const roomId of [h.rooms.r101, h.rooms.r102, h.rooms.r103]) {
      const stay = await inHouse(h, roomId, 0, 1);
      await http().post(`/v1/stays/${stay.id}/prepare-check-out`).set(h.desk).send({}).expect(200);
      const results = await Promise.all([
        http().post(`/v1/folios/${stay.folio.id}/payments`).set(idem(h.desk)).send({ method: 'CASH', cashierSessionId: h.deskSession, tendered: '100.00' }),
        http().post(`/v1/folios/${stay.folio.id}/adjustments`).set(idem(h.manager)).send({ amount: '-50.00', reason: 'Late towels' }),
        http().post('/v1/sales').set(idem(h.cashier)).send({ cashierSessionId: h.outletSession, clientTransactionId: randomUUID(), lines: [{ variantId: h.dinner, quantity: '1' }], tenders: [{ method: 'ROOM_CHARGE', stayId: stay.id }] }),
        http().post(`/v1/stays/${stay.id}/check-out`).set(h.desk).send({}),
      ]);
      // Check-out is refused (a balance is due); nothing fails on a lock cycle (40P01 would be a 5xx).
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 409]);
    }
  });
});

describe('fixes 2026-10-21 (overstays, occupied, night audit, rates)', () => {
  it('an overstay is shown, counted by the night audit, and charged at check-out once the departure moves to today; a booking in the way is named', async () => {
    const h = await hotel('lod-f-over');
    const stay = await inHouse(h, h.rooms.r101, -3, -1); // should have left yesterday
    expect((await http().get(`/v1/stays/${stay.id}`).set(h.desk).expect(200)).body).toMatchObject({ status: 'IN_HOUSE', overstay: true });
    expect((await http().get('/v1/stays').query({ branchId: h.h1, status: 'IN_HOUSE' }).set(h.desk).expect(200)).body.data[0]).toMatchObject({ id: stay.id, overstay: true });
    // Occupied sits beside the housekeeping status (no status of its own).
    const board = (await http().get('/v1/lodging/housekeeping').query({ branchId: h.h1 }).set(h.housekeeping).expect(200)).body.data;
    expect(board.find((r: { number: string }) => r.number === '101')).toMatchObject({ status: 'CLEAN', occupied: true, overstay: true, departingToday: true });
    expect(board.find((r: { number: string }) => r.number === '102')).toMatchObject({ occupied: false, overstay: false });
    expect((await http().get(`/v1/rooms/${h.rooms.r101}`).set(h.desk).expect(200)).body).toMatchObject({ housekeepingStatus: 'CLEAN', occupied: true, occupiedByStayId: stay.id });
    const avail = (await http().get('/v1/lodging/availability').query({ branchId: h.h1, from: day(0), to: day(1) }).set(h.desk).expect(200)).body;
    expect(avail.rooms.find((r: { roomId: string }) => r.roomId === h.rooms.r101)).toMatchObject({ occupied: true });
    // The night audit still stops at the departure, and reports the overstay.
    const audit = (await http().post('/v1/lodging/night-audit').set(h.desk).send({ branchId: h.h1 }).expect(200)).body;
    expect(audit).toMatchObject({ nights: 2, failed: [], overstays: 1, overstayStayIds: [stay.id] });
    // A booking of the room starting yesterday is in the way: named, nothing changes.
    const next = (await book(h, { arrivalDate: day(-1), departureDate: day(2), guestName: 'Next' }).expect(201)).body;
    const refused = (await http().post(`/v1/stays/${stay.id}/prepare-check-out`).set(h.desk).send({}).expect(409)).body.error;
    expect(refused).toMatchObject({ code: 'ROOM_DOUBLE_BOOKED', details: { overstay: true, conflictingStayId: next.id, extendTo: day(0) } });
    expect((await http().get(`/v1/stays/${stay.id}`).set(h.desk).expect(200)).body.departureDate).toBe(day(-1));
    await http().post(`/v1/stays/${next.id}/cancel`).set(h.desk).send({ reason: 'Moved to another room' }).expect(200);
    // Now the departure moves to today and last night is charged: three nights.
    expect((await http().post(`/v1/stays/${stay.id}/prepare-check-out`).set(h.desk).send({}).expect(200)).body).toMatchObject({ balance: '8400.00' });
    const after = (await http().get(`/v1/stays/${stay.id}`).set(h.desk).expect(200)).body;
    expect([after.departureDate, after.overstay, after.nightsPosted]).toEqual([day(0), false, 3]);
    expect((await sql<{ metadata: Record<string, unknown> }>(h, `SELECT metadata FROM audit_logs WHERE action = 'stay.changed' AND resource_id = $1`, [stay.id]))[0]!.metadata)
      .toMatchObject({ overstay: true, departureDate: day(0), previousDepartureDate: day(-1) });
    await http().post(`/v1/folios/${stay.folio.id}/payments`).set(idem(h.desk)).send({ method: 'CASH', cashierSessionId: h.deskSession, tendered: '8400.00' }).expect(201);
    await http().post(`/v1/stays/${stay.id}/check-out`).set(h.desk).send({}).expect(200);
    expect(await asOwnerInTenant(owner, h.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('the manual night audit posts each stay in its own transaction: one that cannot post is reported, the others are charged', async () => {
    const h = await hotel('lod-f-audit');
    const pc = ((await http().get('/v1/uoms').set(h.auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
    const vat = ((await http().get('/v1/tax-categories').set(h.auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
    // A suite whose night item has no price yet: its nights cannot be priced.
    const unpriced = (await http().post('/v1/products').set(h.auth).send({ name: 'Suite night', uomId: pc, taxCategoryId: vat, productType: 'SERVICE', trackInventory: false, variants: [{ sku: uniq('STE') }] }).expect(201)).body.variants[0].id as string;
    const suite = (await http().post('/v1/room-types').set(idem(h.auth)).send({ code: 'STE', name: 'Suite', nightVariantId: unpriced }).expect(201)).body;
    const r201 = (await http().post('/v1/rooms').set(idem(h.auth)).send({ branchId: h.h1, roomTypeId: suite.id, number: '201' }).expect(201)).body.id as string;
    const ok = await inHouse(h, h.rooms.r101, -2, 2);
    const broken = await inHouse(h, r201, -2, 2);
    const run = (await http().post('/v1/lodging/night-audit').set(h.desk).send({ branchId: h.h1 }).expect(200)).body;
    expect(run).toMatchObject({ nights: 2, stays: [{ stayId: ok.id, nights: [day(-2), day(-1)] }], failed: [{ stayId: broken.id, code: 'ITEM_NOT_PRICED' }], overstays: 0 });
    expect(await sql(h, `SELECT count(*)::int AS n FROM folio_entries WHERE stay_id = $1`, [broken.id])).toEqual([{ n: 0 }]);
  });

  it('a new rate for a guest in house charges the nights already due at the old rate first', async () => {
    const h = await hotel('lod-f-rate');
    const stay = await inHouse(h, h.rooms.r101, -2, 2);
    await http().patch(`/v1/stays/${stay.id}`).set(h.desk).send({ nightlyRate: '2000.00' }).expect(403); // lodging.rates
    const changed = (await http().patch(`/v1/stays/${stay.id}`).set(h.manager).send({ nightlyRate: '2000.00' }).expect(200)).body;
    expect([changed.nightlyRate, changed.nightsPosted]).toEqual(['2000.00', 2]);
    await http().post(`/v1/stays/${stay.id}/prepare-check-out`).set(h.desk).send({}).expect(200);
    const f = await folio(h, stay.folio.id);
    expect(f.entries.map((e: { nightDate: string; amount: string }) => [e.nightDate, e.amount])).toEqual([[day(-2), '2800.00'], [day(-1), '2800.00'], [day(0), '2000.00'], [day(1), '2000.00']]);
    expect((await sql<{ metadata: Record<string, unknown> }>(h, `SELECT metadata FROM audit_logs WHERE action = 'stay.changed' AND resource_id = $1`, [stay.id]))[0]!.metadata)
      .toMatchObject({ nightlyRate: '2000.00', previousNightlyRate: null, nightsPostedAtPreviousRate: [day(-2), day(-1)] });
  });
});
