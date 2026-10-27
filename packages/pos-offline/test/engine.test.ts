import { ean13CheckDigit, offlineSaleSchema, type OfflineSale, type Snapshot, type SyncResult } from '@1pos/sync-protocol';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStore, OfflineEngine, OfflineSaleError, TillPairingError, TransportError, type SqlDriver, type Transport } from '../src/index.js';
import { nodeSqliteDriver } from '../src/node-sqlite.js';

const CASHIER = '0199f0a0-0000-7000-8000-00000000c0de';
const COLA = '0199f0a0-0000-7000-8000-00000000c01a';
const RICE = '0199f0a0-0000-7000-8000-0000000041ce';
const snapshot: Snapshot = {
  snapshotId: '0199f0a0-0000-7000-8000-000000005a00', asOf: '2026-10-17T00:00:00.000Z', validUntil: '2026-10-18T00:00:00.000Z',
  terminal: { id: '0199f0a0-0000-7000-8000-00000000te01', name: 'Till 1', credentialHint: 'AbCd' },
  register: { id: 'r1', code: 'R1', name: 'Front' }, branch: { id: 'b1', code: 'B1', name: 'Cubao', timezone: 'Asia/Manila' },
  legalEntity: { id: 'le', registeredName: 'Nena Trading', tradeName: 'Tindahan ni Nena', tin: '123456789', receiptTin: '123-456-789-00000' }, currency: 'PHP',
  taxProfile: { id: 'tp', effectiveFrom: '2026-01-01T00:00:00.000Z', vatStatus: 'VAT', vatRate: '0.12', roundingMode: 'HALF_UP' },
  openSession: { id: '0199f0a0-0000-7000-8000-0000005e5510', openedBy: CASHIER, cashierName: 'Maria', openedAt: '2026-10-17T00:00:00.000Z' },
  items: [
    { variantId: COLA, sku: 'COLA', name: 'Cola', barcodes: [], priceId: 'p1', priceListId: 'l1', unitPrice: '22.4000', priceIncludesTax: true, vatTreatment: 'VATABLE', taxCategoryCode: 'VAT', wholeUnits: true, trackInventory: true },
    { variantId: RICE, sku: 'RICE', name: 'Rice (kg)', barcodes: [], priceId: 'p2', priceListId: 'l1', unitPrice: '55.0000', priceIncludesTax: true, vatTreatment: 'VAT_EXEMPT', taxCategoryCode: 'EX', wholeUnits: false, trackInventory: true },
  ],
};

/** A server stand-in: records what it was sent and answers per the script. */
function fakeServer() {
  const sent: OfflineSale[][] = [];
  let mode: 'ok' | 'down' | 'revoked' | 'partial' | 'quarantine' = 'ok';
  let n = 0;
  const transport: Transport = {
    snapshot: async () => {
      if (mode === 'revoked') throw new TransportError('HTTP', 'revoked', 401, 'TERMINAL_REVOKED');
      return snapshot;
    },
    syncSales: async (sales) => {
      sent.push(sales);
      if (mode === 'down') throw new TransportError('NETWORK', 'connection refused');
      if (mode === 'revoked') throw new TransportError('HTTP', 'revoked', 401, 'TERMINAL_REVOKED');
      const answer = mode === 'partial' ? sales.slice(0, 1) : sales;
      return {
        results: answer.map((s): SyncResult => mode === 'quarantine'
          ? { terminalTxnId: s.terminalTxnId, deviceSeq: s.deviceSeq, status: 'QUARANTINED', code: 'TOTAL_MISMATCH', message: 'x', replayed: false }
          : { terminalTxnId: s.terminalTxnId, deviceSeq: s.deviceSeq, status: 'RECORDED', saleId: `sale-${++n}`, saleNumber: n, reference: `R1-${String(n).padStart(6, '0')}`, flags: [], replayed: false }),
      };
    },
  };
  return { transport, sent, set: (m: typeof mode) => (mode = m) };
}

const drivers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const d of drivers.splice(0)) await d.close();
});

async function till(path: string, server: ReturnType<typeof fakeServer>, clock: { t: number }) {
  const driver = nodeSqliteDriver(path);
  drivers.push(driver);
  const engine = new OfflineEngine({ store: new LocalStore(driver), transport: server.transport, now: () => clock.t, random: () => 1, baseBackoffMs: 1_000, maxBackoffMs: 8_000 });
  await engine.open();
  return { engine, driver };
}
const dbFile = () => join(mkdtempSync(join(tmpdir(), '1pos-offline-')), 'till.db');

describe('ringing up offline', () => {
  it('prices with the tax engine, stores the sale with its envelope before anything is sent, and numbers it', async () => {
    const server = fakeServer();
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const { engine } = await till(dbFile(), server, clock);
    await expect(engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' })).rejects.toMatchObject({ code: 'NO_SNAPSHOT' });
    await engine.refreshSnapshot();

    const { sale, receipt } = await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '2' }, { variantId: RICE, quantity: '0.5' }], tendered: '100' });
    expect(server.sent).toEqual([]); // nothing on the network yet
    expect(sale).toMatchObject({ deviceSeq: 1, status: 'PENDING', attempts: 0 });
    expect(sale.envelope).toMatchObject({
      deviceSeq: 1, snapshotId: snapshot.snapshotId, cashierSessionId: snapshot.openSession!.id, cashierUserId: CASHIER, occurredAt: '2026-10-17T02:00:00.000Z',
      localReference: 'R1-TAbCd-000001', tenders: [{ method: 'CASH', tendered: '100.00' }], amountDue: '72.30',
    });
    // Cola 2 × 22.40 = 44.80 V (40.00 + 4.80 VAT); rice ½ kg × 55 = 27.50 E.
    expect(receipt).toMatchObject({
      seller: { name: 'Tindahan ni Nena', tin: '123-456-789-00000', vatStatus: 'VAT' }, // the TIN as online receipts print it
      lines: [{ name: 'Cola', amount: '44.80', flag: 'V' }, { name: 'Rice (kg)', quantity: '0.5', amount: '27.50', flag: 'E' }],
      totals: { discount: '0.00', vatableSales: '40.00', vatLabel: 'VAT 12%', vatAmount: '4.80', vatExemptSales: '27.50', amountDue: '72.30' }, change: '27.70',
    });
    expect(receipt.notice).toMatch(/NOT AN OFFICIAL INVOICE/);
    expect((await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '22.40' })).sale.deviceSeq).toBe(2);
    expect(await engine.status()).toMatchObject({ pending: 2, recorded: 0, authState: 'OK', snapshot: { expired: false } });
    // Close shift waits for these: both are on the open shift, none on another.
    expect(await engine.pendingFor(snapshot.openSession!.id)).toBe(2);
    expect(await engine.pendingFor('00000000-0000-4000-8000-000000000000')).toBe(0);
  });

  it('prints what a promotion took off as a Discount total, as online receipts do', async () => {
    const server = fakeServer();
    server.transport.snapshot = async () => ({
      ...snapshot,
      promotions: [{ id: 'promo-1', name: '2 for 40', kind: 'MULTI_BUY', startsAt: '2026-01-01T00:00:00.000Z', variantIds: [COLA], quantity: 2, price: '40.00' }],
    });
    const { engine } = await till(dbFile(), server, { t: Date.parse('2026-10-17T02:00:00Z') });
    await engine.refreshSnapshot();
    const { receipt } = await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '2' }], tendered: '40' });
    expect(receipt.totals).toMatchObject({ gross: '44.80', discount: '4.80', amountDue: '40.00', vatLabel: 'VAT 12%' });
    expect(receipt.lines[0]).toMatchObject({ amount: '40.00', promotion: { name: '2 for 40', discount: '4.80' } });
  });

  it('refuses at the till what it cannot record: another cashier, unknown items, fractions of whole items, too little cash', async () => {
    const server = fakeServer();
    const { engine } = await till(dbFile(), server, { t: Date.parse('2026-10-17T02:00:00Z') });
    await engine.refreshSnapshot();
    const ring = (o: Partial<{ cashierUserId: string; lines: { variantId: string; quantity: string }[]; tendered: string }>) =>
      engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50', ...o }).catch((e: OfflineSaleError) => e.code);
    expect(await ring({ cashierUserId: '0199f0a0-0000-7000-8000-0000000000ff' })).toBe('NOT_SHIFT_OWNER');
    expect(await ring({ lines: [{ variantId: '0199f0a0-0000-7000-8000-0000000000ff', quantity: '1' }] })).toBe('UNKNOWN_ITEM');
    expect(await ring({ lines: [{ variantId: COLA, quantity: '1.5' }] })).toBe('QUANTITY_NOT_ALLOWED');
    expect(await ring({ tendered: '22.39' })).toBe('INSUFFICIENT_TENDER');
    expect((await engine.status()).pending).toBe(0); // nothing stored, no number used
    expect((await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '22.40' })).sale.deviceSeq).toBe(1);
  });

  it('refuses a sale the server could not read before queueing it (it would only be quarantined later), storing nothing', async () => {
    const server = fakeServer();
    const { engine } = await till(dbFile(), server, { t: Date.parse('2026-10-17T02:00:00Z') });
    await engine.refreshSnapshot();
    const bad = await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50', terminalTxnId: 'not-a-uuid' }).catch((e: OfflineSaleError) => e);
    expect(bad).toMatchObject({ code: 'INVALID_SALE', message: expect.stringContaining('terminalTxnId') });
    expect((await engine.status()).pending).toBe(0);
    const ok = await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' });
    expect(ok.sale.deviceSeq).toBe(1); // no number used by the refused one
    expect(offlineSaleSchema.safeParse(ok.sale.envelope).success).toBe(true);
  });

  it('keeps the counter’s checkout id: submitting the same checkout again returns the queued sale, not a second one', async () => {
    const server = fakeServer();
    const { engine } = await till(dbFile(), server, { t: Date.parse('2026-10-17T02:00:00Z') });
    await engine.refreshSnapshot();
    const checkout = '0199f0a0-0000-7000-8000-0000000c4ec0';
    const once = await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50', terminalTxnId: checkout });
    const twice = await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50', terminalTxnId: checkout });
    expect(once.sale.envelope.terminalTxnId).toBe(checkout);
    expect(twice.sale.deviceSeq).toBe(once.sale.deviceSeq);
    expect((await engine.status()).pending).toBe(1);
  });

  it('looks items up in the snapshot by barcode or SKU', async () => {
    const server = fakeServer();
    const { engine } = await till(dbFile(), server, { t: Date.parse('2026-10-17T02:00:00Z') });
    await expect(engine.lookup('COLA')).rejects.toMatchObject({ code: 'NO_SNAPSHOT' });
    await engine.refreshSnapshot();
    expect((await engine.lookup('cola'))?.variantId).toBe(COLA);
    expect((await engine.lookup(' RICE '))?.variantId).toBe(RICE);
    expect(await engine.lookup('4800000000000')).toBeNull();
  });
});

describe('sync', () => {
  it('survives a restart: pending sales and the next number come back from the file', async () => {
    const server = fakeServer();
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const path = dbFile();
    const first = await till(path, server, clock);
    await first.engine.refreshSnapshot();
    const a = (await first.engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' })).sale;
    await first.driver.close(); // the till is switched off before it could sync

    const second = await till(path, server, clock);
    expect(await second.engine.status()).toMatchObject({ pending: 1 });
    expect((await second.engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' })).sale.deviceSeq).toBe(2);
    const report = await second.engine.syncOnce();
    expect(report.results.map((r) => [r.deviceSeq, r.status])).toEqual([[1, 'RECORDED'], [2, 'RECORDED']]);
    expect(server.sent[0]![0]!.terminalTxnId).toBe(a.terminalTxnId);
    expect(await second.engine.status()).toMatchObject({ pending: 0, recorded: 2, lastSyncAt: clock.t, lastError: null });
  });

  it('no answer: the same envelopes are retried after a growing, jittered wait, never re-numbered', async () => {
    const server = fakeServer();
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const { engine } = await till(dbFile(), server, clock);
    await engine.refreshSnapshot();
    const { sale } = await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' });
    server.set('down');
    expect((await engine.syncOnce()).error).toMatchObject({ code: 'NETWORK', retryable: true });
    expect(await engine.syncOnce()).toEqual({ sent: 0, results: [] }); // not due yet (1 s)
    clock.t += 1_000;
    await engine.syncOnce(); // second failure: waits 2 s
    clock.t += 1_999;
    expect((await engine.syncOnce()).sent).toBe(0);
    clock.t += 1;
    server.set('ok');
    const done = await engine.syncOnce();
    expect(done.results).toMatchObject([{ status: 'RECORDED', terminalTxnId: sale.terminalTxnId }]);
    expect(server.sent.map((b) => b.map((s) => s.terminalTxnId))).toEqual([[sale.terminalTxnId], [sale.terminalTxnId], [sale.terminalTxnId]]);
    expect((await engine.status()).lastError).toBeNull();
  });

  it('a server out of time (answers the oldest part of each batch) is drained at once, without backing off', async () => {
    const server = fakeServer();
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') }; // the clock never moves: nothing may wait on a backoff
    const { engine } = await till(dbFile(), server, clock);
    await engine.refreshSnapshot();
    for (let i = 0; i < 4; i++) await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' });
    server.set('partial');
    const reports = await engine.drain();
    expect(reports.map((r) => [r.sent, r.results.length])).toEqual([[4, 1], [3, 1], [2, 1], [1, 1], [0, 0]]);
    expect(await engine.status()).toMatchObject({ pending: 0, recorded: 4, lastError: null });
  });

  it('a partial answer settles what was answered and retries the rest; quarantined sales are kept for review', async () => {
    const server = fakeServer();
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const { engine } = await till(dbFile(), server, clock);
    await engine.refreshSnapshot();
    for (let i = 0; i < 3; i++) await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' });
    server.set('partial');
    expect((await engine.syncOnce()).results).toHaveLength(1);
    expect(await engine.status()).toMatchObject({ pending: 2, recorded: 1 });
    clock.t += 1_000;
    server.set('quarantine');
    await engine.syncOnce();
    expect(await engine.status()).toMatchObject({ pending: 0, recorded: 1, needsReview: 2 });
  });

  it('a revoked terminal stops syncing and selling, and keeps what it has', async () => {
    const server = fakeServer();
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const { engine } = await till(dbFile(), server, clock);
    await engine.refreshSnapshot();
    await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' });
    server.set('revoked');
    expect((await engine.syncOnce()).error).toMatchObject({ code: 'TERMINAL_REVOKED', retryable: false });
    expect(await engine.status()).toMatchObject({ authState: 'REVOKED', pending: 1 });
    await expect(engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' })).rejects.toMatchObject({ code: 'TERMINAL_REVOKED' });
    expect((await engine.syncOnce()).sent).toBe(0);
  });

  it('serializes concurrent work on one connection: ten sales rung at once get ten distinct numbers', async () => {
    const server = fakeServer();
    const { engine } = await till(dbFile(), server, { t: Date.parse('2026-10-17T02:00:00Z') });
    await engine.refreshSnapshot();
    const all = await Promise.all(Array.from({ length: 10 }, () => engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' })));
    expect(all.map((x) => x.sale.deviceSeq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const sync = await Promise.all([engine.syncOnce(), engine.syncOnce()]);
    expect(sync.map((r) => r.sent)).toEqual([10, 0]);
  });
});

describe('knowing when the snapshot is out of date (session 16)', () => {
  it('asks the server: a moved catalog version or a scheduled change that took effect means refresh; an older server never says so', async () => {
    const server = fakeServer();
    let answer = { version: 7, nextChangeAt: '2026-10-17T10:00:00.000Z' as string | null };
    server.transport.snapshot = async () => ({ ...snapshot, catalogVersion: 7, nextChangeAt: '2026-10-17T10:00:00.000Z' });
    server.transport.catalogVersion = async () => answer;
    const { engine } = await till(dbFile(), server, { t: Date.parse('2026-10-17T02:00:00Z') });
    expect(await engine.snapshotOutdated()).toBe(true); // none stored yet
    await engine.refreshSnapshot();
    expect(await engine.snapshotOutdated()).toBe(false);
    answer = { version: 8, nextChangeAt: '2026-10-17T10:00:00.000Z' }; // an edit in the back office
    expect(await engine.snapshotOutdated()).toBe(true);
    answer = { version: 7, nextChangeAt: null }; // the scheduled price took effect, nothing else planned
    expect(await engine.snapshotOutdated()).toBe(true);
    answer = { version: 7, nextChangeAt: '2026-10-17T10:00:00.000Z' };
    expect(await engine.snapshotOutdated()).toBe(false);
    delete server.transport.catalogVersion; // an older server: the 10-minute refresh is all there is
    expect(await engine.snapshotOutdated()).toBe(false);
  });
});

describe('a till whose file was lost or restored from an old copy (session 16)', () => {
  it('numbers its next sale after the last one the server has, so local references never repeat', async () => {
    const server = fakeServer();
    server.transport.snapshot = async () => ({ ...snapshot, lastDeviceSeq: 41 });
    const { engine } = await till(dbFile(), server, { t: Date.parse('2026-10-17T02:00:00Z') }); // a fresh file
    await engine.refreshSnapshot();
    const { sale } = await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' });
    expect([sale.deviceSeq, sale.envelope.localReference]).toEqual([42, 'R1-TAbCd-000042']);
    // A counter already ahead is never moved back.
    server.transport.snapshot = async () => ({ ...snapshot, lastDeviceSeq: 10 });
    await engine.refreshSnapshot();
    expect((await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' })).sale.deviceSeq).toBe(43);
  });
});

describe('scale labels offline (session 16)', () => {
  it('reads a weighed label from the snapshot like the server: an item sold by weight, by its scale code', async () => {
    const server = fakeServer();
    const RICE_KEY = '212345';
    server.transport.snapshot = async () => ({ ...snapshot, items: snapshot.items.map((i) => (i.variantId === RICE ? { ...i, barcodes: [RICE_KEY] } : { ...i, barcodes: ['254321'] })) });
    const { engine } = await till(dbFile(), server, { t: Date.parse('2026-10-17T02:00:00Z') });
    await engine.refreshSnapshot();
    const first12 = '212345012340';
    const code = `${first12}${ean13CheckDigit(first12)}`;
    expect(await engine.lookup(code)).toMatchObject({ variantId: RICE, quantity: '1.234' });
    // A unit item's code is not read as a weight; a wrong check digit is not a label.
    const unit = '254321010000';
    expect(await engine.lookup(`${unit}${ean13CheckDigit(unit)}`)).toBeNull();
    expect(await engine.lookup(`${first12}${(ean13CheckDigit(first12) + 1) % 10}`)).toBeNull();
  });
});

describe('branding (session 39)', () => {
  const branding = {
    displayName: 'Nena', brandColor: '#7a1f3d', logoSha256: 'a'.repeat(64), backgroundSha256: null,
    displayWelcome: 'Welcome!', displayThanks: 'Salamat!',
    receipt: { header: ['Open daily'], footer: ['Salamat po!'], contact: ['0917 000 0000'] },
  };

  it('offline receipts carry the messages; the logo is fetched once, kept, and shown offline', async () => {
    const server = fakeServer();
    let fetched = 0;
    server.transport.snapshot = async () => ({ ...snapshot, branding });
    server.transport.brandImage = async (kind) => {
      fetched++;
      if (kind !== 'logo') throw new TransportError('HTTP', 'none', 404);
      return { contentType: 'image/png', data: 'iVBORw0K' };
    };
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const { engine } = await till(dbFile(), server, clock);
    expect(await engine.branding()).toBeNull();
    expect(await engine.brandImage('logo')).toBeNull(); // no snapshot yet
    await engine.refreshSnapshot();
    expect(await engine.branding()).toEqual(branding);
    expect(await engine.brandImage('logo')).toEqual({ contentType: 'image/png', data: 'iVBORw0K' });
    // Kept: offline (the server gone) the till still has it, without asking again.
    server.transport.brandImage = async () => { throw new TransportError('NETWORK', 'down'); };
    expect(await engine.brandImage('logo')).toEqual({ contentType: 'image/png', data: 'iVBORw0K' });
    expect(fetched).toBe(1);
    expect(await engine.brandImage('background')).toBeNull();
    const { receipt } = await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' });
    expect(receipt.branding).toEqual(branding.receipt);
  });

  it('a till file from before branding is upgraded and keeps its queue', async () => {
    const path = dbFile();
    const driver = nodeSqliteDriver(path);
    drivers.push(driver);
    // Version 1 as it shipped: no brand_images table.
    await driver.execute(`CREATE TABLE schema_version (version INTEGER NOT NULL)`);
    await driver.execute(`INSERT INTO schema_version (version) VALUES (1)`);
    await driver.execute(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await driver.execute(`CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, fetched_at INTEGER NOT NULL)`);
    await createV1Outbox(driver);
    await driver.execute(`INSERT INTO meta (key, value) VALUES ('terminal_id', 't1')`);
    const store = new LocalStore(driver);
    await store.migrate();
    expect(await store.meta('terminal_id')).toBe('t1');
    await store.saveBrandImage('b'.repeat(64), 'image/png', 'AAAA', []);
    expect(await store.brandImage('b'.repeat(64))).toEqual({ contentType: 'image/png', data: 'AAAA' });
    // A replaced image goes once the snapshot no longer names it.
    await store.saveBrandImage('c'.repeat(64), 'image/png', 'BBBB', ['c'.repeat(64)]);
    expect(await store.brandImage('b'.repeat(64))).toBeNull();
  });
});

/** The outbox as schema version 1 shipped it (no terminal column). */
async function createV1Outbox(driver: SqlDriver) {
  await driver.execute(`CREATE TABLE outbox (
    device_seq INTEGER PRIMARY KEY CHECK (device_seq > 0), terminal_txn_id TEXT NOT NULL UNIQUE, envelope TEXT NOT NULL, receipt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING','RECORDED','QUARANTINED','DISMISSED','REJECTED')), attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, last_error TEXT, result TEXT, created_at INTEGER NOT NULL, synced_at INTEGER)`);
}

describe('setting the till up for another terminal (whose data the file holds)', () => {
  const A = { terminalId: snapshot.terminal.id, origin: 'https://a.example', registerId: snapshot.register.id };
  const otherBusiness: Snapshot = {
    ...snapshot, snapshotId: '0199f0a0-0000-7000-8000-000000005b00',
    terminal: { id: '0199f0a0-0000-7000-8000-00000000te0b', name: 'Till B', credentialHint: 'WxYz' },
    register: { id: 'rB', code: 'B1', name: 'Other shop' }, openSession: { ...snapshot.openSession!, id: '0199f0a0-0000-7000-8000-0000005e55b0' },
  };
  const B = { terminalId: otherBusiness.terminal.id, origin: 'https://a.example', registerId: otherBusiness.register.id };

  /** A till file set up for A (as `setUp` does), with one sale rung offline and still waiting. */
  async function tillOfA(clock: { t: number }) {
    const server = fakeServer();
    const driver = nodeSqliteDriver(dbFile());
    drivers.push(driver);
    const store = new LocalStore(driver);
    await store.migrate();
    expect(await store.pair(A)).toBe('NEW');
    const engine = new OfflineEngine({ store, transport: server.transport, terminalId: A.terminalId, now: () => clock.t, random: () => 1 });
    await engine.open();
    await engine.refreshSnapshot();
    await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' });
    return { server, driver, store, engine };
  }

  it('refuses another business, register or server while a sale is waiting, and keeps everything as it was', async () => {
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const { store, engine } = await tillOfA(clock);
    await expect(store.pair(B)).rejects.toMatchObject({ kind: 'UNSENT_SALES', pending: 1, owner: { terminalId: A.terminalId } });
    await expect(store.pair(B)).rejects.toBeInstanceOf(TillPairingError);
    // The same terminal id on another server is another owner too.
    await expect(store.pair({ ...A, origin: 'https://b.example' })).rejects.toMatchObject({ kind: 'UNSENT_SALES' });
    await expect(store.resetForNewOwner()).rejects.toMatchObject({ kind: 'UNSENT_SALES' });
    expect(await store.owner()).toEqual(A);
    expect((await store.snapshot())?.body.snapshotId).toBe(snapshot.snapshotId);
    expect((await store.list('PENDING')).map((q) => q.terminalId)).toEqual([A.terminalId]);
    expect(await engine.status()).toMatchObject({ pending: 1 });
  });

  it('with nothing waiting, wipes the previous business (snapshot, images, sales and receipts, sequence) and keeps the printer', async () => {
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const { store, engine, driver } = await tillOfA(clock);
    expect((await engine.syncOnce()).results).toHaveLength(1);
    await store.saveBrandImage('a'.repeat(64), 'image/png', 'AAAA', []);
    await store.setMeta('printer', '{"kind":"network","host":"10.0.0.5","port":9100}');
    await store.setMeta('api_url', A.origin);
    await engine.close();
    await expect(engine.refreshSnapshot()).rejects.toThrow(/ENGINE_CLOSED/); // the old engine writes nothing back

    expect(await store.pair(B)).toBe('RESET');
    expect(await store.snapshot()).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await store.brandImage('a'.repeat(64))).toBeNull();
    for (const key of ['next_device_seq', 'last_sync_at', 'auth_state', 'terminal_id']) expect(await store.meta(key)).toBeNull();
    expect(await store.meta('printer')).toContain('10.0.0.5');
    expect(await store.owner()).toEqual(B);

    // B's till starts clean: its own price list, numbered from 1.
    const serverB = fakeServer();
    serverB.transport.snapshot = async () => otherBusiness;
    const engineB = new OfflineEngine({ store: new LocalStore(driver), transport: serverB.transport, terminalId: B.terminalId, now: () => clock.t });
    await engineB.open();
    await engineB.refreshSnapshot();
    const { sale } = await engineB.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' });
    expect(sale).toMatchObject({ deviceSeq: 1, terminalId: B.terminalId });
    await engineB.syncOnce();
    expect(serverB.sent.flat().map((s) => s.snapshotId)).toEqual([otherBusiness.snapshotId]);
  });

  it('the same terminal on the same server carries on with its waiting sales', async () => {
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const { store, server, engine } = await tillOfA(clock);
    expect(await store.pair(A)).toBe('CONTINUED');
    expect(await store.snapshot()).not.toBeNull();
    const report = await engine.syncOnce();
    expect(report.results).toMatchObject([{ status: 'RECORDED' }]);
    expect(server.sent).toHaveLength(1);
  });

  it('another terminal of the same register (a revoked one replaced) takes over and delivers the waiting sales', async () => {
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const { store, driver, engine } = await tillOfA(clock);
    await engine.close();
    const replacement = { ...A, terminalId: '0199f0a0-0000-7000-8000-00000000te02' };
    expect(await store.pair(replacement)).toBe('REPLACED');
    expect((await store.list('PENDING')).map((q) => q.terminalId)).toEqual([replacement.terminalId]);
    const server = fakeServer();
    const next = new OfflineEngine({ store: new LocalStore(driver), transport: server.transport, terminalId: replacement.terminalId, now: () => clock.t });
    await next.open();
    expect((await next.syncOnce()).results).toMatchObject([{ status: 'RECORDED' }]);
    expect(server.sent.flat()).toHaveLength(1);
  });

  it('a file from before owners were kept is judged by the terminal it was set up for, or the one whose snapshot it holds', async () => {
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const { store } = await tillOfA(clock);
    for (const key of ['owner_terminal_id', 'owner_origin', 'owner_register_id']) await store.setMeta(key, null);
    await store.setMeta('terminal_id', null); // disconnected with the old build
    expect(await store.owner()).toEqual({ terminalId: A.terminalId, origin: null, registerId: A.registerId });
    await expect(store.pair(B)).rejects.toMatchObject({ kind: 'UNSENT_SALES' });
    expect(await store.pair(A)).toBe('CONTINUED');
  });
});

describe('each sale goes only with the credential of the terminal it was rung on', () => {
  it('sync sends only the current terminal’s sales; another terminal’s stay waiting, never sent', async () => {
    const server = fakeServer();
    const clock = { t: Date.parse('2026-10-17T02:00:00Z') };
    const driver = nodeSqliteDriver(dbFile());
    drivers.push(driver);
    const store = new LocalStore(driver);
    const mine = new OfflineEngine({ store, transport: server.transport, terminalId: snapshot.terminal.id, now: () => clock.t });
    await mine.open();
    await mine.refreshSnapshot();
    await mine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50' });
    await mine.close();
    const other = new OfflineEngine({ store, transport: server.transport, terminalId: '0199f0a0-0000-7000-8000-00000000te09', now: () => clock.t });
    await other.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: RICE, quantity: '1' }], tendered: '55' });

    const report = await other.syncOnce();
    expect(report.sent).toBe(1);
    expect(server.sent.flat().map((s) => s.deviceSeq)).toEqual([2]);
    const left = await store.list('PENDING');
    expect(left.map((q) => [q.deviceSeq, q.terminalId])).toEqual([[1, snapshot.terminal.id]]);
    expect((await other.drain()).at(-1)).toMatchObject({ sent: 0 });
    expect(server.sent.flat()).toHaveLength(1);
  });

  it('upgrading a file tags the sales already queued with the terminal it is set up for', async () => {
    const path = dbFile();
    const driver = nodeSqliteDriver(path);
    drivers.push(driver);
    await driver.execute(`CREATE TABLE schema_version (version INTEGER NOT NULL)`);
    await driver.execute(`INSERT INTO schema_version (version) VALUES (2)`);
    await driver.execute(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await driver.execute(`CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, fetched_at INTEGER NOT NULL)`);
    await driver.execute(`CREATE TABLE brand_images (sha256 TEXT PRIMARY KEY, content_type TEXT NOT NULL, data TEXT NOT NULL)`);
    await createV1Outbox(driver);
    await driver.execute(`INSERT INTO snapshot (id, body, fetched_at) VALUES (1, ?, 0)`, [JSON.stringify(snapshot)]);
    await driver.execute(
      `INSERT INTO outbox (device_seq, terminal_txn_id, envelope, receipt, status, next_attempt_at, created_at) VALUES (1, 'x1', '{}', '{}', 'PENDING', 0, 0)`,
    );
    const store = new LocalStore(driver);
    await store.migrate();
    // Disconnected (no terminal_id): the snapshot's terminal.
    expect((await store.get(1))?.terminalId).toBe(snapshot.terminal.id);
  });
});
