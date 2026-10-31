import type { FileStorage } from '@1pos/database';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { checkoutExpiredHandler, DevCheckoutExpirer, PayMongoCheckoutExpirer } from '../../src/billing-checkouts.js';
import { runHourly } from '../../src/hourly.js';
import { WorkerMonitor } from '../../src/monitoring.js';
import type { OutboxEvent } from '../../src/outbox-processor.js';

const quiet = { info: () => {}, error: () => {} };

describe('closing a payment page at PayMongo (audit 45 #3)', () => {
  const fake = (status: number) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
    return { calls, fn };
  };

  it('posts to the session’s expire endpoint with the secret key', async () => {
    const f = fake(200);
    expect(await new PayMongoCheckoutExpirer('sk_test_abc', f.fn).expire('PAYMONGO', 'cs_123abc')).toBe('EXPIRED');
    expect(f.calls[0]!.url).toBe('https://api.paymongo.com/v1/checkout_sessions/cs_123abc/expire');
    expect(f.calls[0]!.init.method).toBe('POST');
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('sk_test_abc:').toString('base64')}`);
  });

  it('a page already closed (expired, paid, unknown) is done; a wrong key or a provider error is retried', async () => {
    for (const s of [400, 404, 409, 422]) expect(await new PayMongoCheckoutExpirer('sk_test_abc', fake(s).fn).expire('PAYMONGO', 'cs_1')).toBe('ALREADY_CLOSED');
    for (const s of [401, 403, 429, 500, 503]) await expect(new PayMongoCheckoutExpirer('sk_test_abc', fake(s).fn).expire('PAYMONGO', 'cs_1')).rejects.toThrow(String(s));
  });

  it('never calls out for a dev page or an id that is not a PayMongo session', async () => {
    const f = fake(200);
    const pm = new PayMongoCheckoutExpirer('sk_test_abc', f.fn);
    expect(await pm.expire('DEV', 'dev_cs_1')).toBe('NOTHING_TO_DO');
    await expect(pm.expire('PAYMONGO', '../../payments')).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it('the outbox handler reads the payload only (ids), and acknowledges a malformed one', async () => {
    const dev = new DevCheckoutExpirer();
    const run = checkoutExpiredHandler(dev) as (e: OutboxEvent) => Promise<void>;
    await run({ payload: { checkoutId: 'c1', provider: 'DEV', providerCheckoutId: 'dev_cs_9' } } as unknown as OutboxEvent);
    await run({ payload: {} } as unknown as OutboxEvent);
    expect(dev.expired).toEqual(['dev_cs_9']);
  });
});

describe('the hourly pass (audit 45 #5)', () => {
  const pool = (fail: string[], billing: Record<string, number> = {}) => {
    const ran: string[] = [];
    const p = {
      totalCount: 0, idleCount: 0, waitingCount: 0,
      query: async (text: string) => {
        const fn = /SELECT (?:\* FROM )?(\w+)\(/.exec(text)![1]!;
        ran.push(fn);
        if (fail.includes(fn)) throw new Error(`${fn} broke`);
        if (fn === 'platform_billing_tick') return { rows: [{ r: billing }] };
        if (fn === 'data_export_due_expiry') return { rows: [] };
        return { rows: [{ n: 0 }] };
      },
    };
    return { ran, pool: p as unknown as Pool };
  };
  const storage = {} as FileStorage;

  it('one failing step is counted and the others still run, the billing pass included', async () => {
    const { ran, pool: p } = pool(['platform_purge_expired_idempotency']);
    const monitor = new WorkerMonitor(p, 'w', 'test');
    await runHourly(p, storage, monitor, quiet, () => 1_800_000_000_000);
    expect(ran).toEqual(['platform_purge_expired_idempotency', 'platform_flag_expiring_lots', 'platform_billing_tick', 'data_export_due_expiry']);
    expect(monitor.hourlyErrors.get({ step: 'purge_idempotency' })).toBe(1);
    expect(monitor.hourlyErrors.get({ step: 'billing_tick' })).toBe(0);
    expect(monitor.lastBillingTick.get()).toBe(1_800_000_000);
  });

  it('a failed billing pass leaves the last-success time alone; businesses it skipped are counted', async () => {
    const broken = pool(['platform_billing_tick']);
    const monitor = new WorkerMonitor(broken.pool, 'w', 'test');
    await runHourly(broken.pool, storage, monitor, quiet);
    expect(monitor.hourlyErrors.get({ step: 'billing_tick' })).toBe(1);
    expect(monitor.lastBillingTick.get()).toBeUndefined();
    const partial = pool([], { renewalBills: 2, errors: 3 });
    await runHourly(partial.pool, storage, monitor, quiet, () => 1_800_000_000_000);
    expect(monitor.hourlyErrors.get({ step: 'billing_business' })).toBe(3);
    expect(monitor.lastBillingTick.get()).toBe(1_800_000_000);
    expect(monitor.registry.names()).toEqual(expect.arrayContaining(['onepos_worker_hourly_errors_total', 'onepos_worker_billing_tick_last_success_timestamp_seconds']));
  });

  it('a pass skipped because another worker holds the lock is not a success (audit 47 #15)', async () => {
    const skipped = pool([], { skipped: 1 });
    const monitor = new WorkerMonitor(skipped.pool, 'w', 'test');
    await runHourly(skipped.pool, storage, monitor, quiet, () => 1_800_000_000_000);
    expect(monitor.lastBillingTick.get()).toBeUndefined();
    expect(monitor.hourlyErrors.get({ step: 'billing_tick' })).toBe(0);
  });
});
