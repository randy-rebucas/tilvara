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
}

/** What the till prints for an offline sale (never an invoice; the register number comes at sync). */
export interface OfflineReceipt {
  localReference: string;
  occurredAt: string;
  register: { code: string; name: string };
  branch: { name: string };
  seller: { name: string; registeredName: string; tin: string | null; vatStatus: 'VAT' | 'NON_VAT' };
  cashierName: string;
  /** `promotion`: the promotion that priced the line and its discount (ADR-0021). */
  /** `generic`: a medicine's generic name, strength and form (ADR-0025 §3); lots are not known offline. */
  lines: { name: string; quantity: string; unitPrice: string; amount: string; flag: string; promotion?: { name: string; discount: string }; generic?: string }[];
  totals: { gross: string; vatableSales: string; vatAmount: string; vatExemptSales: string; zeroRatedSales: string; percentageTaxSales: string; amountDue: string };
  tendered: string;
  change: string;
  notice: string;
  /** Counter service (session 25): the number the kitchen calls (the sale's device number), and the name. */
  callNumber?: number;
  pickupName?: string;
  /** A cash tip on top of the sale (session 25), outside its total. */
  tip?: string;
}

const SCHEMA_VERSION = 1;
const MIGRATIONS: Record<number, string[]> = {
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
        for (const stmt of MIGRATIONS[next]!) await this.sql.execute(stmt);
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

  async enqueue(build: (deviceSeq: number) => { envelope: OfflineSale; receipt: OfflineReceipt }, now: number): Promise<QueuedSale> {
    return this.sql.transaction(async () => {
      const seq = Number((await this.meta('next_device_seq')) ?? '1');
      const { envelope, receipt } = build(seq);
      await this.sql.execute(
        `INSERT INTO outbox (device_seq, terminal_txn_id, envelope, receipt, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
        [seq, envelope.terminalTxnId, JSON.stringify(envelope), JSON.stringify(receipt), now, now],
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

  async due(now: number, limit: number): Promise<QueuedSale[]> {
    const rows = await this.sql.select<OutboxRow>(
      `SELECT * FROM outbox WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY device_seq LIMIT ?`,
      [now, limit],
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
