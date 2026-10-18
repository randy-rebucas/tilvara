/**
 * Pilot-scale dataset for the load harness (ADR-0016 slice 5), created through the real API so every
 * row passes the same rules, triggers and audit as production data.
 *
 *   pnpm build && pnpm load:seed [--tenants 20] [--branches 3] [--registers 3] [--items 5000] [--hot 300] [--concurrency 12]
 *
 * Each business: a VAT legal entity, branches × registers, `items` products (one variant each, with a
 * barcode and a price), and the first `hot` items stocked at every branch (the harness sells those).
 * Writes .load/onepos_load.seed.json. Re-running adds new businesses; drop the database to start over
 * (`DROP DATABASE onepos_load WITH (FORCE)`).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ensureLoadDatabase, retryingClient, PASSWORD, pool, SEED_FILE, startApi, type SeedFile } from './common.js';

const { values } = parseArgs({
  options: {
    tenants: { type: 'string', default: '20' },
    branches: { type: 'string', default: '3' },
    registers: { type: 'string', default: '3' },
    items: { type: 'string', default: '5000' },
    hot: { type: 'string', default: '300' },
    concurrency: { type: 'string', default: '12' },
  },
});
const scale = {
  tenants: Number(values.tenants),
  branches: Number(values.branches),
  registers: Number(values.registers),
  items: Number(values.items),
  hot: Math.min(Number(values.hot), Number(values.items)),
};
const concurrency = Number(values.concurrency);
const run = Date.now().toString(36);

const t0 = performance.now();
const log = (m: string) => console.log(`[seed ${((performance.now() - t0) / 1000).toFixed(0).padStart(5)} s] ${m}`);

await ensureLoadDatabase();
log('database onepos_load migrated');
const api = await startApi();
const retries: Record<string, number> = {};
const call = retryingClient(api.base, (s) => (retries[String(s)] = (retries[String(s)] ?? 0) + 1));
const key = () => ({ 'idempotency-key': randomUUID() });
const out: SeedFile = { createdAt: new Date().toISOString(), scale, tenants: [] };
let products = 0;

try {
  for (let ti = 0; ti < scale.tenants; ti++) {
    const slug = `load-${run}-${ti}`;
    const email = `${slug}@example.ph`;
    const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: `Load Owner ${ti}`, businessName: `Load Store ${ti}`, tenantSlug: slug });
    const tk: string = owner.tokens.accessToken;
    const le = await call('POST', '/v1/legal-entities', tk, { registeredName: `Load Store ${ti} Trading`, vatStatus: 'VAT' });
    const branches = [];
    for (let b = 0; b < scale.branches; b++) {
      const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: `B${b + 1}`, name: `Branch ${b + 1}`, birBranchCode: String(b).padStart(5, '0') });
      const registers = [];
      for (let r = 0; r < scale.registers; r++) registers.push((await call('POST', '/v1/registers', tk, { branchId: br.id, code: `R${r + 1}`, name: `Counter ${r + 1}` })).id as string);
      branches.push({ id: br.id as string, registers });
    }
    const taxes = Object.fromEntries((await call('GET', '/v1/tax-categories', tk)).data.map((x: { code: string; id: string }) => [x.code, x.id]));
    const pc = (await call('GET', '/v1/uoms', tk)).data.find((u: { code: string }) => u.code === 'PC').id;
    // Prices from ₱5.00 to ₱504.75; one in ten items VAT-exempt.
    const made = await pool(Array.from({ length: scale.items }, (_, n) => n), concurrency, async (n) => {
      const barcode = `480${String(ti).padStart(3, '0')}${String(n).padStart(7, '0')}`;
      const price = `${5 + (n % 500)}.${String((n * 25) % 100).padStart(2, '0')}`;
      const p = await call('POST', '/v1/products', tk, {
        name: `Load item ${n} of store ${ti}`,
        taxCategoryId: n % 10 === 9 ? taxes.VAT_EXEMPT : taxes.VAT,
        uomId: pc,
        variants: [{ sku: `L${ti}-${n}`, barcodes: [barcode], price, referenceCost: '3.00' }],
      }, key());
      products++;
      if (products % 2000 === 0) log(`${products} products`);
      return { variantId: p.variants[0].id as string, barcode };
    });
    const hot = made.slice(0, scale.hot);
    for (const br of branches) {
      for (let i = 0; i < hot.length; i += 500) {
        await call('POST', '/v1/stock/adjustments', tk, {
          branchId: br.id,
          reason: 'Load test opening stock',
          items: hot.slice(i, i + 500).map((h) => ({ variantId: h.variantId, quantity: '100000', unitCost: '3.00' })),
        }, key());
      }
    }
    out.tenants.push({ email, tenantId: owner.activeTenantId, branches, hot });
    log(`business ${ti + 1}/${scale.tenants} (${slug}): ${scale.branches} branches, ${scale.branches * scale.registers} registers, ${scale.items} items`);
  }
  await mkdir(dirname(SEED_FILE), { recursive: true });
  await writeFile(SEED_FILE, JSON.stringify(out, null, 2));
  const secs = (performance.now() - t0) / 1000;
  log(`done: ${products} products in ${secs.toFixed(0)} s (${(products / secs).toFixed(0)}/s), retries ${JSON.stringify(retries)} → ${SEED_FILE}`);
} finally {
  await api.stop();
}
