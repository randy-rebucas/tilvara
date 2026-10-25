import { ean13CheckDigit, offlineSaleSchema, type OfflineSale, type Snapshot, type SyncResult } from '@1pos/sync-protocol';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { drugLabel, LocalStore, needsPrescription, OfflineEngine, OfflineSaleError, TransportError, type Transport } from '../src/index.js';
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

describe('a cash tip offline (session 25)', () => {
  it('the cash covers the sale and the tip; the envelope and receipt carry it, outside the total', async () => {
    const server = fakeServer();
    const { engine } = await till(dbFile(), server, { t: Date.parse('2026-10-17T02:00:00Z') });
    await engine.refreshSnapshot();
    await expect(engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '25', tip: '5' })).rejects.toMatchObject({ code: 'INSUFFICIENT_TENDER' });
    const { sale, receipt } = await engine.ringUp({ cashierUserId: CASHIER, lines: [{ variantId: COLA, quantity: '1' }], tendered: '50', tip: '5' });
    expect(sale.envelope).toMatchObject({ amountDue: '22.40', tip: { amount: '5.00' }, tenders: [{ method: 'CASH', tendered: '50.00' }] });
    expect(receipt).toMatchObject({ tip: '5.00', change: '22.60', totals: { amountDue: '22.40' } });
  });
});

describe('medicines offline (ADR-0025)', () => {
  const AMOXIL = '0199f0a0-0000-7000-8000-0000000a0001';
  const AMOX_GEN = '0199f0a0-0000-7000-8000-0000000a0002';
  const PARA = '0199f0a0-0000-7000-8000-0000000a0003';
  const VALIUM = '0199f0a0-0000-7000-8000-0000000a0004';
  const med = (variantId: string, sku: string, name: string, unitPrice: string, drug: NonNullable<Snapshot['items'][number]['drug']>): Snapshot['items'][number] => ({
    variantId, sku, name, barcodes: [], priceId: `p-${sku}`, priceListId: 'l1', unitPrice, priceIncludesTax: true, vatTreatment: 'VAT_EXEMPT', taxCategoryCode: 'EX', wholeUnits: true, trackInventory: true, drug,
  });
  const amox = { drugClass: 'ANTIBIOTIC' as const, genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE', genericKey: 'amoxicillin|500 mg|CAPSULE' };
  const drugstore: Snapshot = {
    ...snapshot,
    items: [
      ...snapshot.items,
      med(AMOXIL, 'AMOXIL', 'Amoxil 500', '18.0000', amox),
      med(AMOX_GEN, 'AMOX-G', 'RiteMed Amoxicillin', '9.0000', amox),
      med(PARA, 'BIO', 'Biogesic', '5.5000', { drugClass: 'OTC', genericName: 'Paracetamol', strength: '500 mg', dosageForm: 'TABLET', genericKey: 'paracetamol|500 mg|TABLET' }),
      med(VALIUM, 'VAL', 'Valium 5', '25.0000', { drugClass: 'DANGEROUS', genericName: 'Diazepam', strength: '5 mg', dosageForm: 'TABLET', genericKey: 'diazepam|5 mg|TABLET' }),
    ],
  };
  const pharmacy = async () => {
    const s = fakeServer();
    s.transport.snapshot = async () => drugstore;
    const { engine } = await till(dbFile(), s, { t: Date.parse('2026-10-17T02:00:00Z') });
    await engine.refreshSnapshot();
    return engine;
  };
  type Rx = NonNullable<Parameters<OfflineEngine['ringUp']>[0]['prescriptions']>[number];
  const rx = (extra: Partial<Rx> = {}): Rx => ({
    ref: 'rx1', patientName: 'Juan Dela Cruz', prescriberName: 'Dr. Ana Santos', prescriberLicenseNo: 'PRC-0123456', issuedOn: '2026-10-16',
    items: [{ ref: 'i1', genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE', quantity: '21', drugClass: 'ANTIBIOTIC' }],
    ...extra,
  });
  const onRx = { prescriptionRef: 'rx1', itemRef: 'i1' };

  it('finds medicines by generic name, and equivalents by the same generic, cheapest first', async () => {
    const engine = await pharmacy();
    expect((await engine.search('amoxicillin')).map((i) => i.sku)).toEqual(['AMOXIL', 'AMOX-G']);
    expect((await engine.search('ritemed')).map((i) => i.sku)).toEqual(['AMOX-G']);
    expect((await engine.search('paracetamol 500')).map((i) => i.sku)).toEqual(['BIO']);
    expect((await engine.search('cola')).map((i) => i.sku)).toEqual(['COLA']);
    expect(await engine.search('  ')).toEqual([]);
    expect((await engine.equivalents(AMOXIL)).map((i) => [i.sku, i.unitPrice])).toEqual([['AMOX-G', '9.0000']]);
    expect(await engine.equivalents(COLA)).toEqual([]);
  });

  it('puts the prescription recorded at the till into the envelope exactly as the schema takes it, and the generic on the receipt', async () => {
    const engine = await pharmacy();
    const { sale, receipt } = await engine.ringUp({
      cashierUserId: CASHIER, tendered: '200', prescriptions: [rx()],
      lines: [{ variantId: AMOXIL, quantity: '7', prescription: onRx }, { variantId: AMOX_GEN, quantity: '7', prescription: onRx }, { variantId: PARA, quantity: '2' }],
    });
    expect(sale.envelope.lines).toEqual([
      { variantId: AMOXIL, quantity: '7', prescription: onRx },
      { variantId: AMOX_GEN, quantity: '7', prescription: onRx },
      { variantId: PARA, quantity: '2' },
    ]);
    expect(sale.envelope.prescriptions).toEqual([rx()]);
    expect(offlineSaleSchema.safeParse(sale.envelope).success).toBe(true);
    expect(receipt.lines.map((l) => l.generic)).toEqual(['Amoxicillin 500 mg capsule', 'Amoxicillin 500 mg capsule', 'Paracetamol 500 mg tablet']);
    // An OTC sale carries no prescriptions at all.
    const otc = await engine.ringUp({ cashierUserId: CASHIER, tendered: '20', lines: [{ variantId: PARA, quantity: '2' }] });
    expect(otc.sale.envelope).not.toHaveProperty('prescriptions');
    expect(otc.sale.envelope.lines[0]).not.toHaveProperty('prescription');
  });

  it('refuses a dangerous drug offline, and a prescription the server would refuse, storing nothing', async () => {
    const engine = await pharmacy();
    const ring = (lines: Parameters<OfflineEngine['ringUp']>[0]['lines'], prescriptions: Rx[]) =>
      engine.ringUp({ cashierUserId: CASHIER, tendered: '500', lines, prescriptions }).catch((e: OfflineSaleError) => e.code);
    const dd = rx({ patientAddress: '12 Rizal St', prescriberS2No: 'S2-1', yellowFormNo: 'YF-1', items: [{ ref: 'i1', genericName: 'Diazepam', strength: '5 mg', dosageForm: 'TABLET', quantity: '10', drugClass: 'DANGEROUS' }] });
    expect(await ring([{ variantId: VALIUM, quantity: '10', prescription: onRx }], [dd])).toBe('DANGEROUS_DRUG_OFFLINE');
    // A line pointing at a prescription not on the sale, an unused prescription, an incomplete one.
    expect(await ring([{ variantId: AMOXIL, quantity: '7', prescription: { prescriptionRef: 'rx9', itemRef: 'i1' } }], [rx()])).toBe('INVALID_PRESCRIPTION');
    expect(await ring([{ variantId: PARA, quantity: '1' }], [rx()])).toBe('INVALID_PRESCRIPTION');
    expect(await ring([{ variantId: AMOXIL, quantity: '7', prescription: onRx }], [rx({ prescriberLicenseNo: '' })])).toBe('INVALID_PRESCRIPTION');
    expect((await engine.status()).pending).toBe(0);
    // Without a prescription an antibiotic is still recorded offline: the server flags it for the pharmacist.
    expect((await engine.ringUp({ cashierUserId: CASHIER, tendered: '200', lines: [{ variantId: AMOXIL, quantity: '1' }] })).sale.deviceSeq).toBe(1);
  });

  it('labels medicines as the server does', () => {
    expect(drugLabel({ genericName: ' Ascorbic acid ', strength: '100 mg/5 mL', dosageForm: 'SYRUP' })).toBe('Ascorbic acid 100 mg/5 mL syrup');
    expect(drugLabel({ genericName: 'Zinc', strength: null, dosageForm: 'OTHER' })).toBe('Zinc other');
    expect([needsPrescription({ drugClass: 'OTC' }), needsPrescription({ drugClass: 'RX' }), needsPrescription(null)]).toEqual([false, true, false]);
  });
});
