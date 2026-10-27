import type { OfflineSale, Snapshot, SyncResult } from '@1pos/sync-protocol';
import type { SqlDriver } from './sql.js';

/** Where a queued sale stands. PENDING until the server gave a final answer for it. */
export type QueueStatus = 'PENDING' | 'RECORDED' | 'QUARANTINED' | 'DISMISSED' | 'REJECTED';

export interface QueuedSale {
  deviceSeq: number;
  terminalTxnId: string;
  envelope: OfflineSale;
  receipt: OfflineReceipt;
  status: QueueStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  result: SyncResult | null;
  createdAt: number;
  syncedAt: number | null;
  /** The terminal it was rung on: only that terminal's credential delivers it (null: unknown, never sent). */
  terminalId: string | null;
}

/** What the till prints for an offline sale (never an invoice; the register number comes at sync). */
export interface OfflineReceipt {
  localReference: string;
  occurredAt: string;
  register: { code: string; name: string };
  branch: { name: string };
  /** `address`: as online receipts print it (absent on receipts queued before it was kept, or from an older snapshot). */
  seller: { name: string; registeredName: string; address?: string; tin: string | null; vatStatus: 'VAT' | 'NON_VAT' };
  cashierName: string;
  /** `promotion`: the promotion that priced the line and its discount (ADR-0021). */
  lines: { name: string; quantity: string; unitPrice: string; amount: string; flag: string; promotion?: { name: string; discount: string } }[];
  /**
   * `discount`: what promotions took off (absent on receipts queued before it was kept, so read it as 0).
   * `vatLabel`: the VAT row as online receipts word it, e.g. "VAT 12%" (absent on older receipts: "VAT").
   */
  totals: { gross: string; discount?: string; vatableSales: string; vatLabel?: string; vatAmount: string; vatExemptSales: string; zeroRatedSales: string; percentageTaxSales: string; amountDue: string };
  tendered: string;
  change: string;
  notice: string;
  /** The business's receipt messages and contact lines at the time of the sale (session 39; absent on older receipts). */
  branding?: { header: string[]; footer: string[]; contact: string[] };
}

/**
 * Whose data the till's file holds (meta `owner_*`): the terminal it was set up for, on which server,
 * and that terminal's register (from its snapshot). `pair` compares a new set-up against it.
 */
export interface TillOwner {
  terminalId: string;
  origin: string;
  registerId: string;
}

/** How a set-up went with the data already in the file. */
export type PairOutcome =
  /** Nothing was kept (a new file, or one whose owner could not be told and had nothing waiting). */
  | 'NEW'
  /** The same terminal on the same server: everything carries on. */
  | 'CONTINUED'
  /** Another terminal of the same register (a revoked one replaced, ADR-0015): it delivers the waiting sales. */
  | 'REPLACED'
  /** Another register, business or server: the previous owner's data was wiped (nothing was waiting). */
  | 'RESET';

/**
 * A set-up refused because sales of another register, business or server are still waiting: sent with
 * the new credential they would land in the wrong business. Set the till up again for the old terminal
 * (or a new terminal on its register) to deliver them first.
 */
export class TillPairingError extends Error {
  readonly kind = 'UNSENT_SALES' as const;
  constructor(readonly pending: number, readonly owner: { terminalId: string | null; origin: string | null; registerId: string | null } | null) {
    super(`${pending} sale(s) of another terminal are still waiting to be sent; set the till up for that terminal first`);
    this.name = 'TillPairingError';
  }
}

/** Device settings, not the business's data: they survive a change of owner. */
const DEVICE_META = ['printer', 'api_url'] as const;

type Migration = string | ((sql: SqlDriver) => Promise<void>);

const SCHEMA_VERSION = 3;
const MIGRATIONS: Record<number, Migration[]> = {
  1: [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
    `CREATE TABLE outbox (
       device_seq INTEGER PRIMARY KEY CHECK (device_seq > 0),
       terminal_txn_id TEXT NOT NULL UNIQUE,
       envelope TEXT NOT NULL,
       receipt TEXT NOT NULL,
       status TEXT NOT NULL CHECK (status IN ('PENDING','RECORDED','QUARANTINED','DISMISSED','REJECTED')),
       attempts INTEGER NOT NULL DEFAULT 0,
       next_attempt_at INTEGER NOT NULL,
       last_error TEXT,
       result TEXT,
       created_at INTEGER NOT NULL,
       synced_at INTEGER)`,
    `CREATE INDEX outbox_pending ON outbox (status, next_attempt_at, device_seq)`,
  ],
  // Session 39: the business's logo and background, kept by hash for the till's screens offline.
  2: [`CREATE TABLE brand_images (sha256 TEXT PRIMARY KEY, content_type TEXT NOT NULL, data TEXT NOT NULL)`],
  // Each queued sale names the terminal it was rung on, and only that terminal's credential sends it.
  // Sales already queued belong to the terminal the till is set up for (or, disconnected, the one whose
  // snapshot it holds).
  3: [
    `ALTER TABLE outbox ADD COLUMN terminal_id TEXT`,
    async (sql) => {
      const [m] = await sql.select<{ value: string }>(`SELECT value FROM meta WHERE key = 'terminal_id'`);
      const [snap] = await sql.select<{ body: string }>(`SELECT body FROM snapshot WHERE id = 1`);
      const id = m?.value ?? (snap ? (JSON.parse(snap.body) as Snapshot).terminal.id : null);
      if (id) await sql.execute(`UPDATE outbox SET terminal_id = ? WHERE terminal_id IS NULL`, [id]);
    },
  ],
};

interface OutboxRow {
  device_seq: number;
  terminal_txn_id: string;
  envelope: string;
  receipt: string;
  status: QueueStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  result: string | null;
  created_at: number;
  synced_at: number | null;
  terminal_id: string | null;
}

const toQueued = (r: OutboxRow): QueuedSale => ({
  deviceSeq: Number(r.device_seq),
  terminalTxnId: r.terminal_txn_id,
  envelope: JSON.parse(r.envelope) as OfflineSale,
  receipt: JSON.parse(r.receipt) as OfflineReceipt,
  status: r.status,
  attempts: Number(r.attempts),
  nextAttemptAt: Number(r.next_attempt_at),
  lastError: r.last_error,
  result: r.result ? (JSON.parse(r.result) as SyncResult) : null,
  createdAt: Number(r.created_at),
  syncedAt: r.synced_at === null ? null : Number(r.synced_at),
  terminalId: r.terminal_id,
});

/** The terminal's durable state: the snapshot it sells from, the queue of sales, and its sequence. */
export class LocalStore {
  constructor(readonly sql: SqlDriver) {}

  /** Create or upgrade the schema; safe to call on every start. */
  async migrate(): Promise<void> {
    await this.sql.execute(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const [row] = await this.sql.select<{ version: number }>(`SELECT version FROM schema_version`);
    let version = row ? Number(row.version) : 0;
    while (version < SCHEMA_VERSION) {
      const next = version + 1;
      await this.sql.transaction(async () => {
        for (const step of MIGRATIONS[next]!) {
          if (typeof step === 'string') await this.sql.execute(step);
          else await step(this.sql);
        }
        if (version === 0) await this.sql.execute(`INSERT INTO schema_version (version) VALUES (?)`, [next]);
        else await this.sql.execute(`UPDATE schema_version SET version = ?`, [next]);
      });
      version = next;
    }
  }

  async meta(key: string): Promise<string | null> {
    const [r] = await this.sql.select<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key]);
    return r?.value ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) await this.sql.execute(`DELETE FROM meta WHERE key = ?`, [key]);
    else await this.sql.execute(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, value]);
  }

  async snapshot(): Promise<{ body: Snapshot; fetchedAt: number } | null> {
    const [r] = await this.sql.select<{ body: string; fetched_at: number }>(`SELECT body, fetched_at FROM snapshot WHERE id = 1`);
    return r ? { body: JSON.parse(r.body) as Snapshot, fetchedAt: Number(r.fetched_at) } : null;
  }

  /** A kept brand image (base64), by its hash. */
  async brandImage(sha256: string): Promise<{ contentType: string; data: string } | null> {
    const [r] = await this.sql.select<{ content_type: string; data: string }>(`SELECT content_type, data FROM brand_images WHERE sha256 = ?`, [sha256]);
    return r ? { contentType: r.content_type, data: r.data } : null;
  }

  /** Keep an image; the ones the business no longer uses go (`keep`: the hashes still named). */
  async saveBrandImage(sha256: string, contentType: string, data: string, keep: readonly string[]): Promise<void> {
    await this.sql.transaction(async () => {
      await this.sql.execute(
        `INSERT INTO brand_images (sha256, content_type, data) VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING`,
        [sha256, contentType, data],
      );
      const kept = [...new Set([sha256, ...keep])];
      await this.sql.execute(`DELETE FROM brand_images WHERE sha256 NOT IN (${kept.map(() => '?').join(', ')})`, kept);
    });
  }

  async saveSnapshot(body: Snapshot, fetchedAt: number): Promise<void> {
    await this.sql.execute(
      `INSERT INTO snapshot (id, body, fetched_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
      [JSON.stringify(body), fetchedAt],
    );
  }

  /**
   * Take the next device sequence number and queue the sale in one local transaction: once this
   * returns, the sale survives a crash, and its number is never reused.
   */
  /** Never number a sale at or below `last` (what the server already has from this terminal). */
  async raiseSequence(last: number): Promise<void> {
    const next = Number((await this.meta('next_device_seq')) ?? '1');
    if (last + 1 > next) await this.setMeta('next_device_seq', String(last + 1));
  }

  async enqueue(build: (deviceSeq: number) => { envelope: OfflineSale; receipt: OfflineReceipt }, now: number, terminalId: string): Promise<QueuedSale> {
    return this.sql.transaction(async () => {
      const seq = Number((await this.meta('next_device_seq')) ?? '1');
      const { envelope, receipt } = build(seq);
      await this.sql.execute(
        `INSERT INTO outbox (device_seq, terminal_txn_id, envelope, receipt, status, attempts, next_attempt_at, created_at, terminal_id) VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)`,
        [seq, envelope.terminalTxnId, JSON.stringify(envelope), JSON.stringify(receipt), now, now, terminalId],
      );
      await this.setMeta('next_device_seq', String(seq + 1));
      return (await this.get(seq))!;
    });
  }

  async byTxnId(terminalTxnId: string): Promise<QueuedSale | null> {
    const [r] = await this.sql.select<OutboxRow>(`SELECT * FROM outbox WHERE terminal_txn_id = ?`, [terminalTxnId]);
    return r ? toQueued(r) : null;
  }

  async get(deviceSeq: number): Promise<QueuedSale | null> {
    const [r] = await this.sql.select<OutboxRow>(`SELECT * FROM outbox WHERE device_seq = ?`, [deviceSeq]);
    return r ? toQueued(r) : null;
  }

  /** What is due to send with `terminalId`'s credential: that terminal's waiting sales only, never another's. */
  async due(now: number, limit: number, terminalId: string): Promise<QueuedSale[]> {
    const rows = await this.sql.select<OutboxRow>(
      `SELECT * FROM outbox WHERE status = 'PENDING' AND terminal_id = ? AND next_attempt_at <= ? ORDER BY device_seq LIMIT ?`,
      [terminalId, now, limit],
    );
    return rows.map(toQueued);
  }

  async list(status?: QueueStatus): Promise<QueuedSale[]> {
    const rows = status
      ? await this.sql.select<OutboxRow>(`SELECT * FROM outbox WHERE status = ? ORDER BY device_seq`, [status])
      : await this.sql.select<OutboxRow>(`SELECT * FROM outbox ORDER BY device_seq`);
    return rows.map(toQueued);
  }

  async settle(terminalTxnId: string, result: SyncResult, now: number): Promise<void> {
    await this.sql.execute(
      `UPDATE outbox SET status = ?, result = ?, synced_at = ?, last_error = NULL WHERE terminal_txn_id = ? AND status = 'PENDING'`,
      [result.status, JSON.stringify(result), now, terminalTxnId],
    );
  }

  async backOff(deviceSeqs: number[], nextAttemptAt: (attempts: number) => number, error: string): Promise<void> {
    for (const seq of deviceSeqs) {
      const q = await this.get(seq);
      if (!q || q.status !== 'PENDING') continue;
      await this.sql.execute(`UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE device_seq = ?`, [
        q.attempts + 1, nextAttemptAt(q.attempts + 1), error, seq,
      ]);
    }
  }

  /** Ends the wait of `terminalId`'s backed-off sales: the server is reachable again, or the cashier asked. */
  async makeDue(terminalId: string, now: number): Promise<void> {
    await this.sql.execute(`UPDATE outbox SET next_attempt_at = ? WHERE status = 'PENDING' AND terminal_id = ? AND next_attempt_at > ?`, [now, terminalId, now]);
  }

  /**
   * Whose data this file holds: as recorded at the last set-up, else (a file from before owners were
   * kept) the terminal it is set up for or whose snapshot it holds, and the server it saved. Null when
   * it cannot be told.
   */
  async owner(): Promise<{ terminalId: string | null; origin: string | null; registerId: string | null } | null> {
    const terminalId = await this.meta('owner_terminal_id');
    if (terminalId) return { terminalId, origin: await this.meta('owner_origin'), registerId: await this.meta('owner_register_id') };
    const snap = await this.snapshot();
    const legacy = (await this.meta('terminal_id')) ?? snap?.body.terminal.id ?? null;
    if (!legacy) return null;
    return { terminalId: legacy, origin: await this.meta('api_url'), registerId: snap?.body.register.id ?? null };
  }

  /**
   * Set the till up for `next`, deciding in one transaction what becomes of the data already in the
   * file: the same terminal on the same server carries on; another terminal of the same register on the
   * same server takes over the waiting sales (a revoked terminal replaced, which the server accepts,
   * ADR-0015); anything else wipes the previous owner's data, and is refused with `TillPairingError`
   * (`UNSENT_SALES`) while any sale is still waiting to be sent.
   */
  async pair(next: TillOwner): Promise<PairOutcome> {
    return this.sql.transaction(async () => {
      const cur = await this.owner();
      const sameServer = !!cur && (cur.origin === null || cur.origin === next.origin);
      let outcome: PairOutcome;
      if (cur && sameServer && cur.terminalId === next.terminalId) {
        outcome = 'CONTINUED';
      } else if (cur && sameServer && cur.registerId !== null && cur.registerId === next.registerId) {
        outcome = 'REPLACED';
        await this.sql.execute(`UPDATE outbox SET terminal_id = ? WHERE status = 'PENDING'`, [next.terminalId]);
      } else {
        const pending = await this.pendingCount();
        if (pending) throw new TillPairingError(pending, cur);
        await this.wipe();
        outcome = cur ? 'RESET' : 'NEW';
      }
      await this.setMeta('owner_terminal_id', next.terminalId);
      await this.setMeta('owner_origin', next.origin);
      await this.setMeta('owner_register_id', next.registerId);
      return outcome;
    });
  }

  /**
   * Remove everything of the business the till was set up for: the snapshot (catalogue, cashier names,
   * branding), kept images, every queued or settled sale with its receipt, the sequence, sync state and
   * owner. Keeps the device settings (printer, server address). Refused while a sale is waiting.
   */
  async resetForNewOwner(): Promise<void> {
    await this.sql.transaction(async () => {
      const pending = await this.pendingCount();
      if (pending) throw new TillPairingError(pending, await this.owner());
      await this.wipe();
    });
  }

  private async pendingCount(): Promise<number> {
    const [r] = await this.sql.select<{ n: number }>(`SELECT count(*) AS n FROM outbox WHERE status = 'PENDING'`);
    return Number(r?.n ?? 0);
  }

  private async wipe(): Promise<void> {
    await this.sql.execute(`DELETE FROM outbox`);
    await this.sql.execute(`DELETE FROM snapshot`);
    await this.sql.execute(`DELETE FROM brand_images`);
    await this.sql.execute(`DELETE FROM meta WHERE key NOT IN (${DEVICE_META.map(() => '?').join(', ')})`, [...DEVICE_META]);
  }

  async counts(): Promise<Record<QueueStatus, number> & { oldestPendingAt: number | null }> {
    const rows = await this.sql.select<{ status: QueueStatus; n: number; oldest: number | null }>(
      `SELECT status, count(*) AS n, min(created_at) AS oldest FROM outbox GROUP BY status`,
    );
    const by = (s: QueueStatus) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    const pending = rows.find((r) => r.status === 'PENDING');
    return {
      PENDING: by('PENDING'), RECORDED: by('RECORDED'), QUARANTINED: by('QUARANTINED'), DISMISSED: by('DISMISSED'), REJECTED: by('REJECTED'),
      oldestPendingAt: pending?.oldest === null || pending?.oldest === undefined ? null : Number(pending.oldest),
    };
  }
}
