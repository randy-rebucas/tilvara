import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { sql, type PlanFeature, type PlanLimits } from '@1pos/database';
import { toDec } from '@1pos/money';
import { shopAddress } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { hasPermission } from '../auth/authorization.js';
import { pgError, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { ApiMetrics } from '../infrastructure/metrics.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { subscriptionSummary, usageOf } from './entitlements.js';
import { BillingProvider, type BillingWebhookEvent } from './provider.js';

const LIMIT_KEYS: (keyof PlanLimits)[] = ['maxLegalEntities', 'maxBranches', 'maxRegisters', 'maxUsers'];

/** Errors the billing_* functions raise as `CODE: words` (migration 0129), and the answer each gets. */
const FUNCTION_ERRORS: Record<string, [HttpStatus, string]> = {
  PLAN_NOT_AVAILABLE: [HttpStatus.UNPROCESSABLE_ENTITY, 'That plan is not offered'],
  PLAN_NOT_PRICED: [HttpStatus.CONFLICT, 'That plan has no price yet; ask Tilvara support'],
  NOT_ACTIVE: [HttpStatus.CONFLICT, 'Only a paid subscription can be stopped or resumed'],
  BILL_NOT_OPEN: [HttpStatus.CONFLICT, 'This bill is no longer open'],
};

export interface BillRow {
  id: string;
  number: string;
  kind: string;
  planCode: string;
  planName: string;
  fromPlanCode: string | null;
  periodStart: string;
  periodEnd: string;
  amount: string;
  /** The VAT inside `amount` (prices include 12% VAT). */
  vatAmount: string;
  currency: string;
  status: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  voidReason: string | null;
  payments: { amount: string; method: string; reference: string; applied: boolean; receivedAt: string }[];
  /** The system-generated receipt for the payment that settled it. */
  receipt: { id: string; number: string } | null;
}

export interface Receipt {
  id: string;
  number: string;
  issuedAt: string;
  seller: { registeredName: string; tradeName: string | null; tin: string | null; address: string | null; vatRegistered: boolean; permitNote: string | null };
  buyer: { businessName: string; registeredName: string | null; tradeName: string | null; tin: string | null; address: string | null };
  description: string;
  amount: string;
  vatableAmount: string;
  vatAmount: string;
  currency: string;
  method: string;
  reference: string;
  billNumber: string;
}

/**
 * Subscription billing (ADR-0027). The owner reads bills, chooses a plan, stops or resumes, and opens a
 * payment page; every change to the subscription and its bills happens in the billing_* definer
 * functions, so a business can never give itself a plan it has not paid for. Paying and choosing a plan
 * work while the business is read-only (that is how it renews), not while Tilvara has suspended it.
 */
@Injectable()
export class BillingService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    billing_bills_one_open_period: ['BILL_OPEN', 'A bill for this period is already open'],
  };
  private readonly logger = new Logger('BillingService');

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(DatabasePool) private readonly database: DatabasePool,
    @Inject(BillingProvider) private readonly provider: BillingProvider,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(ApiMetrics) private readonly metrics: ApiMetrics,
  ) {
    super(tenantDb);
  }

  /** Reading needs the plan's own permission or the business's. */
  private assertRead(auth: AuthContext): void {
    const grants = tenantOf(auth).grants;
    if (!hasPermission(grants, 'subscription.manage') && !hasPermission(grants, 'tenant.manage')) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: ['subscription.manage'] });
    }
  }

  /** Paying and changing the plan: the owner's permission, a member's own session, a business Tilvara has not suspended. */
  private assertManage(auth: AuthContext): void {
    this.assertCan(auth, 'subscription.manage');
    if (!tenantOf(auth).membershipId) throw new AppError('FORBIDDEN', 'Only a member of the business can do this', HttpStatus.FORBIDDEN);
    if (tenantOf(auth).status === 'SUSPENDED') {
      throw new AppError('TENANT_SUSPENDED', 'This business is suspended; records are read-only', HttpStatus.FORBIDDEN);
    }
  }

  private mapFunctionError(e: unknown): never {
    const message = pgError(e).message ?? '';
    const code = /^([A-Z_]+):/.exec(message)?.[1];
    const known = code ? FUNCTION_ERRORS[code] : undefined;
    if (code && known) throw new AppError(code, known[1], known[0]);
    throw e;
  }

  async summary(auth: AuthContext) {
    this.assertRead(auth);
    const summary = await this.read(auth, async (db) => {
      const s = await subscriptionSummary(db);
      if (!s) return null;
      const { rows } = await db.execute<{ scheduled_plan_code: string | null; scheduled_plan_name: string | null; cancel_at_period_end: boolean; monthly_price: string; currency: string }>(
        sql`SELECT s.scheduled_plan_code, sp.name AS scheduled_plan_name, s.cancel_at_period_end, p.monthly_price, p.currency
              FROM subscriptions s JOIN plans p ON p.code = s.plan_code LEFT JOIN plans sp ON sp.code = s.scheduled_plan_code`,
      );
      const x = rows[0]!;
      // The bill to pay next, for the reminder above every page (an upgrade is the owner's own, just asked for).
      const { rows: [open] } = await db.execute<{ id: string; number: string; amount: string; currency: string; due_at: string }>(
        sql`SELECT id, number, amount, currency, due_at FROM billing_bills WHERE status = 'OPEN' AND kind <> 'UPGRADE' ORDER BY due_at LIMIT 1`,
      );
      return {
        ...s,
        plan: { ...s.plan, monthlyPrice: x.monthly_price, currency: x.currency },
        scheduledPlan: x.scheduled_plan_code ? { code: x.scheduled_plan_code, name: x.scheduled_plan_name } : null,
        cancelAtPeriodEnd: x.cancel_at_period_end,
        openBill: open ? { id: open.id, number: open.number, amount: open.amount, currency: open.currency, dueAt: open.due_at } : null,
      };
    });
    if (!summary) throw new AppError('NOT_FOUND', 'No subscription found', HttpStatus.NOT_FOUND);
    return summary;
  }

  /** The plans on offer, with what the business has now against each one's limits. */
  async plans(auth: AuthContext) {
    this.assertRead(auth);
    return this.read(auth, async (db) => {
      const { rows } = await db.execute<{ code: string; name: string; monthly_price: string; currency: string; limits: PlanLimits; features: PlanFeature[]; extensions: string[]; current: boolean }>(
        sql`SELECT p.code, p.name, p.monthly_price, p.currency, p.limits, p.features, p.extensions,
                   p.code = (SELECT plan_code FROM subscriptions) AS current
              FROM plans p WHERE p.active ORDER BY p.monthly_price, p.code`,
      );
      const usage: Partial<Record<keyof PlanLimits, number>> = {};
      for (const k of LIMIT_KEYS) usage[k] = await usageOf(db, k);
      return rows.map((p) => ({
        code: p.code,
        name: p.name,
        monthlyPrice: p.monthly_price,
        currency: p.currency,
        limits: p.limits,
        features: p.features,
        extensions: p.extensions,
        current: p.current,
        priced: toDec(p.monthly_price).gt(0),
        overLimits: LIMIT_KEYS.filter((k) => (usage[k] ?? 0) > p.limits[k]),
      }));
    });
  }

  async bills(auth: AuthContext): Promise<BillRow[]> {
    this.assertRead(auth);
    return this.read(auth, async (db) => {
      const { rows } = await db.execute<{
        id: string; number: string; kind: string; plan_code: string; plan_name: string; from_plan_code: string | null; period_start: string; period_end: string;
        amount: string; vat_amount: string; currency: string; status: string; issued_at: string; due_at: string; paid_at: string | null; void_reason: string | null;
        payments: BillRow['payments'] | null;
        receipt: BillRow['receipt'];
      }>(sql`SELECT b.id, b.number, b.kind, b.plan_code, p.name AS plan_name, b.from_plan_code, b.period_start, b.period_end, b.amount, b.vat_amount, b.currency,
                    b.status, b.issued_at, b.due_at, b.paid_at, b.void_reason,
                    (SELECT jsonb_agg(jsonb_build_object('amount', y.amount::text, 'method', y.method, 'reference', y.reference, 'applied', y.applied, 'receivedAt', y.received_at)
                                      ORDER BY y.received_at)
                       FROM billing_payments y WHERE y.bill_id = b.id) AS payments,
                    (SELECT jsonb_build_object('id', r.id, 'number', r.number) FROM billing_receipts r WHERE r.bill_id = b.id ORDER BY r.issued_at LIMIT 1) AS receipt
               FROM billing_bills b JOIN plans p ON p.code = b.plan_code
              ORDER BY b.issued_at DESC LIMIT 36`);
      return rows.map((b) => ({
        id: b.id,
        number: b.number,
        kind: b.kind,
        planCode: b.plan_code,
        planName: b.plan_name,
        fromPlanCode: b.from_plan_code,
        periodStart: b.period_start,
        periodEnd: b.period_end,
        amount: b.amount,
        vatAmount: b.vat_amount,
        currency: b.currency,
        status: b.status,
        issuedAt: b.issued_at,
        dueAt: b.due_at,
        paidAt: b.paid_at,
        // Ops' own words stay with ops; the business sees why in general terms.
        voidReason: b.void_reason ? (b.void_reason.startsWith('ops:') ? 'voided by Tilvara support' : b.void_reason) : null,
        payments: b.payments ?? [],
        receipt: b.receipt ?? null,
      }));
    });
  }

  /** One receipt, as issued (seller and buyer as they were that day). */
  async receipt(auth: AuthContext, id: string): Promise<Receipt> {
    this.assertRead(auth);
    const r = await this.read(auth, async (db) => {
      const { rows: [x] } = await db.execute<{
        id: string; number: string; issued_at: string; seller: Receipt['seller']; buyer: Receipt['buyer']; description: string; amount: string;
        vatable_amount: string; vat_amount: string; currency: string; method: string; reference: string; bill_number: string;
      }>(sql`SELECT r.id, r.number, r.issued_at, r.seller, r.buyer, r.description, r.amount, r.vatable_amount, r.vat_amount, r.currency, r.method,
                    r.reference, b.number AS bill_number
               FROM billing_receipts r JOIN billing_bills b ON b.tenant_id = r.tenant_id AND b.id = r.bill_id WHERE r.id = ${id}`);
      return x ?? null;
    });
    if (!r) throw new AppError('NOT_FOUND', 'Receipt not found', HttpStatus.NOT_FOUND);
    return {
      id: r.id, number: r.number, issuedAt: r.issued_at, seller: r.seller, buyer: r.buyer, description: r.description, amount: r.amount,
      vatableAmount: r.vatable_amount, vatAmount: r.vat_amount, currency: r.currency, method: r.method, reference: r.reference, billNumber: r.bill_number,
    };
  }

  async choosePlan(auth: AuthContext, planCode: string): Promise<{ effect: 'NOW' | 'BILL' | 'AT_RENEWAL' | 'UNCHANGED'; billId?: string; at?: string }> {
    this.assertManage(auth);
    try {
      return await this.mutate(
        auth,
        async (db) => {
          const { rows: [plan] } = await db.execute<{ limits: PlanLimits }>(sql`SELECT limits FROM plans WHERE code = ${planCode} AND active`);
          if (plan) {
            for (const limit of LIMIT_KEYS) {
              const used = await usageOf(db, limit);
              if (used > plan.limits[limit]) {
                throw new AppError('PLAN_LIMITS_EXCEEDED', 'The business has more than that plan allows; archive some first', HttpStatus.CONFLICT, {
                  limit,
                  max: plan.limits[limit],
                  used,
                });
              }
            }
          }
          const { rows } = await db.execute<{ r: { effect: 'NOW' | 'BILL' | 'AT_RENEWAL' | 'UNCHANGED'; billId?: string; at?: string } }>(
            sql`SELECT billing_choose_plan(${planCode}) AS r`,
          );
          const result = rows[0]!.r;
          await this.audit(db, auth, 'subscription.plan_chosen', 'subscription', planCode, { plan: planCode, effect: result.effect });
          return result;
        },
        { allowReadOnlyBusiness: true },
      );
    } catch (e) {
      this.mapFunctionError(e);
    }
  }

  async setCancel(auth: AuthContext, cancel: boolean): Promise<{ cancelAtPeriodEnd: boolean }> {
    this.assertManage(auth);
    try {
      await this.mutate(auth, (db) => db.execute(sql`SELECT billing_set_cancel(${cancel})`), { allowReadOnlyBusiness: true });
    } catch (e) {
      this.mapFunctionError(e);
    }
    return { cancelAtPeriodEnd: cancel };
  }

  /**
   * A payment page for one open bill. A page opened in the last 23 hours is reused, so a double click
   * opens one page; the provider is called between two transactions, never inside one.
   */
  async checkout(auth: AuthContext, billId: string): Promise<{ url: string; provider: string }> {
    this.assertManage(auth);
    const bill = await this.read(auth, async (db) => {
      const { rows: [b] } = await db.execute<{ id: string; number: string; amount: string; currency: string; status: string; plan_name: string; kind: string }>(
        sql`SELECT b.id, b.number, b.amount, b.currency, b.status, p.name AS plan_name, b.kind FROM billing_bills b JOIN plans p ON p.code = b.plan_code WHERE b.id = ${billId}`,
      );
      if (!b) return null;
      const { rows: [open] } = await db.execute<{ checkout_url: string }>(
        sql`SELECT checkout_url FROM billing_checkouts WHERE bill_id = ${billId} AND provider = ${this.provider.code} AND status = 'OPEN' AND expires_at > now()
             ORDER BY created_at DESC LIMIT 1`,
      );
      // Back to the business's own address when it has one (its sign-in page is on), else the main admin.
      const { rows: [shop] } = await db.execute<{ slug: string; public_sign_in: boolean | null }>(
        sql`SELECT t.slug, br.public_sign_in FROM tenants t LEFT JOIN tenant_branding br ON br.tenant_id = t.id`,
      );
      return { ...b, reuse: open?.checkout_url ?? null, shop };
    });
    if (!bill) throw new AppError('NOT_FOUND', 'Bill not found', HttpStatus.NOT_FOUND);
    if (bill.status !== 'OPEN') throw new AppError('BILL_NOT_OPEN', FUNCTION_ERRORS.BILL_NOT_OPEN![1], HttpStatus.CONFLICT);
    if (bill.reuse) return { url: bill.reuse, provider: this.provider.code };

    const base =
      (bill.shop?.public_sign_in && shopAddress(bill.shop.slug, this.env.SHOP_DOMAIN, this.env.APP_PUBLIC_URL)) || this.env.APP_PUBLIC_URL.replace(/\/$/, '');
    const description = `Tilvara ${bill.plan_name} plan, bill ${bill.number}`;
    let opened;
    try {
      opened = await this.provider.openCheckout(
        { billId: bill.id, number: bill.number, description, amount: bill.amount, currency: bill.currency, successUrl: `${base}/subscription?paid=${bill.number}`, cancelUrl: `${base}/subscription` },
        AbortSignal.timeout(this.env.PAYMENT_TIMEOUT_MS),
      );
    } catch (e) {
      this.metrics.billing.inc({ provider: this.provider.code, step: 'checkout', outcome: 'failed' });
      this.logger.warn({ msg: 'billing checkout failed', billId: bill.id, error: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
      throw new AppError('BILLING_PROVIDER_UNAVAILABLE', 'The payment page could not be opened; try again in a moment', HttpStatus.SERVICE_UNAVAILABLE);
    }
    try {
      await this.mutate(
        auth,
        (db) =>
          db.execute(sql`SELECT billing_record_checkout(${bill.id}, ${opened.provider}, ${opened.checkoutId}, ${opened.url}, ${bill.amount},
                                                        ${opened.expiresAt.toISOString()}, ${tenantOf(auth).membershipId})`),
        { allowReadOnlyBusiness: true },
      );
    } catch (e) {
      this.mapFunctionError(e);
    }
    this.metrics.billing.inc({ provider: this.provider.code, step: 'checkout', outcome: 'opened' });
    return { url: opened.url, provider: opened.provider };
  }

  /** Whether a dev-simulator page may still be paid: its checkout is open (closed when its bill was voided or paid, audit 45 #3). */
  async devCheckoutOpen(checkoutId: string): Promise<boolean> {
    const { rows } = await this.database.pool.query<{ open: boolean }>('SELECT billing_dev_checkout_open($1) AS open', [checkoutId]);
    return rows[0]?.open === true;
  }

  /** A provider event whose signature was checked. Applied once; anything else is answered and kept. */
  async applyEvent(provider: 'PAYMONGO' | 'DEV', event: BillingWebhookEvent): Promise<string> {
    let outcome: string;
    if (event.type !== 'checkout_session.payment.paid' || !event.checkoutId) {
      outcome = 'IGNORED';
    } else {
      const { rows } = await this.database.pool.query<{ outcome: string }>(
        'SELECT billing_apply_provider_payment($1, $2, $3, $4, $5, $6, $7, $8) AS outcome',
        [provider, event.eventId, event.type, event.checkoutId, event.paid?.reference ?? null, event.paid?.amount ?? null, event.paid?.currency ?? null, event.paid?.method ?? null],
      );
      outcome = rows[0]!.outcome;
    }
    this.metrics.billing.inc({ provider, step: 'webhook', outcome: outcome.toLowerCase() });
    if (outcome !== 'APPLIED' && outcome !== 'IGNORED' && outcome !== 'DUPLICATE') {
      // Money may have been taken without settling a bill: ops looks (runbook billing.md).
      this.logger.warn({ msg: 'billing event not applied', provider, eventId: event.eventId, outcome });
    }
    return outcome;
  }
}
