import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './platform.js';

export interface PlanLimits {
  maxLegalEntities: number;
  maxBranches: number;
  maxRegisters: number;
  maxUsers: number;
}

export const PLAN_FEATURES = ['restaurant', 'multi_entity', 'api_access', 'advanced_reports'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** Global plan catalog (platform-managed, seeded by migration). */
export const plans = pgTable('plans', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  monthlyPrice: numeric('monthly_price', { precision: 20, scale: 4 }).notNull(),
  currency: text('currency').notNull().default('PHP'),
  limits: jsonb('limits').$type<PlanLimits>().notNull(),
  features: jsonb('features').$type<PlanFeature[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
});

export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * One current subscription per tenant. Changed only by platform functions / billing
 * provider webhooks (PayMongo, later). Access rule (app_subscription_write_allowed):
 * TRIALING until trial end, ACTIVE, and PAST_DUE until grace end → full access;
 * otherwise read-only. Data is never deleted for billing reasons.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    planCode: text('plan_code')
      .notNull()
      .references(() => plans.code),
    status: text('status').$type<SubscriptionStatus>().notNull(),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    graceEndsAt: timestamp('grace_ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('subscriptions_tenant_unique').on(t.tenantId),
    check('subscriptions_status_check', sql`${t.status} IN ('TRIALING','ACTIVE','PAST_DUE','CANCELED')`),
  ],
);
