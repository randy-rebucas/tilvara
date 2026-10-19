import type { OfflineSale, Snapshot, SyncResult } from '@1pos/sync-protocol';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStore, OfflineEngine, OfflineSaleError, TransportError, type Transport } from '../src/index.js';
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
      totals: { vatableSales: '40.00', vatAmount: '4.80', vatExemptSales: '27.50', amountDue: '72.30' }, change: '27.70',
    });
    expect(receipt.notice).toMatch(/NOT AN OFFICIAL INVOICE/);
    expect((await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '22.40' })).sale.deviceSeq).toBe(2);
    expect(await engine.status()).toMatchObject({ pending: 2, recorded: 0, authState: 'OK', snapshot: { expired: false } });
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
