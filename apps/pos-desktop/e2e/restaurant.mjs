// Shared arrangement for the restaurant E2E scripts: a VAT restaurant set up through the API.
// Burger ₱150 (doneness required; cheese slice ₱20 extra) → GRILL (default), Iced tea ₱45 → BAR,
// tables T1/T2 in the Hall, service charge 10 % on dine-in. The owner holds every permission.
import { randomUUID } from 'node:crypto';

export const PASSWORD = 'correct horse battery staple';

export function client(api) {
  return async function call(method, path, token, body, headers = {}) {
    const res = await fetch(api + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}

export async function arrangeRestaurant(api, prefix) {
  const call = client(api);
  const slug = `${prefix}-${Date.now().toString(36)}`;
  const email = `${slug}@example.ph`;
  const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Lito Santos', businessName: 'Kainan ni Lito', tenantSlug: slug });
  const tk = owner.tokens.accessToken;
  const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Lito Santos Foods', tradeName: 'Kainan ni Lito', tin: '234-567-891', vatStatus: 'VAT' });
  const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'MKT-01', name: 'Makati' });
  await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
  const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
  const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
  const product = async (name, sku, price, trackInventory) =>
    (await call('POST', '/v1/products', tk, { name, taxCategoryId: vat, uomId: pc, trackInventory, variants: [{ sku, price }] }, { 'idempotency-key': randomUUID() })).variants[0].id;
  const burger = await product('Burger', 'BRG-1', '150.00', false);
  const tea = await product('Iced tea', 'TEA-1', '45.00', false);
  const cheese = await product('Cheese slice', 'CHZ-1', '20.00', true);
  await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening', items: [{ variantId: cheese, quantity: '20', unitCost: '3.00' }] });
  await call('POST', '/v1/kitchen-stations', tk, { branchId: br.id, code: 'GRILL', name: 'Grill', isDefault: true });
  await call('POST', '/v1/kitchen-stations', tk, { branchId: br.id, code: 'BAR', name: 'Bar' });
  const area = await call('POST', '/v1/dining-areas', tk, { branchId: br.id, name: 'Hall' });
  const tables = {};
  for (const code of ['T1', 'T2']) tables[code] = (await call('POST', '/v1/restaurant-tables', tk, { areaId: area.id, code, seats: 4 })).id;
  const doneness = await call('POST', '/v1/modifier-groups', tk, { name: 'Doneness', minSelect: 1, maxSelect: 1, options: [{ name: 'Medium' }, { name: 'Well done' }] });
  const extras = await call('POST', '/v1/modifier-groups', tk, { name: 'Extras', maxSelect: 2, options: [{ name: 'Cheese', variantId: cheese }, { name: 'No onions' }] });
  const menu = await call('POST', '/v1/menus', tk, { name: 'All day' });
  await call('PUT', `/v1/menu-versions/${menu.draft.id}/content`, tk, { sections: [
    { name: 'Mains', items: [{ variantId: burger, stationCode: 'GRILL', modifierGroupIds: [doneness.id, extras.id] }] },
    { name: 'Drinks', items: [{ variantId: tea, stationCode: 'BAR' }] },
  ] });
  await call('POST', `/v1/menu-versions/${menu.draft.id}/publish`, tk);
  await call('PUT', `/v1/branches/${br.id}/restaurant-settings`, tk, { dineInMenuId: menu.id, takeawayMenuId: menu.id, serviceChargeRate: '0.10', serviceChargeDineIn: true, serviceChargeTakeaway: false, serviceChargeVatTreatment: 'VATABLE' });
  const option = (g, name) => g.options.find((o) => o.name === name).id;
  return { call, email, tk, branchId: br.id, tables, burger, tea, cheese, medium: option(doneness, 'Medium'), cheeseOption: option(extras, 'Cheese') };
}
