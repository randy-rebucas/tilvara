/**
 * Shared by the load seed and harness (ADR-0016 slice 5). Everything runs against its own database,
 * `onepos_load`, created and migrated here, and an API process started on it, never the dev DB.
 */
import { runMigrations } from '@1pos/database';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
try {
  loadEnvFile(join(ROOT, '.env'));
} catch {
  // variables come from the environment
}

export const LOAD_DB = process.env.LOAD_DATABASE_NAME ?? 'onepos_load';
if (!/^onepos_load[a-z0-9_]*$/.test(LOAD_DB)) throw new Error('LOAD_DATABASE_NAME must start with onepos_load');
export const SEED_FILE = join(ROOT, '.load', `${LOAD_DB}.seed.json`);
export const PASSWORD = 'correct horse battery staple';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
};
export const withDatabase = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
/** Superuser on the cluster (creates the database, counts across tenants afterwards). */
export const adminUrl = () => withDatabase(process.env.LOAD_ADMIN_URL ?? need('DRILL_ADMIN_URL'), LOAD_DB);

/** Create `onepos_load` like init/01-roles.sql creates `onepos`, then migrate it. Idempotent. */
export async function ensureLoadDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: withDatabase(process.env.LOAD_ADMIN_URL ?? need('DRILL_ADMIN_URL'), 'postgres') });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [LOAD_DB]);
    if (!rowCount) {
      await admin.query(`CREATE DATABASE ${LOAD_DB} OWNER onepos_migrator TEMPLATE template0 ENCODING 'UTF8'`);
      const db = new pg.Client({ connectionString: adminUrl() });
      await db.connect();
      await db.query(`ALTER SCHEMA public OWNER TO onepos_migrator;
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        GRANT USAGE ON SCHEMA public TO onepos_app, onepos_worker, onepos_readonly;`);
      await db.end();
    }
  } finally {
    await admin.end();
  }
  await runMigrations(withDatabase(need('DATABASE_MIGRATOR_URL'), LOAD_DB));
}

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

export interface ApiProcess {
  base: string;
  metricsPort: number;
  child: ChildProcess;
  stop(): Promise<void>;
}

/** The built API (`pnpm build` first) on the load database: rate limits off, one hour tokens, no Redis. */
export async function startApi(extraEnv: Record<string, string> = {}, nodeArgs: string[] = []): Promise<ApiProcess> {
  const [port, metricsPort] = [await freePort(), await freePort()];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: withDatabase(need('DATABASE_URL'), LOAD_DB),
    API_PORT: String(port),
    API_HOST: '127.0.0.1',
    API_METRICS_PORT: String(metricsPort),
    RATE_LIMITS_ENABLED: 'false',
    JWT_ACCESS_TTL_SECONDS: '3600',
    LOG_LEVEL: 'warn',
    NODE_ENV: 'development',
    ...extraEnv,
  };
  delete env.REDIS_URL;
  const child = spawn(process.execPath, [...nodeArgs, 'dist/main.js'], { cwd: join(ROOT, 'apps/api'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  // Warnings and errors (JSON lines) are kept for diagnosing 5xx answers under load.
  mkdirSync(join(ROOT, '.load'), { recursive: true });
  const logFile = createWriteStream(join(ROOT, '.load', `api-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.log`));
  for (const s of [child.stdout!, child.stderr!]) {
    s.on('data', (d) => (output = (output + String(d)).slice(-4000)));
    s.pipe(logFile);
  }
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the API exited (${child.exitCode}):\n${output}`);
    const ready = await fetch(`${base}/v1/health/ready`).then((r) => r.ok, () => false);
    if (ready) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`the API was not ready within 60 s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    base,
    metricsPort,
    child,
    stop: () =>
      new Promise((ok) => {
        if (child.exitCode !== null) return ok();
        child.once('exit', () => ok());
        child.kill();
      }),
  };
}

/**
 * CPU profile of an API started with `--inspect=127.0.0.1:<port>`, over the inspector protocol
 * (works on Windows, where a child cannot be signalled to write --cpu-prof). `stop()` returns the
 * hottest functions by self time and the raw profile (open it in Chrome DevTools).
 */
export async function cpuProfiler(inspectPort: number) {
  const [target] = (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()) as { webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(target!.webSocketDebuggerUrl);
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  let id = 0;
  const pending = new Map<number, (r: any) => void>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown };
    if (msg.id !== undefined) pending.get(msg.id)?.(msg.result);
  };
  const send = (method: string, params: object = {}) =>
    new Promise<any>((ok) => {
      pending.set(++id, ok);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 500 });
  return {
    start: () => send('Profiler.start'),
    async stop(top = 25) {
      const { profile } = (await send('Profiler.stop')) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[] } };
      ws.close();
      const byNode = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
      const self = new Map<string, number>();
      for (const s of profile.samples) {
        const f = byNode.get(s)!;
        const where = f.url ? f.url.replace(/^file:\/\/\/?/, '').replace(/.*node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?/, '').replace(/.*[\\/]apps[\\/]/, 'apps/') : '';
        const key = `${f.functionName || '(anonymous)'} ${where}:${f.lineNumber + 1}`;
        self.set(key, (self.get(key) ?? 0) + 1);
      }
      const total = profile.samples.length;
      const hottest = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, n]) => ({ fn, selfPct: Math.round((n / total) * 1000) / 10 }));
      // Self time per package (what to look at first).
      const byPackage = new Map<string, number>();
      for (const [fn, n] of self) {
        const pkg = /^\S+ (@[^\\/]+[\\/][^\\/]+|[^\\/:@]+)/.exec(fn)?.[1] ?? '(native/gc)';
        byPackage.set(pkg, (byPackage.get(pkg) ?? 0) + n);
      }
      const packages = [...byPackage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([p, n]) => ({ package: p, selfPct: Math.round((n / total) * 1000) / 10 }));
      return { profile, hottest, packages };
    },
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Like `client`, but a write that got no answer or a 5xx is sent again with the same Idempotency-Key
 * (what tills do: the outcome is unknown, never "failed"), up to 5 times. For seeding only; the harness
 * measures first answers.
 */
export function retryingClient(base: string, onRetry: (status: number | 'network') => void = () => undefined) {
  const call = client(base);
  return async function retrying<T = any>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call<T>(method, path, token, body, headers);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 'network';
        const retryable = status === 'network' || status >= 500;
        if (!retryable || attempt >= 5 || (method !== 'GET' && !headers['idempotency-key'])) throw e;
        onRetry(status);
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  };
}

/** JSON call; throws HttpError on a non-2xx answer. */
export function client(base: string) {
  return async function call<T = any>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new HttpError(res.status, data, `${method} ${path} → ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    return data as T;
  };
}

/** Run `fn` over `items` with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

/** Latency summary in ms (nearest-rank percentiles). */
export function summarize(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : NaN);
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(50)), p95: r(at(95)), p99: r(at(99)), max: r(s[s.length - 1] ?? NaN) };
}

export interface SeedFile {
  createdAt: string;
  scale: { tenants: number; branches: number; registers: number; items: number; hot: number };
  tenants: {
    email: string;
    tenantId: string;
    branches: { id: string; registers: string[] }[];
    /** Items stocked at every branch, sold by the harness: variant id and its barcode. */
    hot: { variantId: string; barcode: string }[];
  }[];
}
