import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { WorkerMonitor } from '../../src/monitoring.js';

/** The worker half of the alert-rule check (the API half is in apps/api monitoring.test.ts). */
describe('alert rules naming worker metrics', () => {
  it('name only metrics the worker exports', () => {
    const rules = readFileSync(fileURLToPath(new URL('../../../../infra/monitoring/alerts.yml', import.meta.url)), 'utf8');
    const named = new Set([...rules.matchAll(/\bonepos_worker_[a-z0-9_]+\b/g)].map(([m]) => m));
    named.delete('onepos_worker_heartbeat_age_seconds'); // exported by the API from the heartbeat rows
    expect(named.size).toBeGreaterThan(0);
    const exported = new Set(new WorkerMonitor({ totalCount: 0, idleCount: 0, waitingCount: 0 } as Pool, 'x', 'x').registry.names());
    expect([...named].filter((m) => !exported.has(m))).toEqual([]);
  });
});
