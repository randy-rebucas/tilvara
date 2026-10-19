import { Dec, isCurrencyCode, toDec } from '@1pos/money';
import type { OfflineSale, Snapshot, SyncResult } from '@1pos/sync-protocol';
import { calculateTax, TaxError, type TaxResult } from '@1pos/tax';
import { LocalStore, type OfflineReceipt, type QueuedSale } from './store.js';
import { TransportError, type Transport } from './transport.js';

/** A refusal at the till, before anything is stored (the cashier fixes the cart and tries again). */
export class OfflineSaleError extends Error {
  constructor(
    readonly code: 'NO_SNAPSHOT' | 'NO_OPEN_SHIFT' | 'NOT_SHIFT_OWNER' | 'UNKNOWN_ITEM' | 'QUANTITY_NOT_ALLOWED' | 'INSUFFICIENT_TENDER' | 'TAX_REFUSED' | 'TERMINAL_REVOKED',
    message: string,
  ) {
    super(message);
    this.name = 'OfflineSaleError';
  }
}

export interface EngineOptions {
  store: LocalStore;
  transport: Transport;
  /** Injected for tests: wall clock (device time) and randomness (ids, jitter). */
  now?: () => number;
  random?: () => number;
  uuid?: () => string;
  /** First retry after this long; doubles up to `maxBackoffMs`; each wait is jittered to 50–100 %. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  batchSize?: number;
}

export interface SyncReport {
  sent: number;
  results: SyncResult[];
  /** Set when the batch got no final answer; the same envelopes are retried after a backoff. */
  error?: { code: string; message: string; retryable: boolean };
}

export interface EngineStatus {
  authState: 'OK' | 'REVOKED' | 'UNAUTHENTICATED';
  pending: number;
  recorded: number;
  needsReview: number;
  oldestPendingAt: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
  /** `registerId` / `openSessionId`: what the till can sell on offline (the shift open when it last synced). */
  snapshot: { asOf: string; validUntil: string; expired: boolean; fetchedAt: number; registerId: string; openSessionId: string | null } | null;
}

const NOT_AN_INVOICE = 'THIS IS NOT AN OFFICIAL INVOICE — OFFLINE SALE, RECORDED WHEN THE TILL RECONNECTS';

/**
 * The till's offline engine (ADR-0015 §8). `ringUp` prices a cash sale from the stored snapshot with the
 * same tax engine as the server and queues it durably before anything touches the network; `syncOnce`
 * delivers what is pending in device order, keeps each envelope (and its transaction id) until the server
 * gives a final answer, and backs off on silence or server errors. All work is serialized.
 */
export class OfflineEngine {
  private readonly store: LocalStore;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly uuid: () => string;
  private readonly base: number;
  private readonly max: number;
  private readonly batch: number;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(o: EngineOptions) {
    this.store = o.store;
    this.transport = o.transport;
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.uuid = o.uuid ?? (() => crypto.randomUUID());
    this.base = o.baseBackoffMs ?? 2_000;
    this.max = o.maxBackoffMs ?? 5 * 60_000;
    this.batch = o.batchSize ?? 50;
  }

  /** Prepare the local store (creates or upgrades tables). Call once on start; pending sales resume. */
  async open(): Promise<void> {
    await this.serial(() => this.store.migrate());
  }

  /** Fetch a fresh snapshot (when online). Kept until the next one replaces it. */
  refreshSnapshot(): Promise<Snapshot> {
    return this.serial(async () => {
      const snap = await this.transport.snapshot().catch((e) => this.noteAuth(e));
      await this.store.saveSnapshot(snap, this.now());
      // A lost or restored till file restarts its counter: continue after what the server has.
      if (snap.lastDeviceSeq) await this.store.raiseSequence(snap.lastDeviceSeq);
      await this.store.setMeta('auth_state', 'OK');
      return snap;
    });
  }

  /**
   * Whether the stored snapshot is out of date (session 16): the server's catalog version moved (an
   * item, price, barcode, tax or name changed), or its next scheduled change is no longer the one the
   * snapshot knew (it took effect). Needs no device clock. False when the server cannot say (older
   * server); a failed call rejects, like any other call while offline.
   */
  async snapshotOutdated(): Promise<boolean> {
    const stored = await this.store.snapshot();
    if (!stored) return true;
    if (!this.transport.catalogVersion) return false;
    const now = await this.transport.catalogVersion();
    return now.version !== stored.body.catalogVersion || now.nextChangeAt !== (stored.body.nextChangeAt ?? null);
  }

  /** Price a cart offline exactly as the server will re-price it (no discounts offline, ADR-0015 §1). */
  async quote(lines: { variantId: string; quantity: string }[]): Promise<TaxResult & { items: Snapshot['items']; taxProfile: Snapshot['taxProfile'] }> {
    const stored = await this.store.snapshot();
    if (!stored) throw new OfflineSaleError('NO_SNAPSHOT', 'This till has no price list yet; connect once to download it');
    return { ...price(stored.body, lines), taxProfile: stored.body.taxProfile };
  }

  /** Find an item in the stored snapshot by SKU or barcode (case-insensitive SKU, exact barcode). */
  async lookup(code: string): Promise<Snapshot['items'][number] | null> {
    const stored = await this.store.snapshot();
    if (!stored) throw new OfflineSaleError('NO_SNAPSHOT', 'This till has no price list yet; connect once to download it');
    const c = code.trim();
    return stored.body.items.find((i) => i.barcodes.includes(c)) ?? stored.body.items.find((i) => i.sku.toLowerCase() === c.toLowerCase()) ?? null;
  }

  /**
   * Ring up a cash sale offline. Validates, prices, and writes the sale with its envelope and the next
   * device number in one local transaction; returns the receipt to print. Nothing is sent here.
   *
   * `terminalTxnId`: the counter passes the id of the checkout it was trying online. If that attempt
   * did reach the server, the delivery is refused as a duplicate (quarantined), never recorded twice.
   */
  ringUp(input: { cashierUserId: string; lines: { variantId: string; quantity: string }[]; tendered: string; terminalTxnId?: string }): Promise<{ sale: QueuedSale; receipt: OfflineReceipt }> {
    return this.serial(async () => {
      if ((await this.store.meta('auth_state')) === 'REVOKED') throw new OfflineSaleError('TERMINAL_REVOKED', 'This till was revoked; it cannot record sales');
      // The same checkout submitted again (double tap, retry after a crash): the sale already queued.
      const already = input.terminalTxnId ? await this.store.byTxnId(input.terminalTxnId) : null;
      if (already) return { sale: already, receipt: already.receipt };
      const stored = await this.store.snapshot();
      if (!stored) throw new OfflineSaleError('NO_SNAPSHOT', 'This till has no price list yet; connect once to download it');
      const snap = stored.body;
      const shift = snap.openSession;
      if (!shift) throw new OfflineSaleError('NO_OPEN_SHIFT', 'Open a shift while online before selling offline');
      if (shift.openedBy !== input.cashierUserId) throw new OfflineSaleError('NOT_SHIFT_OWNER', 'Only the cashier who opened this shift can sell on it');
      const priced = price(snap, input.lines);
      const due = toDec(priced.totals.amountDue);
      const tendered = toDec(input.tendered);
      if (tendered.lt(due)) throw new OfflineSaleError('INSUFFICIENT_TENDER', `The cash tendered does not cover ${due.toFixed(2)}`);
      const occurredAt = new Date(this.now()).toISOString();
      const isVat = snap.taxProfile.vatStatus === 'VAT';
      const queued = await this.store.enqueue((seq) => {
        const localReference = `${snap.register.code}-T${snap.terminal.credentialHint}-${String(seq).padStart(6, '0')}`;
        const envelope: OfflineSale = {
          terminalTxnId: input.terminalTxnId ?? this.uuid(), deviceSeq: seq, snapshotId: snap.snapshotId, cashierSessionId: shift.id, cashierUserId: input.cashierUserId,
          occurredAt, localReference, lines: input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
          tenders: [{ method: 'CASH', tendered: tendered.toFixed(2) }], amountDue: due.toFixed(2),
        };
        const receipt: OfflineReceipt = {
          localReference, occurredAt, register: { code: snap.register.code, name: snap.register.name }, branch: { name: snap.branch.name },
          seller: {
            name: snap.legalEntity.tradeName ?? snap.legalEntity.registeredName, registeredName: snap.legalEntity.registeredName,
            // As online receipts print it; a snapshot from before `receiptTin` existed has only the bare TIN.
            tin: snap.legalEntity.receiptTin ?? snap.legalEntity.tin, vatStatus: snap.taxProfile.vatStatus,
          },
          cashierName: shift.cashierName,
          lines: priced.lines.map((l, i) => {
            const item = priced.items[i]!;
            return {
              name: item.name, quantity: input.lines[i]!.quantity, unitPrice: toDec(item.unitPrice).toFixed(2), amount: toDec(l.amountDue).toFixed(2),
              flag: !isVat ? '' : item.vatTreatment === 'ZERO_RATED' ? 'Z' : item.vatTreatment === 'VAT_EXEMPT' ? 'E' : 'V',
            };
          }),
          totals: {
            gross: priced.totals.gross, vatableSales: priced.totals.vatableSales, vatAmount: priced.totals.vatAmount, vatExemptSales: priced.totals.vatExemptSales,
            zeroRatedSales: priced.totals.zeroRatedSales, percentageTaxSales: priced.totals.percentageTaxSales, amountDue: due.toFixed(2),
          },
          tendered: tendered.toFixed(2), change: tendered.minus(due).toFixed(2), notice: NOT_AN_INVOICE,
        };
        return { envelope, receipt };
      }, this.now());
      return { sale: queued, receipt: queued.receipt };
    });
  }

  /**
   * Deliver what is due, oldest first, one batch. A final answer settles each envelope; no answer, a
   * 5xx or a rate limit backs the batch off (same envelopes, same ids next time); a refused credential
   * stops syncing until a new snapshot succeeds.
   */
  syncOnce(): Promise<SyncReport> {
    return this.serial(async () => {
      if ((await this.store.meta('auth_state')) === 'REVOKED') return { sent: 0, results: [], error: { code: 'TERMINAL_REVOKED', message: 'This till was revoked', retryable: false } };
      const due = await this.store.due(this.now(), this.batch);
      if (!due.length) return { sent: 0, results: [] };
      let results: SyncResult[];
      try {
        results = (await this.transport.syncSales(due.map((q) => q.envelope))).results;
      } catch (e) {
        const err = e instanceof TransportError ? e : new TransportError('NETWORK', (e as Error).message);
        if (err.status === 401) {
          await this.noteAuthState(err);
        } else {
          await this.store.backOff(due.map((q) => q.deviceSeq), (n) => this.nextAttempt(n), `${err.code ?? err.kind}: ${err.message}`);
        }
        await this.store.setMeta('last_error', `${err.code ?? err.kind}: ${err.message}`);
        return { sent: due.length, results: [], error: { code: err.code ?? err.kind, message: err.message, retryable: err.retryable } };
      }
      const now = this.now();
      for (const r of results) await this.store.settle(r.terminalTxnId, r, now);
      // Anything the server did not answer for stays pending. A server out of time answers the oldest
      // part of a batch (always at least one): the rest is simply not reached yet and stays due now, so
      // drain() goes on at once. No answer at all for the batch is a failure and backs off.
      const answered = new Set(results.map((r) => r.terminalTxnId));
      const missing = due.filter((q) => !answered.has(q.terminalTxnId)).map((q) => q.deviceSeq);
      if (missing.length && !results.length) await this.store.backOff(missing, (n) => this.nextAttempt(n), 'NO_RESULT');
      await this.store.setMeta('last_sync_at', String(now));
      await this.store.setMeta('last_error', null);
      return { sent: due.length, results };
    });
  }

  /** Sync until nothing is due (or an attempt fails); returns every batch's report. */
  async drain(): Promise<SyncReport[]> {
    const reports: SyncReport[] = [];
    for (;;) {
      const r = await this.syncOnce();
      reports.push(r);
      if (!r.sent || r.error) return reports;
    }
  }

  /** Background sync every `intervalMs` (the desktop shell calls this once). */
  start(intervalMs = 10_000): void {
    this.stop();
    this.timer = setInterval(() => void this.syncOnce().catch(() => undefined), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async status(): Promise<EngineStatus> {
    return this.serial(async () => {
      const c = await this.store.counts();
      const snap = await this.store.snapshot();
      const lastSync = await this.store.meta('last_sync_at');
      return {
        authState: ((await this.store.meta('auth_state')) ?? 'OK') as EngineStatus['authState'],
        pending: c.PENDING,
        recorded: c.RECORDED,
        needsReview: c.QUARANTINED + c.REJECTED,
        oldestPendingAt: c.oldestPendingAt,
        lastSyncAt: lastSync ? Number(lastSync) : null,
        lastError: await this.store.meta('last_error'),
        snapshot: snap
          ? {
              asOf: snap.body.asOf, validUntil: snap.body.validUntil, expired: this.now() > Date.parse(snap.body.validUntil), fetchedAt: snap.fetchedAt,
              registerId: snap.body.register.id, openSessionId: snap.body.openSession?.id ?? null,
            }
          : null,
      };
    });
  }

  /** Exponential backoff with jitter: base × 2^(n−1), capped, then 50–100 % of it. */
  private nextAttempt(attempts: number): number {
    const ceiling = Math.min(this.max, this.base * 2 ** (attempts - 1));
    return this.now() + Math.round(ceiling * (0.5 + this.random() / 2));
  }

  private async noteAuth(e: unknown): Promise<never> {
    if (e instanceof TransportError && e.status === 401) await this.noteAuthState(e);
    throw e;
  }

  private async noteAuthState(e: TransportError) {
    await this.store.setMeta('auth_state', e.code === 'TERMINAL_REVOKED' ? 'REVOKED' : 'UNAUTHENTICATED');
  }

  /** One thing at a time on the local database (one connection, no interleaved transactions). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/** The server's `computeCart` for a cash cart without discounts, from the snapshot (ADR-0015 §3). */
function price(snap: Snapshot, lines: { variantId: string; quantity: string }[]): TaxResult & { items: Snapshot['items'] } {
  if (!isCurrencyCode(snap.currency)) throw new OfflineSaleError('TAX_REFUSED', `Currency ${snap.currency} is not supported`);
  const items = lines.map((l, i) => {
    const item = snap.items.find((x) => x.variantId === l.variantId);
    if (!item) throw new OfflineSaleError('UNKNOWN_ITEM', `Item on line ${i + 1} is not in this till's price list`);
    if (item.wholeUnits && !toDec(l.quantity).isInteger()) throw new OfflineSaleError('QUANTITY_NOT_ALLOWED', `${item.name} is sold in whole units`);
    if (!(toDec(l.quantity).gt(new Dec(0)))) throw new OfflineSaleError('QUANTITY_NOT_ALLOWED', 'Quantities must be greater than zero');
    return item;
  });
  try {
    const result = calculateTax(
      { currency: snap.currency, profile: snap.taxProfile },
      lines.map((l, i) => ({ id: String(i + 1), unitPrice: items[i]!.unitPrice, quantity: l.quantity, priceIncludesTax: items[i]!.priceIncludesTax, vatTreatment: items[i]!.vatTreatment })),
    );
    return { ...result, items };
  } catch (e) {
    if (e instanceof TaxError) throw new OfflineSaleError('TAX_REFUSED', e.message);
    throw e;
  }
}
