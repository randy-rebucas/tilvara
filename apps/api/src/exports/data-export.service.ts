import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { dataExports, desc, eq, exportKey, sql, users, withTenant, type FileStorage } from '@1pos/database';
import { recordAudit } from '../audit/audit.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { ExportLinks } from './export-links.js';

export const FILE_STORAGE = Symbol('FILE_STORAGE');
export const EXPORT_LINKS = Symbol('EXPORT_LINKS');

/** At most this many exports a business may ask for in a day (each reads every record). */
const EXPORTS_PER_DAY = 5;

type ExportRow = typeof dataExports.$inferSelect;

/**
 * A business's copy of its records (ADR-0016 slice 6). The owner/admin asks (tenant.manage), the
 * worker makes the ZIP from one snapshot, and the file is fetched through a short-lived signed link.
 * Works for a suspended or lapsed business too: taking its records with it is part of leaving.
 */
@Injectable()
export class DataExportService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    data_exports_one_requested: ['EXPORT_IN_PROGRESS', 'An export is already being prepared'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(DatabasePool) private readonly database: DatabasePool,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(EXPORT_LINKS) private readonly links: ExportLinks,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {
    super(tenantDb);
  }

  list(auth: AuthContext) {
    this.assertCan(auth, 'tenant.manage');
    return this.read(auth, async (db) => {
      const rows = await db
        .select({ e: dataExports, requestedByName: users.displayName })
        .from(dataExports)
        .leftJoin(users, eq(users.id, dataExports.requestedBy))
        .orderBy(desc(dataExports.requestedAt))
        .limit(50);
      const now = await dbNow(db);
      return { data: rows.map(({ e, requestedByName }) => view(e, requestedByName, now)) };
    });
  }

  get(auth: AuthContext, id: string) {
    this.assertCan(auth, 'tenant.manage');
    return this.read(auth, async (db) => {
      const [row] = await db
        .select({ e: dataExports, requestedByName: users.displayName })
        .from(dataExports)
        .leftJoin(users, eq(users.id, dataExports.requestedBy))
        .where(eq(dataExports.id, id));
      if (!row) throw notFound('Export');
      return view(row.e, row.requestedByName, await dbNow(db));
    });
  }

  request(auth: AuthContext) {
    this.assertCan(auth, 'tenant.manage');
    if (auth.support) throw new AppError('SUPPORT_READ_ONLY', 'Support access is read-only', HttpStatus.FORBIDDEN);
    return this.mutate(
      auth,
      async (db) => {
        const { rows: [recent] } = await db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM data_exports WHERE requested_at > now() - interval '24 hours'`,
        );
        if (recent!.n >= EXPORTS_PER_DAY) {
          throw new AppError('EXPORT_LIMIT', `At most ${EXPORTS_PER_DAY} exports a day`, HttpStatus.TOO_MANY_REQUESTS, { limit: EXPORTS_PER_DAY });
        }
        const [row] = await db.insert(dataExports).values({ tenantId: tenantOf(auth).tenantId, requestedBy: auth.userId }).returning();
        await emitEvent(db, {
          tenantId: tenantOf(auth).tenantId,
          topic: 'data_export.requested',
          payload: { exportId: row!.id },
          correlationId: auth.correlationId,
        });
        await this.audit(db, auth, 'data_export.requested', 'data_export', row!.id);
        return view(row!, null, await dbNow(db));
      },
      { allowReadOnlyBusiness: true },
    );
  }

  /** A download link for a finished export, valid DATA_EXPORT_LINK_SECONDS (and never past the file's date). */
  link(auth: AuthContext, id: string) {
    this.assertCan(auth, 'tenant.manage');
    if (auth.support) throw new AppError('SUPPORT_READ_ONLY', 'Support access is read-only', HttpStatus.FORBIDDEN);
    // Not a business write (only the audit row), so a read-only business can download too.
    return this.tenantDb.run(auth, async (db) => {
      const [e] = await db.select().from(dataExports).where(eq(dataExports.id, id));
      if (!e) throw notFound('Export');
      const now = await dbNow(db);
      if (e.status !== 'READY' || !e.expiresAt) throw new AppError('EXPORT_NOT_READY', 'This export is not ready', HttpStatus.CONFLICT, { status: e.status });
      if (e.expiresAt.getTime() <= now.getTime()) throw new AppError('EXPORT_EXPIRED', 'This export has expired; ask for a new one', HttpStatus.GONE);
      const expiresAt = new Date(Math.min(now.getTime() + this.env.DATA_EXPORT_LINK_SECONDS * 1000, e.expiresAt.getTime()));
      const token = this.links.sign({ e: e.id, t: e.tenantId, u: auth.userId, x: Math.floor(expiresAt.getTime() / 1000) });
      await this.audit(db, auth, 'data_export.link_issued', 'data_export', e.id, { expiresAt: expiresAt.toISOString() });
      return { url: `/v1/data-export-files/${token}`, expiresAt };
    });
  }

  /**
   * The file behind a signed link. Any problem (forged, expired, another export, file gone) answers
   * 404, so a link tells nothing about what exists. The download is audited for the link's user.
   */
  async open(token: string): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number; filename: string; sha256: string }> {
    const claims = this.links.verify(token);
    if (!claims) throw notFound('Export');
    const found = await withTenant(
      this.database.pool,
      claims.t,
      async (db) => {
        const [e] = await db.select().from(dataExports).where(eq(dataExports.id, claims.e));
        if (!e || e.status !== 'READY' || e.fileKey !== exportKey(claims.t, e.id) || !e.expiresAt || e.expiresAt.getTime() <= (await dbNow(db)).getTime()) return null;
        const { rows: [t] } = await db.execute<{ slug: string; day: string }>(
          sql`SELECT slug, to_char(${e.completedAt} AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS day FROM tenants`,
        );
        await recordAudit(db, {
          tenantId: claims.t,
          actorUserId: claims.u,
          action: 'data_export.downloaded',
          resourceType: 'data_export',
          resourceId: e.id,
        });
        return { e, filename: `tilvara-export-${t!.slug}-${t!.day}.zip` };
      },
      { userId: claims.u },
    );
    if (!found) throw notFound('Export');
    const file = await this.storage.open(found.e.fileKey!);
    if (!file) throw notFound('Export');
    return { stream: file.stream, sizeBytes: file.sizeBytes, filename: found.filename, sha256: found.e.sha256! };
  }
}

async function dbNow(db: { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> }): Promise<Date> {
  const { rows } = await db.execute(sql`SELECT now()::text AS now`);
  return new Date((rows[0] as { now: string }).now);
}

function view(e: ExportRow, requestedByName: string | null, now: Date) {
  const expired = e.status === 'EXPIRED' || (e.status === 'READY' && e.expiresAt !== null && e.expiresAt.getTime() <= now.getTime());
  return {
    id: e.id,
    status: expired ? ('EXPIRED' as const) : e.status,
    requestedBy: { id: e.requestedBy, name: requestedByName },
    requestedAt: e.requestedAt,
    completedAt: e.completedAt,
    sizeBytes: e.sizeBytes,
    sha256: e.sha256,
    rowCounts: e.rowCounts,
    totalRows: e.rowCounts ? Object.values(e.rowCounts).reduce((a, b) => a + b, 0) : null,
    expiresAt: e.expiresAt,
    error: e.error,
  };
}
