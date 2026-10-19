import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/** Menu foundation (ADR-0014 §2, §3, §5, §9 — Phase 4 slice 2). */
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

async function restaurant(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const br2 = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201);
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price?: string) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: vat, trackInventory: false, variants: [{ sku: uniq('SKU'), ...(price && { price }) }] }).expect(201)).body.variants[0].id as string;
  const member = async (role: string, branchId = br.body.id as string) => bearer(await loginToken(app, (await addMember(owner, t.tenantId, role, { type: 'BRANCH', id: branchId })).email));
  return {
    tenantId: t.tenantId, auth, branchId: br.body.id as string, branch2Id: br2.body.id as string, product,
    manager: await member('branch_manager'), cashier: await member('cashier'), otherCashier: await member('cashier', br2.body.id), inventory: await member('inventory_officer'),
  };
}
type R = Awaited<ReturnType<typeof restaurant>>;

const sql = <T = Record<string, unknown>>(r: R, q: string, params: unknown[] = []) =>
  asOwnerInTenant(owner, r.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const code = (res: request.Response) => res.body.error?.code;

/** Burger (₱150) with a required doneness choice and an optional priced cheese (₱20); Iced tea (₱45). */
async function menuWithModifiers(r: R) {
  const burger = await r.product('Burger', '150.00');
  const tea = await r.product('Iced tea', '45.00');
  const cheese = await r.product('Extra cheese', '20.00');
  const doneness = (await http().post('/v1/modifier-groups').set(r.auth).send({
    name: 'Doneness', minSelect: 1, maxSelect: 1, options: [{ name: 'Medium' }, { name: 'Well done' }],
  }).expect(201)).body;
  const extras = (await http().post('/v1/modifier-groups').set(r.auth).send({
    name: 'Extras', minSelect: 0, maxSelect: 3, options: [{ name: 'Cheese', variantId: cheese }, { name: 'No onions' }],
  }).expect(201)).body;
  const menu = (await http().post('/v1/menus').set(r.auth).send({ name: 'All day' }).expect(201)).body;
  const content = {
    sections: [
      { name: 'Mains', items: [{ variantId: burger, stationCode: 'grill', modifierGroupIds: [doneness.id, extras.id] }] },
      { name: 'Drinks', items: [{ variantId: tea, stationCode: 'BAR', displayName: 'House iced tea' }] },
    ],
  };
  await http().put(`/v1/menu-versions/${menu.draft.id}/content`).set(r.auth).send(content).expect(200);
  return { burger, tea, cheese, doneness, extras, menu, content };
}

describe('floor set-up: stations, areas, tables', () => {
  it('stations route by code with one default per branch; areas hold tables; codes are unique per branch', async () => {
    const r = await restaurant('rst-floor');
    const grill = (await http().post('/v1/kitchen-stations').set(r.auth).send({ branchId: r.branchId, code: 'grill', name: 'Grill', isDefault: true }).expect(201)).body;
    expect(grill).toMatchObject({ code: 'GRILL', isDefault: true });
    expect(code(await http().post('/v1/kitchen-stations').set(r.auth).send({ branchId: r.branchId, code: 'GRILL', name: 'Again' }).expect(409))).toBe('STATION_CODE_TAKEN');
    await http().post('/v1/kitchen-stations').set(r.auth).send({ branchId: r.branch2Id, code: 'GRILL', name: 'Grill 2' }).expect(201); // other branch: fine
    const bar = (await http().post('/v1/kitchen-stations').set(r.auth).send({ branchId: r.branchId, code: 'BAR', name: 'Bar', isDefault: true }).expect(201)).body;
    const stations = (await http().get('/v1/kitchen-stations').query({ branchId: r.branchId }).set(r.cashier).expect(200)).body.data;
    expect(stations.map((s: { code: string; isDefault: boolean }) => [s.code, s.isDefault])).toEqual([['BAR', true], ['GRILL', false]]);
    await http().post(`/v1/kitchen-stations/${bar.id}/archive`).set(r.auth).expect(200);
    await http().patch(`/v1/kitchen-stations/${bar.id}`).set(r.auth).send({ name: 'x' }).expect(409);

    const hall = (await http().post('/v1/dining-areas').set(r.auth).send({ branchId: r.branchId, name: 'Hall' }).expect(201)).body;
    const patio = (await http().post('/v1/dining-areas').set(r.auth).send({ branchId: r.branchId, name: 'Patio', sortOrder: 1 }).expect(201)).body;
    const away = (await http().post('/v1/dining-areas').set(r.auth).send({ branchId: r.branch2Id, name: 'Hall' }).expect(201)).body;
    expect(code(await http().post('/v1/dining-areas').set(r.auth).send({ branchId: r.branchId, name: 'hall' }).expect(409))).toBe('AREA_NAME_TAKEN');
    const t1 = (await http().post('/v1/restaurant-tables').set(r.auth).send({ areaId: hall.id, code: 'T1', seats: 4, position: { x: 2, y: 3 }, shape: 'ROUND' }).expect(201)).body;
    expect(t1).toMatchObject({ code: 'T1', seats: 4, position: { x: 2, y: 3 }, shape: 'ROUND', branchId: r.branchId });
    expect(code(await http().post('/v1/restaurant-tables').set(r.auth).send({ areaId: patio.id, code: 't1' }).expect(409))).toBe('TABLE_CODE_TAKEN');
    await http().post('/v1/restaurant-tables').set(r.auth).send({ areaId: away.id, code: 'T1' }).expect(201); // same code, other branch
    // Move within the branch; never into another branch's area (API and FK).
    await http().patch(`/v1/restaurant-tables/${t1.id}`).set(r.auth).send({ areaId: patio.id, position: null }).expect(200);
    await http().patch(`/v1/restaurant-tables/${t1.id}`).set(r.auth).send({ areaId: away.id }).expect(404);
    await expect(sql(r, `UPDATE restaurant_tables SET area_id = $1 WHERE id = $2`, [away.id, t1.id])).rejects.toThrow(/foreign key/);

    const floor = (await http().get('/v1/dining-areas').query({ branchId: r.branchId }).set(r.cashier).expect(200)).body.data;
    expect(floor.map((a: { name: string; tables: { code: string; position: unknown }[] }) => [a.name, a.tables.map((t) => [t.code, t.position])])).toEqual([['Hall', []], ['Patio', [['T1', null]]]]);
    expect(code(await http().post(`/v1/dining-areas/${patio.id}/archive`).set(r.auth).expect(409))).toBe('AREA_HAS_TABLES');
    await http().post(`/v1/restaurant-tables/${t1.id}/archive`).set(r.auth).expect(200);
    await http().post(`/v1/dining-areas/${patio.id}/archive`).set(r.auth).expect(200);
    await expect(sql(r, `DELETE FROM restaurant_tables`)).rejects.toThrow();
  });

  it('access: managers of the restaurant set up, floor staff and kitchen read their branch only', async () => {
    const r = await restaurant('rst-floor-acl');
    // The built-in branch manager runs service but does not hold restaurant.manage.
    expect(code(await http().post('/v1/dining-areas').set(r.manager).send({ branchId: r.branchId, name: 'Hall' }).expect(403))).toBe('FORBIDDEN');
    await http().post('/v1/dining-areas').set(r.cashier).send({ branchId: r.branchId, name: 'Hall' }).expect(403);
    await http().post('/v1/dining-areas').set(r.auth).send({ branchId: r.branchId, name: 'Hall' }).expect(201);
    await http().get('/v1/dining-areas').query({ branchId: r.branchId }).set(r.cashier).expect(200);
    await http().get('/v1/dining-areas').query({ branchId: r.branchId }).set(r.otherCashier).expect(403);
    await http().get('/v1/dining-areas').query({ branchId: r.branchId }).set(r.inventory).expect(403);
    await http().get('/v1/dining-areas').query({ branchId: randomUUID() }).set(r.auth).expect(404);
    await owner.query('SELECT platform_set_subscription($1, $2, $3, $4, $5)', [r.tenantId, 'starter', 'ACTIVE', null, null]);
    expect(code(await http().post('/v1/dining-areas').set(r.auth).send({ branchId: r.branchId, name: 'Patio' }).expect(403))).toBe('ENTITLEMENT_REQUIRED');
  });
});

describe('modifiers', () => {
  it('groups bound their choices; priced options point to items; groups keep enough options', async () => {
    const r = await restaurant('rst-mod');
    const cheese = await r.product('Extra cheese', '20.00');
    await http().post('/v1/modifier-groups').set(r.auth).send({ name: 'Bad', minSelect: 2, maxSelect: 1, options: [{ name: 'A' }, { name: 'B' }] }).expect(400);
    await http().post('/v1/modifier-groups').set(r.auth).send({ name: 'Bad', minSelect: 3, maxSelect: 3, options: [{ name: 'A' }, { name: 'B' }] }).expect(400);
    await http().post('/v1/modifier-groups').set(r.auth).send({ name: 'Bad', options: [{ name: 'A' }, { name: 'a' }] }).expect(400);
    await http().post('/v1/modifier-groups').set(r.auth).send({ name: 'Bad', options: [{ name: 'A', variantId: randomUUID() }] }).expect(404);
    const g = (await http().post('/v1/modifier-groups').set(r.auth).send({ name: 'Extras', maxSelect: 2, options: [{ name: 'Cheese', variantId: cheese }, { name: 'No onions' }] }).expect(201)).body;
    expect(g).toMatchObject({ name: 'Extras', minSelect: 0, maxSelect: 2, required: false });
    expect(g.options.map((o: { name: string; variantId: string | null }) => [o.name, o.variantId])).toEqual([['Cheese', cheese], ['No onions', null]]);

    const bacon = (await http().post(`/v1/modifier-groups/${g.id}/options`).set(r.auth).send({ name: 'Bacon' }).expect(201)).body;
    expect(code(await http().post(`/v1/modifier-groups/${g.id}/options`).set(r.auth).send({ name: 'bacon' }).expect(409))).toBe('OPTION_NAME_TAKEN');
    expect(code(await http().patch(`/v1/modifier-groups/${g.id}`).set(r.auth).send({ minSelect: 4, maxSelect: 4 }).expect(422))).toBe('TOO_FEW_OPTIONS');
    await http().patch(`/v1/modifier-groups/${g.id}`).set(r.auth).send({ minSelect: 2 }).expect(200);
    // Three options, two required: one may go, the next would leave too few.
    await http().post(`/v1/modifier-options/${bacon.id}/archive`).set(r.auth).expect(200);
    expect(code(await http().post(`/v1/modifier-options/${g.options[1].id}/archive`).set(r.auth).expect(409))).toBe('TOO_FEW_OPTIONS');
    const list = (await http().get('/v1/modifier-groups').set(r.auth).expect(200)).body.data;
    expect(list.map((x: { name: string; minSelect: number; options: { name: string }[] }) => [x.name, x.minSelect, x.options.map((o) => o.name)])).toEqual([['Extras', 2, ['Cheese', 'No onions']]]);
    await http().post('/v1/modifier-groups').set(r.manager).send({ name: 'X', options: [{ name: 'A' }] }).expect(403);
  });
});

describe('menus and versions', () => {
  it('draft → publish → frozen; a new draft copies the published content; publishing retires the old version', async () => {
    const r = await restaurant('rst-menu');
    const m = await menuWithModifiers(r);
    const draft = (await http().get(`/v1/menu-versions/${m.menu.draft.id}`).set(r.auth).expect(200)).body;
    expect(draft.status).toBe('DRAFT');
    expect(draft.sections.map((s: { name: string; items: { name: string; stationCode: string; modifierGroupIds: string[] }[] }) => [s.name, s.items.map((i) => [i.name, i.stationCode, i.modifierGroupIds.length])]))
      .toEqual([['Mains', [['Burger', 'GRILL', 2]]], ['Drinks', [['House iced tea', 'BAR', 0]]]]);

    const empty = (await http().post('/v1/menus').set(r.auth).send({ name: 'Empty' }).expect(201)).body;
    expect(code(await http().post(`/v1/menu-versions/${empty.draft.id}/publish`).set(r.auth).expect(422))).toBe('MENU_EMPTY');
    expect(code(await http().post('/v1/menus').set(r.auth).send({ name: 'all day' }).expect(409))).toBe('MENU_NAME_TAKEN');

    const v1 = (await http().post(`/v1/menu-versions/${m.menu.draft.id}/publish`).set(r.auth).expect(200)).body;
    expect(v1).toMatchObject({ status: 'PUBLISHED', version: 1 });
    expect(code(await http().put(`/v1/menu-versions/${v1.id}/content`).set(r.auth).send(m.content).expect(409))).toBe('VERSION_NOT_DRAFT');
    expect(code(await http().post(`/v1/menu-versions/${v1.id}/publish`).set(r.auth).expect(409))).toBe('VERSION_NOT_DRAFT');
    // The database freezes published content and refuses going backwards, whoever writes.
    await expect(sql(r, `UPDATE menu_items SET station_code = 'X' WHERE menu_version_id = $1`, [v1.id])).rejects.toThrow(/only a draft/);
    await expect(sql(r, `DELETE FROM menu_sections WHERE menu_version_id = $1`, [v1.id])).rejects.toThrow(/only a draft/);
    await expect(sql(r, `UPDATE menu_versions SET status = 'DRAFT', published_at = NULL WHERE id = $1`, [v1.id])).rejects.toThrow(/cannot become/);
    await expect(sql(r, `INSERT INTO menu_versions (tenant_id, menu_id, version, status, published_at, created_by) VALUES ($1, $2, 9, 'PUBLISHED', now(), $1)`, [r.tenantId, m.menu.id])).rejects.toThrow(/starts as a draft/);

    const v2 = (await http().post(`/v1/menus/${m.menu.id}/drafts`).set(r.auth).expect(201)).body;
    expect(v2).toMatchObject({ status: 'DRAFT', version: 2 });
    expect(v2.sections.flatMap((s: { items: unknown[] }) => s.items)).toHaveLength(2);
    expect(code(await http().post(`/v1/menus/${m.menu.id}/drafts`).set(r.auth).expect(409))).toBe('DRAFT_EXISTS');
    await http().put(`/v1/menu-versions/${v2.id}/content`).set(r.auth).send({ sections: [m.content.sections[0]] }).expect(200);
    await http().post(`/v1/menu-versions/${v2.id}/publish`).set(r.auth).expect(200);
    const menu = (await http().get(`/v1/menus/${m.menu.id}`).set(r.auth).expect(200)).body;
    expect(menu.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[2, 'PUBLISHED'], [1, 'RETIRED']]);
    expect(menu.draft).toBeNull();
    // v1 still shows what it offered.
    expect((await http().get(`/v1/menu-versions/${v1.id}`).set(r.auth).expect(200)).body.sections).toHaveLength(2);
  });

  it('five concurrent publishes of one draft: one wins, the rest are refused; one published version', async () => {
    const r = await restaurant('rst-menu-race');
    const m = await menuWithModifiers(r);
    const res = await Promise.all(Array.from({ length: 5 }, () => http().post(`/v1/menu-versions/${m.menu.draft.id}/publish`).set(r.auth)));
    expect(res.map((x) => x.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(await sql(r, `SELECT status FROM menu_versions WHERE menu_id = $1`, [m.menu.id])).toEqual([{ status: 'PUBLISHED' }]);
  });

  it('content refers to active items and groups only; archived groups block publishing', async () => {
    const r = await restaurant('rst-menu-refs');
    const m = await menuWithModifiers(r);
    await http().put(`/v1/menu-versions/${m.menu.draft.id}/content`).set(r.auth).send({ sections: [{ name: 'X', items: [{ variantId: randomUUID() }] }] }).expect(404);
    await http().put(`/v1/menu-versions/${m.menu.draft.id}/content`).set(r.auth).send({ sections: [{ name: 'X', items: [{ variantId: m.tea, modifierGroupIds: [randomUUID()] }] }] }).expect(404);
    await http().put(`/v1/menu-versions/${m.menu.draft.id}/content`).set(r.auth).send({ sections: [{ name: 'X', items: [{ variantId: m.tea }, { variantId: m.tea }] }] }).expect(400);
    await http().post(`/v1/modifier-groups/${m.extras.id}/archive`).set(r.auth).expect(200);
    expect(code(await http().post(`/v1/menu-versions/${m.menu.draft.id}/publish`).set(r.auth).expect(422))).toBe('ARCHIVED');
    await http().put(`/v1/menu-versions/${m.menu.draft.id}/content`).set(r.auth).send(m.content).expect(422);
  });
});

describe('what a branch serves', () => {
  it('assigned published menu with branch prices, option prices, sold-out and unpriced items; menus in use cannot be archived', async () => {
    const r = await restaurant('rst-serve');
    const m = await menuWithModifiers(r);
    const unpriced = await r.product('Special', undefined);
    const content = { sections: [...m.content.sections, { name: 'Specials', items: [{ variantId: unpriced }] }] };
    await http().put(`/v1/menu-versions/${m.menu.draft.id}/content`).set(r.auth).send(content).expect(200);

    expect((await http().get(`/v1/branches/${r.branchId}/menu`).set(r.cashier).expect(200)).body.menu).toBeNull(); // nothing assigned yet
    const settings = { dineInMenuId: m.menu.id, takeawayMenuId: null, serviceChargeRate: '0.10', serviceChargeDineIn: true, serviceChargeTakeaway: false, serviceChargeVatTreatment: 'VATABLE' };
    expect((await http().put(`/v1/branches/${r.branchId}/restaurant-settings`).set(r.auth).send(settings).expect(200)).body).toMatchObject({ ...settings, serviceChargeRate: '0.1' });
    await http().put(`/v1/branches/${r.branchId}/restaurant-settings`).set(r.auth).send({ ...settings, serviceChargeRate: '0.5' }).expect(400);
    await http().put(`/v1/branches/${r.branchId}/restaurant-settings`).set(r.auth).send({ ...settings, dineInMenuId: randomUUID() }).expect(404);
    expect((await http().get(`/v1/branches/${r.branch2Id}/restaurant-settings`).set(r.auth).expect(200)).body).toMatchObject({ dineInMenuId: null, serviceChargeRate: '0' });
    expect((await http().get(`/v1/branches/${r.branchId}/menu`).set(r.cashier).expect(200)).body.menu).toBeNull(); // assigned but not published

    await http().post(`/v1/menu-versions/${m.menu.draft.id}/publish`).set(r.auth).expect(200);
    // 86 during service: the kitchen or a manager (branch managers hold kitchen.operate), not the cashier.
    await http().put(`/v1/branches/${r.branchId}/sold-out`).set(r.cashier).send({ variantId: m.tea, soldOut: true }).expect(403);
    await http().put(`/v1/branches/${r.branchId}/sold-out`).set(r.manager).send({ variantId: m.tea, soldOut: true, note: 'No ice' }).expect(200);

    const served = (await http().get(`/v1/branches/${r.branchId}/menu`).set(r.cashier).expect(200)).body.menu;
    const items = served.sections.flatMap((s: { items: unknown[] }) => s.items) as { variantId: string; name: string; price: string | null; soldOut: boolean; available: boolean; stationCode: string; modifierGroups: { name: string; required: boolean; options: { name: string; price: string | null; available: boolean }[] }[] }[];
    const burger = items.find((i) => i.variantId === m.burger)!;
    expect(burger).toMatchObject({ name: 'Burger', price: '150.0000', soldOut: false, available: true, stationCode: 'GRILL' });
    expect(burger.modifierGroups.map((g) => [g.name, g.required, g.options.map((o) => [o.name, o.price, o.available])])).toEqual([
      ['Doneness', true, [['Medium', '0', true], ['Well done', '0', true]]],
      ['Extras', false, [['Cheese', '20.0000', true], ['No onions', '0', true]]],
    ]);
    expect(items.find((i) => i.variantId === m.tea)).toMatchObject({ name: 'House iced tea', soldOut: true, available: false });
    expect(items.find((i) => i.variantId === unpriced)).toMatchObject({ price: null, available: false });
    expect((await http().get(`/v1/branches/${r.branchId}/sold-out`).set(r.cashier).expect(200)).body.data).toMatchObject([{ variantId: m.tea, note: 'No ice' }]);
    await http().put(`/v1/branches/${r.branchId}/sold-out`).set(r.auth).send({ variantId: m.tea, soldOut: false }).expect(200);
    expect((await http().get(`/v1/branches/${r.branchId}/sold-out`).set(r.cashier).expect(200)).body.data).toEqual([]);

    expect((await http().get(`/v1/branches/${r.branchId}/menu`).query({ orderType: 'TAKEAWAY' }).set(r.cashier).expect(200)).body.menu).toBeNull();
    await http().get(`/v1/branches/${r.branchId}/menu`).set(r.otherCashier).expect(403);
    await http().get(`/v1/branches/${r.branchId}/menu`).set(r.inventory).expect(403);
    // Kitchen crew read the menu to mark its items sold out from the KDS (and may set it), at their branch only.
    const crew = bearer(await loginToken(app, (await addMember(owner, r.tenantId, 'kitchen_crew', { type: 'BRANCH', id: r.branchId })).email));
    const crewMenu = (await http().get(`/v1/branches/${r.branchId}/menu`).set(crew).expect(200)).body.menu;
    expect(crewMenu.sections.flatMap((s: { items: { variantId: string }[] }) => s.items.map((i) => i.variantId))).toContain(m.tea);
    await http().put(`/v1/branches/${r.branchId}/sold-out`).set(crew).send({ variantId: m.tea, soldOut: true }).expect(200);
    await http().put(`/v1/branches/${r.branchId}/sold-out`).set(crew).send({ variantId: m.tea, soldOut: false }).expect(200);
    await http().get(`/v1/branches/${r.branch2Id}/menu`).set(crew).expect(403);
    expect(code(await http().post(`/v1/menus/${m.menu.id}/archive`).set(r.auth).expect(409))).toBe('MENU_IN_USE');
  });
});
