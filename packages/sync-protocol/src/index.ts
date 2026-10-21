/**
 * The offline protocol between a terminal and the API (ADR-0015): what a terminal is told (snapshot),
 * what it sends back (offline sale envelopes) and what each envelope became (results). Shared by the
 * API and the POS offline engine; no runtime dependencies beyond zod.
 */
import { amountSchema, counterChoicesSchema, kitchenNoteSchema, quantitySchema } from '@1pos/validation';
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
}

/**
 * Counter service at this branch (session 25): the takeaway menu's version (immutable), what the
 * till may offer with which choices, and where each item's ticket goes, so a till can sell and print
 * kitchen tickets offline. Prices are the items' own (`items`); a choice with a variant is priced
 * there too, and one without is a free kitchen instruction.
 */
export interface SnapshotCounter {
  menuVersionId: string;
  items: {
    variantId: string;
    name: string;
    stationCode: string | null;
    modifierGroups: { id: string; name: string; minSelect: number; maxSelect: number; options: { id: string; name: string; variantId: string | null }[] }[];
  }[];
  /** Active stations of the branch; an item goes to the one with its code, else the default. */
  stations: { id: string; code: string; name: string; isDefault: boolean }[];
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
  /** Counter service, when the branch has it on and the plan includes the restaurant (session 25); else null/absent. */
  counter?: SnapshotCounter | null;
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
      /** Counter service: choices of the snapshot's menu item (`counter.menuVersionId`). */
      choices: counterChoicesSchema.optional(),
      kitchenNote: kitchenNoteSchema.optional(),
      /** Who performed or sold it (ADR-0022 §5): a staff member from the snapshot. */
      staffId: z.uuid().optional(),
    }))
    .min(1)
    .max(200),
  /** Counter service: the menu version the till sold from (its snapshot's), and the name called at pickup. */
  menuVersionId: z.uuid().optional(),
  pickupName: z.string().trim().min(1).max(60).optional(),
  /**
   * Cash only. A charge to a room (ADR-0023 §5.1) is never taken offline; an envelope that carries one
   * (an older or tampered till) is accepted here so the server can quarantine it (ROOM_CHARGE_OFFLINE).
   */
  tenders: z
    .array(z.discriminatedUnion('method', [
      z.object({ method: z.literal('CASH'), tendered: amountSchema }),
      z.object({ method: z.literal('ROOM_CHARGE'), stayId: z.uuid(), amount: amountSchema.optional() }),
    ]))
    .min(1)
    .max(10),
  /** The total the terminal computed and collected; the server must reproduce it exactly. */
  amountDue: amountSchema,
  /** A cash tip on top (session 25): the tendered cash covers the amount due and the tip. */
  tip: z.object({ amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be greater than zero') }).optional(),
});
export type OfflineSale = z.infer<typeof offlineSaleSchema>;

export const syncSalesRequestSchema = z.object({ sales: z.array(offlineSaleSchema).min(1).max(50) });
export type SyncSalesRequest = z.infer<typeof syncSalesRequestSchema>;

// ------------------------------------------------------------------ results (server → terminal)

/** Recorded, but a person should look: none of these refuse a sale (the cash was taken). */
export const OFFLINE_FLAGS = ['PRICE_CHANGED', 'SNAPSHOT_EXPIRED', 'CLOCK_ADJUSTED'] as const;
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

// ------------------------------------------------------------------ kitchen printing (session 25)

/** `POST /v1/terminal/kitchen-tickets/claim`: the stations this till prints for. */
export const claimKitchenTicketsSchema = z.object({ stationIds: z.array(z.uuid()).min(1).max(20) });
export type ClaimKitchenTicketsInput = z.infer<typeof claimKitchenTicketsSchema>;

/** A kitchen ticket as a till prints it (claimed for a minute; mark it printed, or release it). */
export interface KitchenTicketPrint {
  id: string;
  ticketNumber: number;
  /** Printed before: print "REPRINT". */
  reprint: boolean;
  course: number;
  courseNote: string | null;
  firedAt: string;
  station: { id: string; code: string; name: string };
  /** `orderType` COUNTER: `orderNumber` is the call number on the customer's receipt. */
  order: { orderNumber: number; orderType: string; tableCode: string | null; customerName: string | null };
  items: { name: string; quantity: string; seat: number | null; note: string | null; choices: string[] }[];
}

/** `GET /v1/terminal/kitchen-stations`: the stations at the till's branch, for its printer set-up. */
export interface KitchenStationsResponse {
  data: { id: string; code: string; name: string; isDefault: boolean }[];
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
