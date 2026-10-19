import { HttpStatus } from '@nestjs/common';
import { sql, type BusinessType, type Database, type PlanFeature, type PlanLimits } from '@1pos/database';
import { AppError } from '../infrastructure/http-error.filter.js';

export const TRIAL_PLAN = 'growth';
export const TRIAL_DAYS = 14;

/** What each limit counts. Archived/removed records do not count. */
const USAGE_SQL: Record<keyof PlanLimits, ReturnType<typeof sql>> = {
  maxLegalEntities: sql`SELECT count(*)::int AS n FROM legal_entities WHERE archived_at IS NULL`,
  maxBranches: sql`SELECT count(*)::int AS n FROM branches WHERE archived_at IS NULL`,
  maxRegisters: sql`SELECT count(*)::int AS n FROM registers WHERE archived_at IS NULL`,
  maxUsers: sql`SELECT (SELECT count(*) FROM tenant_memberships WHERE status IN ('ACTIVE','SUSPENDED'))
                     + (SELECT count(*) FROM member_invitations WHERE status = 'PENDING' AND expires_at > now()) AS n`,
};

/** Inside a tenant transaction: refuse writes when the subscription only allows read access. */
export async function assertWritable(db: Database): Promise<void> {
  const { rows } = await db.execute<{ ok: boolean }>(sql`SELECT app_subscription_write_allowed() AS ok`);
  if (!rows[0]?.ok) {
    throw new AppError(
      'SUBSCRIPTION_READ_ONLY',
      'Your subscription is inactive. Your records remain available read-only; renew to make changes.',
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

async function currentPlan(db: Database): Promise<{ planCode: string; limits: PlanLimits; features: PlanFeature[] }> {
  const { rows } = await db.execute<{ plan_code: string; limits: PlanLimits; features: PlanFeature[] }>(
    sql`SELECT s.plan_code, p.limits, p.features FROM subscriptions s JOIN plans p ON p.code = s.plan_code`,
  );
  const r = rows[0];
  if (!r) throw new AppError('SUBSCRIPTION_READ_ONLY', 'No subscription found for this business', HttpStatus.PAYMENT_REQUIRED);
  return { planCode: r.plan_code, limits: r.limits, features: r.features };
}

/**
 * Refuse creating one more `limit` resource when the plan's cap is reached. A per-tenant
 * transaction-scoped advisory lock serialises concurrent creations so two requests cannot
 * both slip under the cap.
 */
export async function assertWithinLimit(db: Database, limit: keyof PlanLimits, adding = 1): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(app_current_tenant_id()::text || ':' || ${limit}))`);
  const plan = await currentPlan(db);
  const { rows } = await db.execute<{ n: number }>(USAGE_SQL[limit]);
  const used = Number(rows[0]?.n ?? 0);
  const max = plan.limits[limit];
  if (used + adding > max) {
    throw new AppError('ENTITLEMENT_LIMIT_REACHED', `Your ${plan.planCode} plan allows ${max} for this resource`, HttpStatus.FORBIDDEN, {
      limit,
      max,
      used,
      plan: plan.planCode,
    });
  }
}

/** The business's type (`tenants.business_type`), inside its tenant transaction. */
export async function businessType(db: Database): Promise<BusinessType> {
  const { rows } = await db.execute<{ business_type: BusinessType }>(sql`SELECT business_type FROM tenants`);
  return rows[0]?.business_type ?? 'HYBRID';
}

/**
 * Refuse a feature the plan does not include, or (restaurant service) one the business type leaves
 * out. Reads stay open, as after a plan change, so the records made before remain visible.
 */
export async function assertFeature(db: Database, feature: PlanFeature): Promise<void> {
  if (feature === 'restaurant' && (await businessType(db)) === 'RETAIL') {
    throw new AppError(
      'BUSINESS_TYPE_EXCLUDES_FEATURE',
      'This business is set up as a retail shop. Change its type to use restaurant service.',
      HttpStatus.FORBIDDEN,
      { feature, businessType: 'RETAIL' },
    );
  }
  const plan = await currentPlan(db);
  if (!plan.features.includes(feature)) {
    throw new AppError('ENTITLEMENT_REQUIRED', `Your ${plan.planCode} plan does not include ${feature}`, HttpStatus.FORBIDDEN, {
      feature,
      plan: plan.planCode,
    });
  }
}

export async function subscriptionSummary(db: Database) {
  const { rows } = await db.execute<{
    plan_code: string;
    plan_name: string;
    status: string;
    trial_ends_at: Date | null;
    current_period_end: Date | null;
    grace_ends_at: Date | null;
    limits: PlanLimits;
    features: PlanFeature[];
    writable: boolean;
  }>(sql`SELECT s.plan_code, p.name AS plan_name, s.status, s.trial_ends_at, s.current_period_end, s.grace_ends_at,
                p.limits, p.features, app_subscription_write_allowed() AS writable
           FROM subscriptions s JOIN plans p ON p.code = s.plan_code`);
  const s = rows[0];
  if (!s) return null;
  const usage: Partial<Record<keyof PlanLimits, number>> = {};
  for (const key of Object.keys(USAGE_SQL) as (keyof PlanLimits)[]) {
    const r = await db.execute<{ n: number }>(USAGE_SQL[key]);
    usage[key] = Number(r.rows[0]?.n ?? 0);
  }
  return {
    plan: { code: s.plan_code, name: s.plan_name, limits: s.limits, features: s.features },
    status: s.status,
    access: s.writable ? 'FULL' : 'READ_ONLY',
    trialEndsAt: s.trial_ends_at,
    currentPeriodEnd: s.current_period_end,
    graceEndsAt: s.grace_ends_at,
    usage,
  };
}
