import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  branches,
  eq,
  heldCarts,
  priceOverrides,
  products,
  productVariants,
  users,
  sql,
  type Database,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type { CreateHeldCartInput, CreatePriceOverrideInput, HeldCartListQuery } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { loadGrants } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { hasPermission } from '../auth/authorization.js';
import { PricingService } from '../catalog/pricing.service.js';
import { dbNow, effectiveNow } from '../common/clock.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { unprocessable } from '../tax/tax.service.js';
import { loadSession, registerScope } from './cash.service.js';

/** How long an approved price waits for its sale (the cashier rings it up now, or asks again). */
export const PRICE_OVERRIDE_TTL_MINUTES = 30;

const money = (v: string | null) => (v === null ? null : toDec(v).toFixed(2));

/**
 * Counter controls (session 20): manager-approved price changes and carts parked at a register.
 * Checkout itself stays in `SalesService`; an approval is only used there, once, by the cashier who asked.
 */
@Injectable()
export class CounterService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(DatabasePool) private readonly database: DatabasePool,
  ) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- price overrides

  /**
   * Approve a price for one item at a branch. Without credentials the person asking must hold
   * `sales.price_override` there (SELF). With them, the approver signs in on the spot: their password
   * (and code) are checked like a sign-in, outside the business transaction, then their own grants in
   * this business must include `sales.price_override` at the branch. Refusals are audited too.
   */
  async createPriceOverride(auth: AuthContext, input: CreatePriceOverrideInput) {
    const scope = await this.read(auth, async (db) => {
      const [branch] = await db.select().from(branches).where(eq(branches.id, input.branchId));
      if (!branch) throw notFound('Branch');
      return { branchId: branch.id, legalEntityId: branch.legalEntityId };
    });
    this.assertCan(auth, 'sales.create', scope);

    let approver: { userId: string; method: 'SELF' | 'CREDENTIALS' };
    if (input.email === undefined) {
      if (!this.can(auth, 'sales.price_override', scope)) {
        throw new AppError('APPROVAL_REQUIRED', 'A manager must approve this price', HttpStatus.FORBIDDEN, { missing: ['sales.price_override'] });
      }
      approver = { userId: auth.userId, method: 'SELF' };
    } else {
      let userId: string;
      try {
        userId = await this.authService.verifySecondPerson(input.email, input.password!, input.code, tenantOf(auth).tenantId);
      } catch (e) {
        if (e instanceof AppError) await this.refused(auth, input, e.code);
        throw e;
      }
      const tenantId = tenantOf(auth).tenantId;
      const membershipId = await this.authService.memberOf(tenantId, userId);
      const grants = membershipId ? await loadGrants(this.database.pool, tenantId, membershipId, userId) : [];
      if (!hasPermission(grants, 'sales.price_override', scope)) {
        await this.refused(auth, input, 'APPROVER_NOT_ALLOWED', userId);
        throw new AppError('APPROVER_NOT_ALLOWED', 'This person cannot approve price changes at this branch', HttpStatus.FORBIDDEN);
      }
      approver = { userId, method: userId === auth.userId ? 'SELF' : 'CREDENTIALS' };
    }

    return this.mutate(auth, async (db) => {
      const [item] = await db
        .select({ variantArchivedAt: productVariants.archivedAt, productArchivedAt: products.archivedAt })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(productVariants.id, input.variantId));
      if (!item) throw notFound('Item');
      if (item.variantArchivedAt || item.productArchivedAt) throw archived('Item');
      const price = (await this.pricing.effectivePrices(db, input.branchId, [input.variantId], await effectiveNow(db))).get(input.variantId);
      const now = await dbNow(db);
      if (!price) throw new AppError('ITEM_NOT_PRICED', 'This item has no price at this branch', HttpStatus.CONFLICT);
      if (toDec(price.amount).equals(input.unitPrice)) throw unprocessable('PRICE_UNCHANGED', 'This is already the price');

      const [row] = await db
        .insert(priceOverrides)
        .values({
          tenantId: tenantOf(auth).tenantId,
          branchId: input.branchId,
          variantId: input.variantId,
          priceId: price.priceId,
          listUnitPrice: price.amount,
          unitPrice: input.unitPrice,
          quantity: input.quantity,
          reason: input.reason,
          requestedBy: auth.userId,
          approvedBy: approver.userId,
          approvalMethod: approver.method,
          createdAt: now,
          expiresAt: new Date(now.getTime() + PRICE_OVERRIDE_TTL_MINUTES * 60_000),
        })
        .returning();
      await this.audit(db, auth, 'sale.price_override_approved', 'price_override', row!.id, {
        branchId: input.branchId, variantId: input.variantId, listUnitPrice: toDec(price.amount).toFixed(2), unitPrice: toDec(input.unitPrice).toFixed(2),
        quantity: toDec(input.quantity).toString(), reason: input.reason, approvedBy: approver.userId, method: approver.method,
      });
      return this.overrideView(db, row!);
    });
  }

  /** A refused approval in the business's log (who asked, for what, why it was refused; never the email typed). */
  private async refused(auth: AuthContext, input: CreatePriceOverrideInput, code: string, approverId?: string) {
    await this.tenantDb.run(auth, (db) =>
      this.audit(db, auth, 'sale.price_override_refused', 'branch', input.branchId, {
        variantId: input.variantId, unitPrice: toDec(input.unitPrice).toFixed(2), code, ...(approverId && { approverId }),
      }),
    );
  }

  private async overrideView(db: Database, o: typeof priceOverrides.$inferSelect) {
    const [approver] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, o.approvedBy));
    return {
      id: o.id, branchId: o.branchId, variantId: o.variantId, priceId: o.priceId,
      listUnitPrice: toDec(o.listUnitPrice).toString(), unitPrice: toDec(o.unitPrice).toString(),
      quantity: o.quantity === null ? null : toDec(o.quantity).toString(), reason: o.reason,
      requestedBy: o.requestedBy, approvedBy: o.approvedBy, approvedByName: approver?.displayName ?? null, approvalMethod: o.approvalMethod,
      createdAt: o.createdAt, expiresAt: o.expiresAt,
    };
  }

  // ---------------------------------------------------------------- held carts

  /** Open held carts of a register, oldest first (any cashier selling on it may resume them). */
  listHeldCarts(auth: AuthContext, q: HeldCartListQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await registerScope(db, q.registerId);
      this.assertCan(auth, 'sales.create', scope);
      const rows = await db
        .select({ cart: heldCarts, heldByName: users.displayName })
        .from(heldCarts)
        .leftJoin(users, eq(users.id, heldCarts.heldBy))
        .where(and(eq(heldCarts.registerId, q.registerId), eq(heldCarts.status, 'OPEN')))
        .orderBy(asc(heldCarts.createdAt), asc(heldCarts.id));
      return { data: rows.map((r) => this.cartSummary(r.cart, r.heldByName)) };
    });
  }

  /** Park the cart on the cashier's own open shift. Nothing is priced, numbered or taken from stock. */
  holdCart(auth: AuthContext, input: CreateHeldCartInput) {
    return this.mutate(auth, async (db) => {
      const { session, scope } = await loadSession(db, input.cashierSessionId);
      this.assertCan(auth, 'sales.create', scope);
      if (session.openedBy !== auth.userId) throw new AppError('NOT_SESSION_OWNER', 'Hold carts on your own shift', HttpStatus.FORBIDDEN);
      if (session.status !== 'OPEN') throw new AppError('SESSION_NOT_OPEN', 'This cashier session is not open', HttpStatus.CONFLICT);
      const used = new Set(input.lines.flatMap((l) => (l.statutory ? [l.statutory.beneficiary] : [])));
      const [cart] = await db
        .insert(heldCarts)
        .values({
          tenantId: tenantOf(auth).tenantId,
          branchId: session.branchId,
          registerId: session.registerId,
          cashierSessionId: session.id,
          heldBy: auth.userId,
          label: input.label,
          lines: input.lines,
          beneficiaries: input.beneficiaries.filter((b) => used.has(b.ref)),
          lineCount: input.lines.length,
          amountDue: input.amountDue ?? null,
        })
        .returning();
      await this.audit(db, auth, 'held_cart.held', 'held_cart', cart!.id, { registerId: session.registerId, lineCount: input.lines.length });
      return this.cartSummary(cart!, null);
    });
  }

  /**
   * Take a held cart back onto the cashier's own open shift on the same register. The row lock makes
   * a cart come back once even when two tills try; its lines (and SC/PWD details) leave the table.
   */
  resumeCart(auth: AuthContext, id: string, cashierSessionId: string) {
    return this.mutate(auth, async (db) => {
      const cart = await this.lockCart(db, auth, id);
      const { session } = await loadSession(db, cashierSessionId);
      if (session.openedBy !== auth.userId) throw new AppError('NOT_SESSION_OWNER', 'Resume carts on your own shift', HttpStatus.FORBIDDEN);
      if (session.status !== 'OPEN') throw new AppError('SESSION_NOT_OPEN', 'This cashier session is not open', HttpStatus.CONFLICT);
      if (session.registerId !== cart.registerId) throw unprocessable('WRONG_REGISTER', 'Resume a held cart at the register that holds it');
      await db.update(heldCarts).set({ status: 'RESUMED', closedBy: auth.userId, closedAt: sql`now()`, lines: [], beneficiaries: [] }).where(eq(heldCarts.id, id));
      await this.audit(db, auth, 'held_cart.resumed', 'held_cart', id, { cashierSessionId });
      return { id, label: cart.label, lines: cart.lines, beneficiaries: cart.beneficiaries };
    });
  }

  /** Drop a held cart (the customer left). */
  discardCart(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const cart = await this.lockCart(db, auth, id);
      await db.update(heldCarts).set({ status: 'DISCARDED', closedBy: auth.userId, closedAt: sql`now()`, lines: [], beneficiaries: [] }).where(eq(heldCarts.id, id));
      await this.audit(db, auth, 'held_cart.discarded', 'held_cart', id, { registerId: cart.registerId, lineCount: cart.lineCount });
      return { id, status: 'DISCARDED' as const };
    });
  }

  private async lockCart(db: Database, auth: AuthContext, id: string) {
    const [cart] = await db.select().from(heldCarts).where(eq(heldCarts.id, id)).for('update');
    if (!cart) throw notFound('Held cart');
    const { scope } = await registerScope(db, cart.registerId);
    this.assertCan(auth, 'sales.create', scope);
    if (cart.status !== 'OPEN') throw new AppError('HELD_CART_CLOSED', `This cart was already ${cart.status.toLowerCase()}`, HttpStatus.CONFLICT, { status: cart.status });
    return cart;
  }

  private cartSummary(c: typeof heldCarts.$inferSelect, heldByName: string | null) {
    const lines = c.lines as { name: string; quantity: string }[];
    return {
      id: c.id, registerId: c.registerId, label: c.label, heldBy: c.heldBy, heldByName, lineCount: c.lineCount,
      amountDue: money(c.amountDue), createdAt: c.createdAt, status: c.status,
      items: lines.slice(0, 5).map((l) => ({ name: l.name, quantity: l.quantity })),
    };
  }
}
