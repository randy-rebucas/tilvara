/**
 * The offline protocol between a terminal and the API (ADR-0015): what a terminal is told (snapshot),
 * what it sends back (offline sale envelopes) and what each envelope became (results). Shared by the
 * API and the POS offline engine; no runtime dependencies beyond zod.
 */
import { amountSchema, quantitySchema, salePrescriptionSchema } from '@1pos/validation';
import type { Promotion } from '@1pos/pricing';
import { z } from 'zod';

/** Headers a terminal authenticates with (sync and snapshot only). */
export const TERMINAL_ID_HEADER = 'x-terminal-id';
/** `Authorization: Terminal <credential>` — the one-time secret issued when the terminal was registered. */
export const TERMINAL_AUTH_SCHEME = 'Terminal';

// ------------------------------------------------------------------ snapshot (server → terminal)

export interface SnapshotItem {
  variantId: string;
  sku: string;
  name: string;
  barcodes: string[];
  priceId: string;
  priceListId: string;
  /** Unit price as a decimal string. */
  unitPrice: string;
  priceIncludesTax: boolean;
  vatTreatment: 'VATABLE' | 'VAT_EXEMPT' | 'ZERO_RATED';
  taxCategoryCode: string;
  /** Sold in whole units unless the unit allows fractions or the item is sold by weight. */
  wholeUnits: boolean;
  trackInventory: boolean;
  /** Its button on the till's quick keys (1–48), if any (ADR-0021 §3; absent from older servers). */
  quickKey?: number | null;
  /** STANDARD, SERVICE or PACKAGE (ADR-0022; absent from older servers). A package is sold online only. */
  productType?: 'STANDARD' | 'SERVICE' | 'PACKAGE';
  /** A medicine (ADR-0025 §2): searched by generic name, equivalents by `genericKey`; absent for other items and from older servers. */
  drug?: SnapshotDrug | null;
}

/** A medicine's details as the till shows and searches them (ADR-0025 §3). */
export interface SnapshotDrug {
  drugClass: 'OTC' | 'RX' | 'ANTIBIOTIC' | 'DANGEROUS';
  genericName: string;
  strength: string | null;
  dosageForm: string;
  genericKey: string;
  /** Pieces in one unit down its pack links (a box of 10 strips of 10: "100"); a prescription counts pieces. Absent from older servers. */
  piecesPerUnit?: string;
}

export interface Snapshot {
  snapshotId: string;
  /** Server clock when the snapshot was taken; offline sales are re-priced as of this instant. */
  asOf: string;
  /** After this, offline sales are still accepted but flagged SNAPSHOT_EXPIRED. */
  validUntil: string;
  terminal: { id: string; name: string; credentialHint: string };
  register: { id: string; code: string; name: string };
  branch: { id: string; code: string; name: string; timezone: string };
  /** `receiptTin`: the TIN as receipts print it (with this branch's BIR branch code), e.g. 123-456-789-00000. */
  legalEntity: { id: string; registeredName: string; tradeName: string | null; tin: string | null; receiptTin: string | null };
  currency: string;
  /** The tax profile in force (ADR-0008), exactly as `@1pos/tax` takes it. */
  taxProfile: { id: string; effectiveFrom: string; vatStatus: 'VAT' | 'NON_VAT'; vatRate: string; roundingMode: 'HALF_UP' | 'HALF_EVEN' };
  /** The open shift on this register, if any — offline sales go on it. */
  openSession: { id: string; openedBy: string; cashierName: string; openedAt: string } | null;
  items: SnapshotItem[];
  /**
   * Paged snapshots only (`?pageSize=`): the cursor for the next page of `items`, fetched from
   * `GET /v1/terminal/snapshot/:snapshotId/items?after=<nextPage>&pageSize=`; null on the last page.
   * Absent when the whole list came in one answer.
   */
  nextPage?: string | null;
  /**
   * The business's catalog version when the snapshot was taken (session 16; absent from older servers).
   * When `GET /v1/terminal/catalog-version` answers another one, the snapshot is out of date.
   */
  catalogVersion?: number;
  /** The next scheduled price or tax change at this branch after `asOf`, if any: refresh then. */
  nextChangeAt?: string | null;
  /**
   * The highest `deviceSeq` the server has from this terminal (session 16). A till whose file was lost
   * or restored from an old copy numbers its next sales after it, so local references never repeat.
   */
  lastDeviceSeq?: number;
  /**
   * Promotions in force at this branch at `asOf` (ADR-0021 §1), applied with `@1pos/pricing` exactly as
   * the server re-prices the sale; absent from older servers (no promotions).
   */
  promotions?: Promotion[];
  /** The branch's active service staff (ADR-0022 §5), to name who did a service; absent from older servers. */
  staff?: { id: string; displayName: string; color: string | null }[];
}

/** `GET /v1/terminal/catalog-version`: cheap enough to ask every half minute. */
export interface CatalogVersion {
  version: number;
  /** The next scheduled price or tax change at the terminal's branch, after now. */
  nextChangeAt: string | null;
}

/** One further page of a paged snapshot's items, priced as of the same `asOf`. */
export interface SnapshotItemsPage {
  snapshotId: string;
  items: SnapshotItem[];
  nextPage: string | null;
}

/** Items per snapshot page: tills ask for SNAPSHOT_PAGE_SIZE; the server accepts 100–5,000. */
export const SNAPSHOT_PAGE_SIZE = 1000;
export const snapshotPageQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(100).max(5000).optional(),
});
export const snapshotItemsQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(100).max(5000).default(SNAPSHOT_PAGE_SIZE),
  /** Opaque cursor from the previous page (the server's; the till passes it back unchanged). */
  after: z.string().min(1).max(400),
});
export type SnapshotPageQuery = z.infer<typeof snapshotPageQuerySchema>;
export type SnapshotItemsQuery = z.infer<typeof snapshotItemsQuerySchema>;

// ------------------------------------------------------------------ envelopes (terminal → server)

export const offlineSaleSchema = z.object({
  terminalTxnId: z.uuid(),
  /** Strictly increasing per terminal; the server processes a batch in this order. */
  deviceSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  snapshotId: z.uuid(),
  cashierSessionId: z.uuid(),
  cashierUserId: z.uuid(),
  /** Device clock when the sale was completed (ISO 8601 with offset). */
  occurredAt: z.iso.datetime({ offset: true }),
  /** What the offline receipt printed, e.g. "R1-T7F2A-000042". */
  localReference: z.string().trim().min(1).max(64),
  lines: z
    .array(z.object({
      id: z.string().trim().min(1).max(64).optional(),
      variantId: z.uuid(),
      quantity: quantitySchema,
      /** Who performed or sold it (ADR-0022 §5): a staff member from the snapshot. */
      staffId: z.uuid().optional(),
      /** A prescription medicine (ADR-0025 §6): the item of a prescription recorded with this sale. */
      prescription: z.object({ prescriptionRef: z.string().trim().min(1).max(64), itemRef: z.string().trim().min(1).max(64) }).optional(),
    }))
    .min(1)
    .max(200),
  /**
   * Prescriptions recorded at the offline till (ADR-0025 §6); the snapshot has no patient data, so an
   * offline sale never fills an earlier prescription. A dangerous drug is never sold offline.
   */
  prescriptions: z.array(salePrescriptionSchema).max(10).optional(),
  /** Cash only; an envelope with any other tender is quarantined as unreadable (VALIDATION_FAILED). */
  tenders: z
    .array(z.object({ method: z.literal('CASH'), tendered: amountSchema }))
    .min(1)
    .max(10),
  /** The total the terminal computed and collected; the server must reproduce it exactly. */
  amountDue: amountSchema,
  /** A cash tip on top (session 25): the tendered cash covers the amount due and the tip. */
  tip: z.object({ amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be greater than zero') }).optional(),
});
export type OfflineSale = z.infer<typeof offlineSaleSchema>;

/** What a till sends (each envelope valid: the engine checks it with offlineSaleSchema before queueing it). */
export const syncSalesRequestSchema = z.object({ sales: z.array(offlineSaleSchema).min(1).max(50) });
export type SyncSalesRequest = z.infer<typeof syncSalesRequestSchema>;

/**
 * What the server accepts: only each envelope's id and device number are required here, so one malformed
 * envelope (an older or faulty till) cannot block the queue behind it. The server checks each envelope with
 * `offlineSaleSchema` on its own and quarantines one that fails (VALIDATION_FAILED), stored as received.
 * A batch without even these is not a till's: 400.
 */
export const syncSalesBatchSchema = z.object({
  sales: z
    .array(offlineSaleSchema.pick({ terminalTxnId: true, deviceSeq: true }).loose()
      .describe('An offline sale envelope (OfflineSale, @1pos/sync-protocol). Only terminalTxnId and deviceSeq are checked with the batch; an envelope that fails the full check is quarantined with VALIDATION_FAILED.'))
    .min(1)
    .max(50),
});
export type SyncSalesBatch = z.infer<typeof syncSalesBatchSchema>;
/** One envelope as received: its head is known, the rest is unchecked. */
export type ReceivedEnvelope = SyncSalesBatch['sales'][number];

// ------------------------------------------------------------------ results (server → terminal)

/** Recorded, but a person should look: none of these refuse a sale (the cash was taken). */
/**
 * PRESCRIPTION_REVIEW (ADR-0025 §6): a prescription medicine was dispensed without a valid prescription
 * record; EXPIRED_STOCK (§4): it drew expired or held lots (read from the lot draws, not stored on the sale).
 */
export const OFFLINE_FLAGS = ['PRICE_CHANGED', 'SNAPSHOT_EXPIRED', 'CLOCK_ADJUSTED', 'PRESCRIPTION_REVIEW', 'EXPIRED_STOCK'] as const;
export type OfflineFlag = (typeof OFFLINE_FLAGS)[number];

export type SyncResult =
  | { terminalTxnId: string; deviceSeq: number; status: 'RECORDED'; saleId: string; saleNumber: number; reference: string; flags: OfflineFlag[]; replayed: boolean }
  | { terminalTxnId: string; deviceSeq: number; status: 'QUARANTINED'; code: string; message: string; replayed: boolean }
  | { terminalTxnId: string; deviceSeq: number; status: 'DISMISSED'; replayed: true }
  /** Not processed (e.g. the same id with a different payload); the terminal must not retry it as is. */
  | { terminalTxnId: string; deviceSeq: number; status: 'REJECTED'; code: string; message: string; replayed: false };

export interface SyncSalesResponse {
  results: SyncResult[];
}

/**
 * A stable serialization (sorted keys) of a parsed envelope, so a retry with the same content hashes
 * the same whatever order the client wrote the keys in.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export * from './scale.js';
