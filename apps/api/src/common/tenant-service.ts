import { HttpStatus } from '@nestjs/common';
import type { Database } from '@1pos/database';
import type { PermissionCode } from '@1pos/validation';
import { recordAudit } from '../audit/audit.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { hasPermission, type ResourceScope } from '../auth/authorization.js';
import { assertWritable } from '../billing/entitlements.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { claimIdempotency, completeIdempotency } from '../infrastructure/idempotency.js';
import type { TenantDb } from '../infrastructure/tenant-db.service.js';

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`, HttpStatus.NOT_FOUND);
export const archived = (what: string) => new AppError('ARCHIVED', `${what} is archived`, HttpStatus.CONFLICT);

interface PgErrorShape {
  code?: string;
  constraint?: string;
  message?: string;
}

export function pgError(e: unknown): PgErrorShape {
  const err = e as PgErrorShape & { cause?: PgErrorShape };
  return err.cause ?? err;
}

/** Unique-constraint name → [error code, message] for 409 responses. */
export type ConflictMap = Record<string, readonly [string, string]>;

/** Common plumbing for tenant-scoped domain services. */
export abstract class TenantService {
  protected abstract readonly conflicts: ConflictMap;

  protected constructor(protected readonly tenantDb: TenantDb) {}

  protected can(auth: AuthContext, perm: PermissionCode, scope: ResourceScope = {}): boolean {
    return hasPermission(tenantOf(auth).grants, perm, scope);
  }

  protected assertCan(auth: AuthContext, perm: PermissionCode, scope: ResourceScope = {}): void {
    if (!this.can(auth, perm, scope)) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: [perm] });
    }
  }

  /**
   * Business-wide reference data (the catalog: products, categories, units, tax categories, price
   * lists): a grant at any scope is enough to read it. A cashier given `catalog.read` at one branch
   * must still be able to scan the business's items (session 16 fix: they could not).
   */
  protected assertHolds(auth: AuthContext, perm: PermissionCode): void {
    if (!tenantOf(auth).grants.some((g) => g.permission === perm)) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: [perm] });
    }
  }

  protected read<T>(auth: AuthContext, fn: (db: Database) => Promise<T>): Promise<T> {
    return this.tenantDb.run(auth, fn);
  }

  /**
   * Write transaction: refuses suspended tenants and maps unique violations to 409s.
   * `allowReadOnlyBusiness` (with `@AllowReadOnlyBusiness()` on the route) lets a suspended or lapsed
   * business still take a copy of its records (ADR-0016 slice 6); nothing else may use it.
   */
  protected async mutate<T>(auth: AuthContext, fn: (db: Database) => Promise<T>, options: { allowReadOnlyBusiness?: boolean } = {}): Promise<T> {
    if (tenantOf(auth).status === 'SUSPENDED' && !options.allowReadOnlyBusiness) {
      throw new AppError('TENANT_SUSPENDED', 'This business is suspended; records are read-only', HttpStatus.FORBIDDEN);
    }
    try {
      return await this.tenantDb.run(auth, async (db) => {
        if (!options.allowReadOnlyBusiness) await assertWritable(db);
        const idem = await claimIdempotency(db);
        const result = await fn(db);
        if (idem) await completeIdempotency(db, idem, result);
        return result;
      });
    } catch (e) {
      const pg = pgError(e);
      // Unique and exclusion violations, and the named check constraints a service lists (e.g. a balance
      // trigger), are conflicts with what is already there: 409 with the service's own code.
      const conflict = (pg.code === '23505' || pg.code === '23P01' || pg.code === '23514') && pg.constraint ? this.conflicts[pg.constraint] : undefined;
      if (conflict) throw new AppError(conflict[0], conflict[1], HttpStatus.CONFLICT);
      // A posting that waited on a month being closed (ADR-0013): same answer as the up-front check.
      if (pg.constraint === 'journal_entries_period_closed') throw new AppError('PERIOD_CLOSED', 'The accounting period is closed', HttpStatus.CONFLICT);
      // The DB backstop for a shift closing with a charge in no sale (ADR-0010 §6; the service checks first).
      if (pg.constraint === 'payments_outstanding') {
        throw new AppError('PAYMENTS_OUTSTANDING', 'Card/QR payments on this shift are not settled; complete the sale or cancel them first', HttpStatus.CONFLICT);
      }
      if (pg.code === '23514' && pg.message) throw new AppError('INVALID_STATE', pg.message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw e;
    }
  }

  protected audit(
    db: Database,
    auth: AuthContext,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return recordAudit(db, {
      tenantId: tenantOf(auth).tenantId,
      actorUserId: auth.userId,
      action,
      resourceType,
      resourceId,
      correlationId: auth.correlationId ?? null,
      ...(metadata ? { metadata } : {}),
    });
  }
}
