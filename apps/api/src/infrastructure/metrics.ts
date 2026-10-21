import { Injectable } from '@nestjs/common';
import { MetricsRegistry, registerProcessMetrics } from '@1pos/observability';
import type { NextFunction, Request, Response } from 'express';

/**
 * Business gauges computed by `platform_metrics()` (migration 0047): counts and ages only, across
 * tenants. Registered up front so every name is exported before the first scrape; rows the API
 * does not know (a newer schema) are ignored.
 */
export const BUSINESS_GAUGES = {
  outbox_events: { help: 'Outbox events by status (DONE rows are not counted).', label: 'status' },
  outbox_oldest_undelivered_age_seconds: { help: 'Age of the oldest PENDING or PROCESSING outbox event.' },
  payment_intents_unresolved: { help: 'Card/QR payments waiting for the provider (PROCESSING) or for reconciliation (UNKNOWN).', label: 'status' },
  payment_intents_unresolved_oldest_age_seconds: { help: 'Age of the oldest unresolved payment intent.' },
  offline_sales_quarantined: { help: 'Offline sales refused at sync and waiting for a manager.' },
  offline_sales_quarantined_oldest_age_seconds: { help: 'Age of the oldest quarantined offline sale.' },
  tills_with_open_shift: { help: 'Active tills whose register has an open shift.' },
  tills_silent: { help: 'Tills with an open shift that have not been in touch for 30 minutes (offline, sales may be on board).' },
  tills_longest_silence_seconds: { help: 'Longest silence among silent tills.' },
  cashier_sessions_awaiting_approval: { help: 'Shifts closed with a cash variance that waits for approval.' },
  cashier_sessions_awaiting_approval_oldest_age_seconds: { help: 'Age of the oldest shift awaiting variance approval.' },
  workers_alive: { help: 'Outbox workers with a heartbeat in the last 60 seconds.' },
  worker_heartbeat_age_seconds: { help: 'Seconds since the freshest worker heartbeat (+Inf when none).' },
  backup_last_success_timestamp_seconds: { help: 'Unix time of the last successful encrypted backup (0 when none).' },
  restore_drill_last_success_timestamp_seconds: { help: 'Unix time of the last passed restore drill (0 when none).' },
  lodging_stays_nights_overdue: { help: 'In-house stays with a room night that fell due more than a day ago and is not posted (night audit behind).' },
} as const satisfies Record<string, { help: string; label?: string }>;

export type BusinessGauge = keyof typeof BUSINESS_GAUGES;

/** Route templates (`METHOD /v1/...` as Express matched them) whose outcomes are domain signals. */
const CHECKOUT_ROUTES: Record<string, string> = {
  'POST /v1/sales': 'retail',
  'POST /v1/restaurant/bills/:id/checks': 'check',
};
const REFUND_ROUTES = new Set(['POST /v1/sales/:id/returns']);
const STOCK_DOCUMENT_ROUTES: Record<string, string> = {
  'POST /v1/goods-receipts': 'goods_receipt',
  'POST /v1/supplier-returns': 'supplier_return',
  'POST /v1/stock/transfers': 'transfer',
  'POST /v1/stock/transfers/:id/receive': 'transfer_receipt',
  'POST /v1/stock/counts': 'count',
  'POST /v1/stock/adjustments': 'adjustment',
};
const SIGNUP_ROUTE = 'POST /v1/auth/signup';

const outcomeOf = (status: number) => (status < 400 ? 'ok' : status >= 500 ? 'failed' : 'refused');

/**
 * Every instrument of the API (ADR-0016 slice 3), in one registry served on the internal metrics
 * port. Labels only take values from fixed sets: route templates, statuses, error codes, outcomes.
 */
@Injectable()
export class ApiMetrics {
  readonly registry = new MetricsRegistry();

  readonly httpRequests = this.registry.counter({
    name: 'onepos_http_requests_total',
    help: 'HTTP requests answered, by route template and status.',
    labelNames: ['method', 'route', 'status'],
  });
  readonly httpDuration = this.registry.histogram({
    name: 'onepos_http_request_duration_seconds',
    help: 'HTTP request duration by route template.',
    labelNames: ['method', 'route'],
  });
  readonly checkouts = this.registry.counter({
    name: 'onepos_checkout_total',
    help: 'Online checkouts (retail sale or restaurant check) by outcome: recorded, replayed, refused (4xx), failed (5xx).',
    labelNames: ['channel', 'outcome'],
  });
  readonly checkoutDuration = this.registry.histogram({
    name: 'onepos_checkout_duration_seconds',
    help: 'Online checkout duration (server side), replays excluded.',
    labelNames: ['channel'],
    buckets: [0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 5],
  });
  readonly offlineSales = this.registry.counter({
    name: 'onepos_offline_sales_total',
    help: 'Offline sales delivered by tills, by outcome: recorded, replayed, quarantined, rejected.',
    labelNames: ['outcome'],
  });
  readonly idempotency = this.registry.counter({
    name: 'onepos_idempotency_total',
    help: 'Duplicate operations: replayed answers, keys reused with another body, duplicate client transaction ids.',
    labelNames: ['outcome'],
  });
  readonly refundRefusals = this.registry.counter({
    name: 'onepos_refund_refusals_total',
    help: 'Returns and voids refused (4xx), by error code.',
    labelNames: ['code'],
  });
  readonly inventoryConflicts = this.registry.counter({
    name: 'onepos_inventory_conflicts_total',
    help: 'Stock documents refused with 409/422 (over-receipt, double receive, stale state…), by document and code.',
    labelNames: ['document', 'code'],
  });
  readonly payments = this.registry.counter({
    name: 'onepos_payment_outcomes_total',
    help: 'Card/QR provider outcomes by step (authorize, reconcile) and status (succeeded, failed, unknown).',
    labelNames: ['provider', 'step', 'outcome'],
  });
  readonly provisioning = this.registry.counter({
    name: 'onepos_provisioning_total',
    help: 'Business sign-ups by outcome: ok, refused (4xx), failed (5xx).',
    labelNames: ['outcome'],
  });
  readonly nightAudit = this.registry.counter({
    name: 'onepos_night_audit_total',
    help: 'Scheduled night audit (ADR-0023 §7): room nights posted, stays (or whole passes) that failed to post, businesses skipped as read-only.',
    labelNames: ['outcome'],
  });
  readonly dbPoolErrors = this.registry.counter({
    name: 'onepos_db_pool_errors_total',
    help: 'Idle database connections lost (server restart, failover, killed).',
  });
  readonly dbPool = this.registry.gauge({
    name: 'onepos_db_pool_connections',
    help: 'Runtime pool connections: total, idle, and requests waiting for one.',
    labelNames: ['state'],
  });
  readonly dbUp = this.registry.gauge({ name: 'onepos_db_up', help: '1 when the last business-gauge query succeeded.' });
  readonly redisUp = this.registry.gauge({
    name: 'onepos_redis_up',
    help: '1 when Redis answers a ping (rate-limit counters); not exported without REDIS_URL.',
  });
  readonly rateLimitFallbacks = this.registry.counter({
    name: 'onepos_rate_limit_fallbacks_total',
    help: 'Rate-limit hits counted in this process because Redis did not answer.',
  });
  readonly migrationsBehind = this.registry.gauge({
    name: 'onepos_schema_migrations_behind',
    help: 'Migrations this build expects that the database does not have (readiness fails while > 0).',
  });
  readonly gaugeScrape = this.registry.gauge({
    name: 'onepos_business_gauges_scrape_seconds',
    help: 'Duration of the last platform_metrics() query.',
  });
  readonly business = Object.fromEntries(
    Object.entries(BUSINESS_GAUGES).map(([name, g]) => [
      name,
      this.registry.gauge<string>({ name: `onepos_${name}`, help: g.help, labelNames: 'label' in g ? [g.label] : [] }),
    ]),
  ) as Record<BusinessGauge, ReturnType<MetricsRegistry['gauge']>>;

  constructor() {
    registerProcessMetrics(this.registry);
  }

  /** Called once per answered request (see `httpMetrics`). */
  recordHttp(method: string, route: string, status: number, seconds: number, errorCode: string | undefined, replayed: boolean): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, seconds);
    const key = `${method} ${route}`;
    if (replayed) this.idempotency.inc({ outcome: 'replayed' });
    if (errorCode === 'IDEMPOTENCY_KEY_REUSED') this.idempotency.inc({ outcome: 'key_reused' });
    if (errorCode === 'DUPLICATE_TRANSACTION') this.idempotency.inc({ outcome: 'duplicate_transaction' });

    const channel = CHECKOUT_ROUTES[key];
    if (channel) {
      const o = outcomeOf(status);
      this.checkouts.inc({ channel, outcome: replayed ? 'replayed' : o === 'ok' ? 'recorded' : o });
      if (!replayed) this.checkoutDuration.observe({ channel }, seconds);
    }
    if (REFUND_ROUTES.has(key) && status >= 400 && status < 500) this.refundRefusals.inc({ code: errorCode ?? String(status) });
    const document = STOCK_DOCUMENT_ROUTES[key];
    if (document && (status === 409 || status === 422)) this.inventoryConflicts.inc({ document, code: errorCode ?? String(status) });
    if (key === SIGNUP_ROUTE) this.provisioning.inc({ outcome: outcomeOf(status) });
  }
}

/**
 * Express middleware (registered first in `configureApp`): times every request and records it once
 * answered. The route label is the matched template (`/v1/sales/:id`), never the raw URL, and
 * `unmatched` for 404s, so ids and query strings never become label values.
 */
export function httpMetrics(metrics: ApiMetrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      const code = typeof res.locals.errorCode === 'string' ? res.locals.errorCode : undefined;
      metrics.recordHttp(req.method, route, res.statusCode, seconds, code, res.getHeader('idempotent-replayed') === 'true');
    });
    next();
  };
}
