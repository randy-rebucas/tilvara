import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import {
  and,
  asc,
  branches,
  cashierSessions,
  desc,
  eq,
  legalEntities,
  registers,
  sales,
  sql,
  terminals,
  terminalSnapshots,
  terminalTransactions,
  users,
  withTenant,
  type Database,
} from '@1pos/database';
import {
  canonicalJson, offlineSaleSchema, TERMINAL_AUTH_SCHEME, TERMINAL_ID_HEADER,
  type CatalogVersion, type ReceivedEnvelope, type OfflineFlag, type OfflineSale, type Snapshot, type SnapshotBranding, type SnapshotItem, type SnapshotItemsPage, type SyncResult,
} from '@1pos/sync-protocol';
import type { DismissOfflineInput, OfflineListQuery } from '@1pos/validation';
import { createHash } from 'node:crypto';
import type { AuthContext } from '../auth/auth-context.js';
import { loadGrants } from '../auth/auth.guard.js';
import { dbNow, EFFECTIVE_SKEW } from '../common/clock.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { ENV } from '../infrastructure/env.provider.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { ApiMetrics } from '../infrastructure/metrics.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { registerScope } from '../sales/cash.service.js';
import { formatTin } from '../sales/receipt.js';
import { SalesService, type OfflineContext } from '../sales/sales.service.js';
import { profilesInForce } from '../tax/tax-profiles.js';
import { nextPromotionChange, promotionsInForce } from '../catalog/promotions.service.js';
import { usableExtensions } from '../extensions/gate.js';
import { readBranding, readBrandImage, receiptBranding, type BrandingView } from '../business/branding.js';

/** A terminal that proved its credential (ADR-0015 §2). The tenant comes from the credential, never the request. */
export interface TerminalPrincipal {
  terminalId: string;
  tenantId: string;
  registerId: string;
  correlationId: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unauthenticated = (code = 'UNAUTHENTICATED', message = 'Terminal authentication required') => new AppError(code, message, HttpStatus.UNAUTHORIZED);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Snapshot page cursor: base64url(JSON [sku, variantId]) of the last item sent (pages follow ORDER BY sku, id). */
const encodeCursor = (sku: string, variantId: string) => Buffer.from(JSON.stringify([sku, variantId])).toString('base64url');
function decodeCursor(cursor: string): { sku: string; variantId: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && v[0].length <= 64 && typeof v[1] === 'string' && UUID.test(v[1])) {
      return { sku: v[0], variantId: v[1] };
    }
  } catch {
    // not a cursor
  }
  return null;
}
/** A till with an open shift on its register that has not been in touch this long is reported silent. */
const TILL_SILENCE_MINUTES = 30;

type Delivery = typeof terminalTransactions.$inferSelect;
type EnvelopeHead = Pick<OfflineSale, 'terminalTxnId' | 'deviceSeq'>;

const envelopePipe = new ZodPipe(offlineSaleSchema);
/** A stored or received envelope as an offline sale, or why it is not one (VALIDATION_FAILED with the zod issues). */
function readEnvelope(payload: unknown): OfflineSale | AppError {
  try {
    return envelopePipe.transform(payload);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return new AppError('VALIDATION_FAILED', 'The till sent a sale this server cannot read', HttpStatus.UNPROCESSABLE_ENTITY, e.details);
  }
}
/** An instant clients can format, or null (an unreadable envelope's `occurredAt` may be any text). */
const validInstant = (v: string | null) => (v !== null && Number.isFinite(Date.parse(v)) ? v : null);
/** A stored payload's field, for display only: payloads quarantined as unreadable may lack any field. */
const payloadField = (payload: unknown, key: string): string | null => {
  const v = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : null;
};

/**
 * Offline sync (ADR-0015): terminals fetch snapshots and deliver offline sales; managers review the
 * ones that could not be recorded. Each sale is its own transaction, so one refusal never undoes or
 * blocks the others, and a retried delivery returns its first result.
 */
@Injectable()
export class SyncService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(DatabasePool) private readonly database: DatabasePool,
    @Inject(SalesService) private readonly sales: SalesService,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(ApiMetrics) private readonly metrics: ApiMetrics,
  ) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- terminal side
  async authenticate(header: (name: string) => string | undefined, correlationId: string | undefined): Promise<TerminalPrincipal> {
    const id = header(TERMINAL_ID_HEADER);
    const authz = header('authorization');
    const prefix = `${TERMINAL_AUTH_SCHEME} `;
    if (!id || !UUID.test(id) || !authz?.startsWith(prefix)) throw unauthenticated();
    const { rows } = await this.database.pool.query<{ tenant_id: string; register_id: string; status: string; tenant_status: string }>(
      'SELECT * FROM auth_terminal($1, $2)',
      [id, sha256(authz.slice(prefix.length).trim())],
    );
    const t = rows[0];
    if (!t) throw unauthenticated();
    if (t.status !== 'ACTIVE') throw unauthenticated('TERMINAL_REVOKED', 'This terminal was revoked; keep its unsent sales and ask a manager');
    // A business being closed (OFFBOARDING, CLOSED) gets no snapshot and records no sale (audit 45 #28). A suspended
    // or lapsed one still syncs: its sales are recorded or quarantined by the read-only rules (ADR-0015).
    if (t.tenant_status !== 'ACTIVE' && t.tenant_status !== 'SUSPENDED') {
      throw unauthenticated('BUSINESS_CLOSED', 'This business is closed on Tilvara; keep the till\'s unsent sales and contact support');
    }
    return { terminalId: id, tenantId: t.tenant_id, registerId: t.register_id, correlationId };
  }

  /**
   * What the terminal needs to sell offline, as of now (DB clock); recorded so sales can name it.
   * With `pageSize`, only the first page of items comes back, with `nextPage` for `snapshotItems`.
   */
  snapshot(t: TerminalPrincipal, pageSize?: number): Promise<Snapshot> {
    return withTenant(this.database.pool, t.tenantId, async (db) => {
      const [row] = await db
        .select({ terminal: { id: terminals.id, name: terminals.name, credentialHint: terminals.credentialHint }, register: registers, branch: branches, entity: legalEntities })
        .from(terminals)
        .innerJoin(registers, eq(registers.id, terminals.registerId))
        .innerJoin(branches, eq(branches.id, registers.branchId))
        .innerJoin(legalEntities, eq(legalEntities.id, branches.legalEntityId))
        .where(eq(terminals.id, t.terminalId));
      if (!row) throw unauthenticated();
      // The plain DB clock, not "in force now" with its skew allowance: a price set a moment after the
      // snapshot must not count as already in force when the sale is re-priced at this instant.
      // Read before the items: an edit landing in between makes the till refresh once more, never miss one.
      const catalogVersion = await this.versionOf(db);
      const asOf = await dbNow(db);
      const profile = (await profilesInForce(db, [row.entity.id], asOf)).get(row.entity.id);
      if (!profile) throw new AppError('TAX_PROFILE_MISSING', 'The legal entity has no tax profile in force', HttpStatus.CONFLICT);
      const { items, nextPage } = await this.itemsPage(db, row.branch.id, asOf, pageSize);
      const [open] = await db
        .select({ id: cashierSessions.id, openedBy: cashierSessions.openedBy, openedAt: cashierSessions.openedAt, cashierName: users.displayName })
        .from(cashierSessions)
        .innerJoin(users, eq(users.id, cashierSessions.openedBy))
        .where(and(eq(cashierSessions.registerId, row.register.id), eq(cashierSessions.status, 'OPEN')));
      const { rows: [access] } = await db.execute<{ writable: boolean }>(sql`
        SELECT app_subscription_write_allowed() AND (SELECT status FROM tenants) = 'ACTIVE' AS writable`);
      const [snap] = await db.insert(terminalSnapshots)
        .values({ tenantId: t.tenantId, terminalId: t.terminalId, registerId: row.register.id, asOf, businessWritable: access?.writable === true })
        .returning({ id: terminalSnapshots.id });
      return {
        snapshotId: snap!.id,
        asOf: asOf.toISOString(),
        validUntil: new Date(asOf.getTime() + this.env.OFFLINE_WINDOW_HOURS * 3_600_000).toISOString(),
        // Whether sales rung on this snapshot are recorded (a lapsed or suspended business: they wait for review).
        businessWritable: access?.writable === true,
        terminal: row.terminal,
        register: { id: row.register.id, code: row.register.code, name: row.register.name },
        branch: { id: row.branch.id, code: row.branch.code, name: row.branch.name, timezone: row.branch.timezone },
        legalEntity: {
          id: row.entity.id, registeredName: row.entity.registeredName, tradeName: row.entity.tradeName, tin: row.entity.tin,
          receiptTin: formatTin(row.entity.tin, row.branch.birBranchCode),
          // As online receipts print it (`receipt.ts`): the branch's address, else the registered one.
          receiptAddress: row.branch.address ?? row.entity.registeredAddress ?? null,
        },
        currency: items[0]?.currency ?? 'PHP',
        taxProfile: { id: profile.id, effectiveFrom: profile.effectiveFrom, vatStatus: profile.vatStatus, vatRate: profile.vatRate, roundingMode: profile.roundingMode },
        openSession: open ? { id: open.id, openedBy: open.openedBy, openedAt: open.openedAt.toISOString(), cashierName: open.cashierName } : null,
        items: items.map(({ currency: _c, ...i }) => i),
        ...(pageSize ? { nextPage } : {}),
        catalogVersion,
        nextChangeAt: await this.nextChange(db, row.branch.id, row.entity.id, asOf),
        lastDeviceSeq: Number(
          (await db.execute<{ n: string }>(sql`SELECT coalesce(max(device_seq), 0)::text AS n FROM terminal_transactions WHERE terminal_id = ${t.terminalId}`)).rows[0]!.n,
        ),
        promotions: await promotionsInForce(db, row.branch.id, asOf),
        extensions: await usableExtensions(db),
        branding: snapshotBranding(await readBranding(db)),
      };
    });
  }

  /** The business's logo or background for the till to keep (session 39); the snapshot names it by hash. */
  async brandImage(t: TerminalPrincipal, kind: 'LOGO' | 'BACKGROUND') {
    const img = await withTenant(this.database.pool, t.tenantId, (db) => readBrandImage(db, kind));
    if (!img) throw notFound(kind === 'LOGO' ? 'Logo' : 'Background');
    return img;
  }

  /** The business's catalog version, and the next scheduled change at this terminal's branch (session 16). */
  catalogVersion(t: TerminalPrincipal): Promise<CatalogVersion> {
    return withTenant(this.database.pool, t.tenantId, async (db) => {
      const [row] = await db
        .select({ branchId: branches.id, entityId: branches.legalEntityId })
        .from(terminals)
        .innerJoin(registers, eq(registers.id, terminals.registerId))
        .innerJoin(branches, eq(branches.id, registers.branchId))
        .where(eq(terminals.id, t.terminalId));
      if (!row) throw unauthenticated();
      return { version: await this.versionOf(db), nextChangeAt: await this.nextChange(db, row.branchId, row.entityId, await dbNow(db)) };
    });
  }

  private async versionOf(db: Database): Promise<number> {
    const { rows } = await db.execute<{ version: string }>(sql`SELECT version::text FROM catalog_versions`);
    return Number(rows[0]?.version ?? 0);
  }

  /** The earliest price of the branch's list or tax profile of its entity taking effect after `after`. */
  private async nextChange(db: Database, branchId: string, entityId: string, after: Date): Promise<string | null> {
    const at = after.toISOString();
    const { rows } = await db.execute<{ next: string | null }>(sql`
      WITH list AS (
        SELECT coalesce(
          (SELECT bpl.price_list_id FROM branch_price_lists bpl
             JOIN price_lists pl ON pl.tenant_id = bpl.tenant_id AND pl.id = bpl.price_list_id AND pl.archived_at IS NULL
            WHERE bpl.branch_id = ${branchId}),
          (SELECT id FROM price_lists WHERE is_default AND archived_at IS NULL)) AS id)
      SELECT least(
               (SELECT min(pp.effective_from) FROM product_prices pp WHERE pp.price_list_id = (SELECT id FROM list) AND pp.effective_from > ${at}::timestamptz),
               (SELECT min(tp.effective_from) FROM tax_profiles tp WHERE tp.legal_entity_id = ${entityId} AND tp.effective_from > ${at}::timestamptz)
             ) AS next`);
    // A promotion starting or ending at this branch changes prices too (ADR-0021 §1).
    const promo = await nextPromotionChange(db, branchId, after);
    const next = [rows[0]?.next ? new Date(rows[0].next) : null, promo].filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0];
    return next ? next.toISOString() : null;
  }

  /**
   * A further page of one of this terminal's snapshots, priced as of the snapshot's `asOf` (so every
   * page agrees with the first). Another terminal's snapshot, or a cursor that is not ours: 404/400.
   * An item archived between two pages is simply not sent; the cursor (sku, id) never repeats or skips one.
   */
  snapshotItems(t: TerminalPrincipal, snapshotId: string, after: string, pageSize: number): Promise<SnapshotItemsPage> {
    const cursor = decodeCursor(after);
    if (!cursor) throw new AppError('VALIDATION_FAILED', 'Not a snapshot page cursor', HttpStatus.BAD_REQUEST);
    return withTenant(this.database.pool, t.tenantId, async (db) => {
      const [snap] = await db
        .select({ asOf: terminalSnapshots.asOf, branchId: registers.branchId })
        .from(terminalSnapshots)
        .innerJoin(registers, eq(registers.id, terminalSnapshots.registerId))
        .where(and(eq(terminalSnapshots.id, snapshotId), eq(terminalSnapshots.terminalId, t.terminalId)));
      if (!snap) throw notFound('Snapshot');
      const { items, nextPage } = await this.itemsPage(db, snap.branchId, snap.asOf, pageSize, cursor);
      return { snapshotId, items: items.map(({ currency: _c, ...i }) => i), nextPage };
    });
  }

  /** Items in (sku, id) order, at most `pageSize` (all when absent), after `cursor`; `nextPage` when more follow. */
  private async itemsPage(db: Database, branchId: string, asOf: Date, pageSize?: number, cursor?: { sku: string; variantId: string }) {
    const rows = await this.items(db, branchId, asOf, pageSize ? pageSize + 1 : undefined, cursor);
    if (!pageSize || rows.length <= pageSize) return { items: rows, nextPage: null };
    const items = rows.slice(0, pageSize);
    const last = items[items.length - 1]!;
    return { items, nextPage: encodeCursor(last.sku, last.variantId) };
  }

  /** Active items with a price in force at the branch at `asOf` (same rules as `PricingService.effectivePrices`). */
  private async items(db: Database, branchId: string, asOf: Date, limit?: number, after?: { sku: string; variantId: string }): Promise<(SnapshotItem & { currency: string })[]> {
    const { rows } = await db.execute<{
      variant_id: string; sku: string; name: string; barcodes: string[] | null; price_id: string; price_list_id: string; amount: string;
      currency: string; prices_include_tax: boolean; vat_treatment: SnapshotItem['vatTreatment']; tax_category_code: string; whole_units: boolean; track_inventory: boolean; quick_key_position: number | null;
      product_type: NonNullable<SnapshotItem['productType']>;
    }>(sql`
      WITH list AS (
        SELECT coalesce(
          (SELECT bpl.price_list_id FROM branch_price_lists bpl
             JOIN price_lists pl ON pl.tenant_id = bpl.tenant_id AND pl.id = bpl.price_list_id AND pl.archived_at IS NULL
            WHERE bpl.branch_id = ${branchId}),
          (SELECT id FROM price_lists WHERE is_default AND archived_at IS NULL)) AS id)
      SELECT v.id AS variant_id, v.sku,
             CASE WHEN v.name IS NULL THEN p.name ELSE p.name || ' — ' || v.name END AS name,
             (SELECT array_agg(b.code ORDER BY b.code) FROM barcodes b WHERE b.variant_id = v.id AND b.archived_at IS NULL) AS barcodes,
             pr.id AS price_id, pl.id AS price_list_id, pr.amount::text AS amount, pl.currency, pl.prices_include_tax,
             tc.vat_treatment, tc.code AS tax_category_code,
             (p.sold_by = 'UNIT' AND NOT u.allows_fraction) AS whole_units, p.track_inventory, v.quick_key_position, p.product_type
        FROM list
        JOIN price_lists pl ON pl.id = list.id
        JOIN product_variants v ON v.archived_at IS NULL
        JOIN products p ON p.id = v.product_id AND p.archived_at IS NULL
        JOIN tax_categories tc ON tc.id = p.tax_category_id
        JOIN units_of_measure u ON u.id = p.uom_id
        JOIN LATERAL (SELECT id, amount FROM product_prices pp
                       WHERE pp.price_list_id = list.id AND pp.variant_id = v.id AND pp.effective_from <= ${asOf.toISOString()}::timestamptz
                         AND pp.created_at <= ${asOf.toISOString()}::timestamptz + ${sql.raw(EFFECTIVE_SKEW)}
                       ORDER BY pp.effective_from DESC LIMIT 1) pr ON true
       ${after ? sql`WHERE (v.sku, v.id) > (${after.sku}, ${after.variantId}::uuid)` : sql``}
       ORDER BY v.sku, v.id
       ${limit ? sql`LIMIT ${limit}` : sql``}`);
    return rows.map((r) => ({
      variantId: r.variant_id, sku: r.sku, name: r.name, barcodes: r.barcodes ?? [], priceId: r.price_id, priceListId: r.price_list_id,
      unitPrice: r.amount, priceIncludesTax: r.prices_include_tax, vatTreatment: r.vat_treatment, taxCategoryCode: r.tax_category_code,
      wholeUnits: r.whole_units, trackInventory: r.track_inventory, quickKey: r.quick_key_position, productType: r.product_type, currency: r.currency,
    }));
  }

  /**
   * Deliver offline sales, oldest first; each result is final for that envelope (replays answer the same).
   * Stops starting new envelopes once SYNC_BATCH_BUDGET_MS has passed since the request arrived
   * (`receivedAt`, so time spent waiting for a pool connection or authenticating counts too; at
   * least one envelope is always delivered): the till gets its answer before its own timeout and sends
   * the rest again.
   */
  async syncSales(t: TerminalPrincipal, envelopes: ReceivedEnvelope[], receivedAt = performance.now()): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const stopAt = receivedAt + this.env.SYNC_BATCH_BUDGET_MS;
    for (const env of [...envelopes].sort((a, b) => a.deviceSeq - b.deviceSeq)) {
      if (results.length > 0 && performance.now() >= stopAt) break;
      const r = await this.deliver(t, env);
      this.metrics.offlineSales.inc({ outcome: r.replayed ? 'replayed' : r.status.toLowerCase() });
      results.push(r);
    }
    return results;
  }

  private async deliver(t: TerminalPrincipal, received: ReceivedEnvelope): Promise<SyncResult> {
    const env = readEnvelope(received);
    if (env instanceof AppError) {
      // Not a sale this server can read (an older or faulty till): kept as received for a manager, so it
      // never blocks the envelopes behind it. Sent again unchanged, it gets the same answer.
      const rawHash = sha256(canonicalJson(received));
      const known = await this.delivery(t, received.terminalTxnId);
      return known ? this.replay(known, received, rawHash) : this.quarantine(t, received, rawHash, env);
    }
    const payloadHash = sha256(canonicalJson(env));
    const known = await this.delivery(t, env.terminalTxnId);
    if (known) return this.replay(known, env, payloadHash);

    const snapshot = await withTenant(this.database.pool, t.tenantId, (db) => this.snapshotFor(db, t, env.snapshotId));
    if (snapshot?.recoveredFrom) {
      // Delivered by the old credential before it was revoked: answer what was recorded then.
      const earlier = await this.delivery({ ...t, terminalId: snapshot.recoveredFrom }, env.terminalTxnId);
      if (earlier) return this.replay(earlier, env, payloadHash);
    }
    try {
      if (!snapshot) throw new AppError('UNKNOWN_SNAPSHOT', 'This terminal was never given that snapshot', HttpStatus.UNPROCESSABLE_ENTITY);
      const cashier = await this.cashierAuth(t, env.cashierUserId);
      const r = await this.sales.recordOffline(cashier, env, {
        ...this.offlineContext(t, snapshot, env, payloadHash),
        ...(snapshot.recoveredFrom && { recoveredFrom: snapshot.recoveredFrom }),
      });
      return { terminalTxnId: env.terminalTxnId, deviceSeq: env.deviceSeq, status: 'RECORDED', ...r, replayed: false };
    } catch (e) {
      if (!(e instanceof AppError) || e.getStatus() >= 500) throw e; // transient: the terminal retries with the same envelope
      if (e.code === 'DUPLICATE_TRANSACTION') {
        // Delivered concurrently (two sync loops, or a retry racing the first attempt): answer what was recorded.
        const now = await this.delivery(t, env.terminalTxnId);
        if (now) return this.replay(now, env, payloadHash);
      }
      return this.quarantine(t, env, payloadHash, e);
    }
  }

  /**
   * The snapshot a sale was priced from, if the delivering terminal may use it: its own, or (recovery,
   * session 16) one of a revoked terminal on the same register, since a till revoked and set up again
   * still holds sales rung up under its old credential. Nobody else's is accepted.
   */
  private async snapshotFor(db: Database, t: Pick<TerminalPrincipal, 'terminalId' | 'registerId'>, snapshotId: string) {
    const [own] = await db.select({ asOf: terminalSnapshots.asOf, writable: terminalSnapshots.businessWritable }).from(terminalSnapshots)
      .where(and(eq(terminalSnapshots.id, snapshotId), eq(terminalSnapshots.terminalId, t.terminalId)));
    if (own) return { asOf: own.asOf, writable: own.writable, recoveredFrom: null };
    const [old] = await db
      .select({ asOf: terminalSnapshots.asOf, writable: terminalSnapshots.businessWritable, terminalId: terminalSnapshots.terminalId })
      .from(terminalSnapshots)
      .innerJoin(terminals, eq(terminals.id, terminalSnapshots.terminalId))
      .where(and(eq(terminalSnapshots.id, snapshotId), eq(terminals.registerId, t.registerId), eq(terminals.status, 'REVOKED')));
    return old ? { asOf: old.asOf, writable: old.writable, recoveredFrom: old.terminalId } : undefined;
  }

  private offlineContext(t: TerminalPrincipal, snap: { asOf: Date; writable: boolean }, env: OfflineSale, payloadHash: string, quarantinedId?: string): OfflineContext {
    return { terminalId: t.terminalId, registerId: t.registerId, snapshotAsOf: snap.asOf, snapshotWritable: snap.writable, windowHours: this.env.OFFLINE_WINDOW_HOURS, payload: env, payloadHash, ...(quarantinedId && { quarantinedId }) };
  }

  /** The shift's cashier, as an active member with their grants now; the sale is recorded as them. */
  private async cashierAuth(t: Pick<TerminalPrincipal, 'tenantId' | 'terminalId' | 'correlationId'>, userId: string): Promise<AuthContext> {
    const { rows } = await this.database.pool.query<{ user_active: boolean; membership_id: string | null; tenant_status: string | null }>(
      'SELECT * FROM auth_resolve_context($1, NULL, $2)',
      [userId, t.tenantId],
    );
    const ctx = rows[0];
    if (!ctx?.user_active || !ctx.membership_id || !ctx.tenant_status || !['ACTIVE', 'SUSPENDED'].includes(ctx.tenant_status)) {
      throw new AppError('CASHIER_NOT_AUTHORIZED', 'The cashier of this sale is no longer an active member of the business', HttpStatus.FORBIDDEN);
    }
    const grants = await loadGrants(this.database.pool, t.tenantId, ctx.membership_id, userId);
    // No user session here: the terminal's credential authenticated the delivery (MFA is a sign-in control).
    const mfa = { enrolled: false, sessionVerified: false, required: false, dueAt: null };
    return { userId, sessionId: `terminal:${t.terminalId}`, correlationId: t.correlationId, tenant: { tenantId: t.tenantId, membershipId: ctx.membership_id, status: ctx.tenant_status, grants }, mfa };
  }

  private async delivery(t: TerminalPrincipal, terminalTxnId: string): Promise<Delivery | undefined> {
    return withTenant(this.database.pool, t.tenantId, async (db) =>
      (await db.select().from(terminalTransactions).where(and(eq(terminalTransactions.terminalId, t.terminalId), eq(terminalTransactions.terminalTxnId, terminalTxnId))))[0]);
  }

  private async replay(d: Delivery, env: EnvelopeHead, payloadHash: string): Promise<SyncResult> {
    const base = { terminalTxnId: env.terminalTxnId, deviceSeq: env.deviceSeq };
    if (d.payloadHash !== payloadHash) {
      return { ...base, status: 'REJECTED', code: 'TXN_ID_REUSED', message: 'This transaction id was already delivered with different content', replayed: false };
    }
    if (d.status === 'RECORDED') {
      const sale = await withTenant(this.database.pool, d.tenantId, async (db) => {
        const { rows } = await db.execute<{ sale_number: string; code: string; offline_flags: OfflineFlag[] }>(sql`
          SELECT s.sale_number, r.code, s.offline_flags FROM sales s JOIN registers r ON r.id = s.register_id WHERE s.id = ${d.saleId}`);
        return rows[0]!;
      });
      const saleNumber = Number(sale.sale_number);
      return { ...base, status: 'RECORDED', saleId: d.saleId!, saleNumber, reference: `${sale.code}-${String(saleNumber).padStart(6, '0')}`, flags: sale.offline_flags, replayed: true };
    }
    if (d.status === 'DISMISSED') return { ...base, status: 'DISMISSED', replayed: true };
    return { ...base, status: 'QUARANTINED', code: d.errorCode!, message: String((d.errorDetail as { message?: string } | null)?.message ?? d.errorCode), replayed: true };
  }

  /** Nothing was recorded: keep the envelope for a manager, outside any business write check. */
  /** `env` may be unreadable (VALIDATION_FAILED): only its head is trusted; it is stored as received. */
  private async quarantine(t: TerminalPrincipal, env: ReceivedEnvelope, payloadHash: string, e: AppError): Promise<SyncResult> {
    const sessionId = payloadField(env, 'cashierSessionId');
    const sessionKnown = sessionId !== null && UUID.test(sessionId) && await withTenant(this.database.pool, t.tenantId, async (db) =>
      (await db.select({ id: cashierSessions.id }).from(cashierSessions).where(eq(cashierSessions.id, sessionId))).length > 0);
    await withTenant(this.database.pool, t.tenantId, (db) =>
      db.insert(terminalTransactions).values({
        tenantId: t.tenantId, terminalId: t.terminalId, terminalTxnId: env.terminalTxnId, deviceSeq: env.deviceSeq, payload: env, payloadHash,
        cashierSessionId: sessionKnown ? sessionId : null, status: 'QUARANTINED', errorCode: e.code,
        errorDetail: { message: e.message, ...(e.details && { details: e.details }) },
      }).onConflictDoNothing());
    // A concurrent delivery may have got there first: answer whatever is stored now.
    const stored = await this.delivery(t, env.terminalTxnId);
    if (stored && (stored.payloadHash !== payloadHash || stored.status !== 'QUARANTINED' || stored.errorCode !== e.code)) return this.replay(stored, env, payloadHash);
    return { terminalTxnId: env.terminalTxnId, deviceSeq: env.deviceSeq, status: 'QUARANTINED', code: e.code, message: e.message, replayed: false };
  }

  // ---------------------------------------------------------------- manager side
  /**
   * Till health (SPEC §11, monitoring for delayed or failed sync): every active terminal the caller may
   * reconcile, when it was last heard from (snapshot or delivery), what waits for review, and whether it is
   * **silent**: its register has an open shift and the till has not been in touch for
   * `TILL_SILENCE_MINUTES` since the later of its last contact and the shift's opening. An online till
   * refreshes its snapshot every few minutes, so a silent one is offline (or off) with sales possibly on board.
   */
  terminalHealth(auth: AuthContext) {
    return this.read(auth, async (db) => {
      const { rows } = await db.execute<{
        id: string; name: string; register_id: string; register_code: string; branch_name: string; last_snapshot_at: string | null;
        last_delivery_at: string | null; quarantined: number; shift_opened_at: string | null; now: string;
      }>(sql`
        SELECT t.id, t.name, t.register_id, r.code AS register_code, b.name AS branch_name,
               (SELECT max(s.as_of) FROM terminal_snapshots s WHERE s.terminal_id = t.id) AS last_snapshot_at,
               (SELECT max(x.received_at) FROM terminal_transactions x WHERE x.terminal_id = t.id) AS last_delivery_at,
               (SELECT count(*)::int FROM terminal_transactions x WHERE x.terminal_id = t.id AND x.status = 'QUARANTINED') AS quarantined,
               (SELECT c.opened_at FROM cashier_sessions c WHERE c.register_id = t.register_id AND c.status = 'OPEN') AS shift_opened_at,
               now() AS now
          FROM terminals t
          JOIN registers r ON r.id = t.register_id
          JOIN branches b ON b.id = r.branch_id
         WHERE t.revoked_at IS NULL
         ORDER BY b.name, r.code, t.name`);
      const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());
      const out = [];
      for (const r of rows) {
        if (!this.can(auth, 'cash.reconcile', (await registerScope(db, r.register_id)).scope)) continue;
        const contact = [r.last_snapshot_at, r.last_delivery_at].filter((v): v is string => v !== null).map((v) => Date.parse(v));
        const lastContactAt = contact.length ? Math.max(...contact) : null;
        const since = r.shift_opened_at === null ? null : Math.max(Date.parse(r.shift_opened_at), lastContactAt ?? 0);
        out.push({
          terminalId: r.id, name: r.name, register: { id: r.register_id, code: r.register_code }, branchName: r.branch_name,
          lastContactAt: lastContactAt === null ? null : new Date(lastContactAt).toISOString(),
          lastSnapshotAt: iso(r.last_snapshot_at), lastDeliveryAt: iso(r.last_delivery_at),
          quarantined: Number(r.quarantined), shiftOpenedAt: iso(r.shift_opened_at),
          silent: since !== null && Date.parse(r.now) - since > TILL_SILENCE_MINUTES * 60_000,
        });
      }
      return { data: out, silenceMinutes: TILL_SILENCE_MINUTES };
    });
  }

  /** Offline deliveries the caller may reconcile (`cash.reconcile` at the terminal's register). */
  list(auth: AuthContext, q: OfflineListQuery) {
    return this.read(auth, async (db) => {
      const rows = await this.rows(db)
        .where(and(q.status ? eq(terminalTransactions.status, q.status) : undefined, q.terminalId ? eq(terminalTransactions.terminalId, q.terminalId) : undefined))
        .orderBy(q.status === 'QUARANTINED' ? asc(terminalTransactions.receivedAt) : desc(terminalTransactions.receivedAt))
        .limit(200);
      const out = [];
      for (const r of rows) {
        const { scope } = await registerScope(db, r.registerId);
        if (this.can(auth, 'cash.reconcile', scope)) out.push(this.view(r));
      }
      return { data: out };
    });
  }

  /** Try a quarantined sale again (once its cause is fixed), recorded as its cashier. */
  async retry(auth: AuthContext, id: string) {
    const d = await this.reviewable(auth, id);
    try {
      // Unreadable as delivered: no retry can change that (only dismissing resolves it).
      const env = readEnvelope(d.payload);
      if (env instanceof AppError) throw env;
      // The same rule as a delivery: the terminal's own snapshot, or a revoked one's on its register.
      const { t, snap } = await this.read(auth, async (db) => {
        const [term] = await db.select({ registerId: terminals.registerId }).from(terminals).where(eq(terminals.id, d.terminalId));
        const t = { terminalId: d.terminalId, tenantId: d.tenantId, registerId: term!.registerId, correlationId: auth.correlationId };
        return { t, snap: await this.snapshotFor(db, t, env.snapshotId) };
      });
      if (!snap) throw new AppError('UNKNOWN_SNAPSHOT', 'This terminal was never given that snapshot', HttpStatus.UNPROCESSABLE_ENTITY);
      const cashier = await this.cashierAuth(t, env.cashierUserId);
      const r = await this.sales.recordOffline(cashier, env, {
        ...this.offlineContext(t, snap, env, d.payloadHash, d.id),
        ...(snap.recoveredFrom && { recoveredFrom: snap.recoveredFrom }),
      });
      await this.mutate(auth, (db) => this.audit(db, auth, 'offline_sale.retried', 'terminal_transaction', id, { saleId: r.saleId }), { allowReadOnlyBusiness: true });
      return this.get(auth, id);
    } catch (e) {
      if (!(e instanceof AppError) || e.getStatus() >= 500) throw e;
      if (e.code === 'DUPLICATE_TRANSACTION') {
        // Another retry of this sale (a second tab, a double click) recorded it first: answer as recorded.
        const now = await this.get(auth, id);
        if (now.status !== 'QUARANTINED') return now;
      }
      // Through mutate (audit 2026-10-27 #26): a lapsed business must still be able to review and close
      // its shifts, so read-only is allowed. Only a row still waiting for review takes the error: a
      // concurrent retry that recorded it must not be stamped with this one's failure.
      const stamped = await this.mutate(auth, async (db) => {
        const [row] = await db.update(terminalTransactions)
          .set({ errorCode: e.code, errorDetail: { message: e.message, ...(e.details && { details: e.details }) }, attempts: sql`${terminalTransactions.attempts} + 1` })
          .where(and(eq(terminalTransactions.id, id), eq(terminalTransactions.status, 'QUARANTINED')))
          .returning({ id: terminalTransactions.id });
        if (row) await this.audit(db, auth, 'offline_sale.retry_failed', 'terminal_transaction', id, { code: e.code });
        return !!row;
      }, { allowReadOnlyBusiness: true });
      if (!stamped) {
        const now = await this.get(auth, id);
        if (now.status === 'RECORDED') return now;
        throw new AppError('NOT_QUARANTINED', 'This offline sale is no longer waiting for review', HttpStatus.CONFLICT);
      }
      throw new AppError('STILL_QUARANTINED', `Still not recordable: ${e.message}`, HttpStatus.CONFLICT, { code: e.code });
    }
  }

  /** Give up on a quarantined sale with a reason; any cash it took shows as a drawer variance. */
  async dismiss(auth: AuthContext, id: string, input: DismissOfflineInput) {
    await this.reviewable(auth, id);
    // Through mutate (audit 2026-10-27 #26), read-only allowed: a lapsed business must still close its shifts.
    await this.mutate(auth, async (db) => {
      const [row] = await db.update(terminalTransactions)
        .set({ status: 'DISMISSED', resolvedAt: sql`now()`, resolvedBy: auth.userId, resolveReason: input.reason })
        .where(and(eq(terminalTransactions.id, id), eq(terminalTransactions.status, 'QUARANTINED')))
        .returning({ id: terminalTransactions.id });
      if (!row) throw new AppError('NOT_QUARANTINED', 'This offline sale is no longer waiting for review', HttpStatus.CONFLICT);
      await this.audit(db, auth, 'offline_sale.dismissed', 'terminal_transaction', id, { reason: input.reason });
    }, { allowReadOnlyBusiness: true });
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [r] = await this.rows(db).where(eq(terminalTransactions.id, id));
      if (!r) throw notFound('Offline sale');
      this.assertCan(auth, 'cash.reconcile', (await registerScope(db, r.registerId)).scope);
      return this.view(r);
    });
  }

  private async reviewable(auth: AuthContext, id: string) {
    if (tenantStatus(auth) === 'SUSPENDED') throw new AppError('TENANT_SUSPENDED', 'This business is suspended; records are read-only', HttpStatus.FORBIDDEN);
    const d = await this.read(auth, async (db) => {
      const [r] = await db.select({ d: terminalTransactions, registerId: terminals.registerId })
        .from(terminalTransactions).innerJoin(terminals, eq(terminals.id, terminalTransactions.terminalId)).where(eq(terminalTransactions.id, id));
      if (!r) throw notFound('Offline sale');
      this.assertCan(auth, 'cash.reconcile', (await registerScope(db, r.registerId)).scope);
      return r.d;
    });
    if (d.status !== 'QUARANTINED') throw new AppError('NOT_QUARANTINED', 'This offline sale is no longer waiting for review', HttpStatus.CONFLICT);
    return d;
  }

  /** A delivery with its terminal, register, the cashier it names and the sale it became. */
  private rows(db: Database) {
    return db
      .select({
        d: terminalTransactions, registerId: terminals.registerId, terminalName: terminals.name, registerCode: registers.code,
        cashierName: users.displayName, saleNumber: sales.saleNumber, flags: sales.offlineFlags, recordedAt: sales.completedAt,
        // Drew expired or held lots (ADR-0025 §4): read from the lot draws, the sale row does not change.
        expiredStock: sql<boolean>`EXISTS (SELECT 1 FROM stock_movements m JOIN stock_lot_movements lm ON lm.tenant_id = m.tenant_id AND lm.movement_id = m.id AND lm.expired
                                            WHERE m.sale_id = ${sales.id} AND m.type IN ('SALE', 'CONSUMPTION'))`,
      })
      .from(terminalTransactions)
      .innerJoin(terminals, eq(terminals.id, terminalTransactions.terminalId))
      .innerJoin(registers, eq(registers.id, terminals.registerId))
      // A payload quarantined as unreadable may hold anything there: cast only what is a uuid.
      .leftJoin(users, sql`${users.id} = CASE WHEN ${terminalTransactions.payload} ->> 'cashierUserId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                              THEN (${terminalTransactions.payload} ->> 'cashierUserId')::uuid END`)
      .leftJoin(sales, eq(sales.id, terminalTransactions.saleId))
      .$dynamic();
  }

  /**
   * `flags`: what the recorded sale was flagged with (PRICE_CHANGED, SNAPSHOT_EXPIRED, CLOCK_ADJUSTED, and
   * EXPIRED_STOCK when it drew expired or held lots); [] otherwise.
   * `recordedAt`: when the sale counts as having happened (the device time, clamped into the shift); `occurredAt` is
   * what the till's clock said.
   */
  private view(r: {
    d: Delivery; terminalName: string; registerCode: string; cashierName: string | null; saleNumber: number | null; flags: string[] | null; recordedAt: Date | null; expiredStock?: boolean | null;
  }) {
    const { d } = r;
    const field = (k: keyof OfflineSale) => payloadField(d.payload, k);
    return {
      id: d.id, terminalId: d.terminalId, terminalName: r.terminalName, registerCode: r.registerCode, cashierName: r.cashierName,
      saleNumber: r.saleNumber, flags: [...(r.flags ?? []), ...(r.expiredStock ? ['EXPIRED_STOCK'] : [])], recordedAt: r.recordedAt, terminalTxnId: d.terminalTxnId, deviceSeq: d.deviceSeq, status: d.status,
      cashierSessionId: d.cashierSessionId, saleId: d.saleId, errorCode: d.errorCode, errorDetail: d.errorDetail, attempts: d.attempts,
      receivedAt: d.receivedAt, resolvedAt: d.resolvedAt, resolvedBy: d.resolvedBy, resolveReason: d.resolveReason,
      localReference: field('localReference'), occurredAt: validInstant(field('occurredAt')), amountDue: field('amountDue'), cashierUserId: field('cashierUserId'),
    };
  }
}

const tenantStatus = (auth: AuthContext) => auth.tenant?.status;

function snapshotBranding(b: BrandingView): SnapshotBranding {
  const { header, footer, contact } = receiptBranding(b);
  return {
    displayName: b.displayName,
    brandColor: b.brandColor,
    logoSha256: b.logo?.sha256 ?? null,
    backgroundSha256: b.background?.sha256 ?? null,
    displayWelcome: b.displayWelcome,
    displayThanks: b.displayThanks,
    receipt: { header, footer, contact },
  };
}
