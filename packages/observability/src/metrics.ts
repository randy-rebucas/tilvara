import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * A small Prometheus registry (text exposition format 0.0.4), ADR-0016 slice 3. Counters, gauges
 * and histograms with fixed label names; values are kept in this process and rendered on scrape.
 * Label values must come from bounded sets (route templates, codes, outcomes), never from
 * request data such as ids, emails or tenant names.
 */
type Values<L extends string> = Partial<Record<L, string>>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_LABEL_VALUE = 120;
const MAX_SERIES = 2_000;

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

interface MetricOptions<L extends string> {
  name: string;
  help: string;
  labelNames?: readonly L[];
}

const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const escapeHelp = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

export function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

abstract class Metric<L extends string> {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly L[];
  abstract readonly type: 'counter' | 'gauge' | 'histogram';

  constructor(o: MetricOptions<L>) {
    if (!NAME.test(o.name)) throw new Error(`invalid metric name: ${o.name}`);
    for (const l of o.labelNames ?? []) {
      if (!LABEL.test(l) || l === 'le' || l.startsWith('__')) throw new Error(`invalid label name on ${o.name}: ${l}`);
    }
    this.name = o.name;
    this.help = o.help;
    this.labelNames = o.labelNames ?? [];
  }

  /** The series key: label values in declared order. Unknown or missing labels are programming errors. */
  protected key(labels: Values<L> | undefined): string {
    const given = Object.keys(labels ?? {});
    if (given.length !== this.labelNames.length || given.some((g) => !this.labelNames.includes(g as L))) {
      throw new Error(`${this.name}: expected labels [${this.labelNames.join(', ')}], got [${given.join(', ')}]`);
    }
    return JSON.stringify(this.labelNames.map((l) => String(labels![l]).slice(0, MAX_LABEL_VALUE)));
  }

  protected labelText(key: string, extra?: [string, string]): string {
    const values = JSON.parse(key) as string[];
    const pairs = this.labelNames.map((l, i) => `${l}="${escapeLabel(values[i]!)}"`);
    if (extra) pairs.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
    return pairs.length ? `{${pairs.join(',')}}` : '';
  }

  protected guard(size: number, key: string, has: boolean): boolean {
    // A label set that is not bounded after all must not grow memory without end.
    return has || size < MAX_SERIES || key === '';
  }

  header(): string {
    return `# HELP ${this.name} ${escapeHelp(this.help)}\n# TYPE ${this.name} ${this.type}\n`;
  }

  abstract lines(): string;
}

export class Counter<L extends string = never> extends Metric<L> {
  readonly type = 'counter';
  private readonly series = new Map<string, number>();

  inc(labels?: Values<L>, by = 1): void {
    if (!(by >= 0)) throw new Error(`${this.name}: counters only go up`);
    const k = this.key(labels);
    if (!this.guard(this.series.size, k, this.series.has(k))) return;
    this.series.set(k, (this.series.get(k) ?? 0) + by);
  }

  get(labels?: Values<L>): number {
    return this.series.get(this.key(labels)) ?? 0;
  }

  lines(): string {
    let out = '';
    for (const [k, v] of this.series) out += `${this.name}${this.labelText(k)} ${formatValue(v)}\n`;
    return out;
  }
}

export class Gauge<L extends string = never> extends Metric<L> {
  readonly type = 'gauge';
  private readonly series = new Map<string, number>();

  set(labels: Values<L> | undefined, value: number): void {
    const k = this.key(labels);
    if (!this.guard(this.series.size, k, this.series.has(k))) return;
    this.series.set(k, value);
  }

  get(labels?: Values<L>): number | undefined {
    return this.series.get(this.key(labels));
  }

  /** Forget every series (a collector that rebuilds its label sets on each scrape). */
  reset(): void {
    this.series.clear();
  }

  lines(): string {
    let out = '';
    for (const [k, v] of this.series) out += `${this.name}${this.labelText(k)} ${formatValue(v)}\n`;
    return out;
  }
}

interface HistogramSeries {
  buckets: number[];
  sum: number;
  count: number;
}

export class Histogram<L extends string = never> extends Metric<L> {
  readonly type = 'histogram';
  readonly buckets: readonly number[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(o: MetricOptions<L> & { buckets?: readonly number[] }) {
    super(o);
    const b = [...(o.buckets ?? DEFAULT_BUCKETS)];
    if (b.length === 0 || b.some((x, i) => !Number.isFinite(x) || (i > 0 && x <= b[i - 1]!))) {
      throw new Error(`${this.name}: buckets must be finite and increasing`);
    }
    this.buckets = b;
  }

  observe(labels: Values<L> | undefined, value: number): void {
    const k = this.key(labels);
    let s = this.series.get(k);
    if (!s) {
      if (!this.guard(this.series.size, k, false)) return;
      s = { buckets: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) s.buckets[i]!++;
    s.sum += value;
    s.count++;
  }

  /** Start a timer; the returned function observes the elapsed seconds. */
  startTimer(labels?: Values<L>): () => number {
    const start = process.hrtime.bigint();
    return () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.observe(labels, seconds);
      return seconds;
    };
  }

  count(labels?: Values<L>): number {
    return this.series.get(this.key(labels))?.count ?? 0;
  }

  lines(): string {
    let out = '';
    for (const [k, s] of this.series) {
      this.buckets.forEach((b, i) => {
        out += `${this.name}_bucket${this.labelText(k, ['le', formatValue(b)])} ${s.buckets[i]}\n`;
      });
      out += `${this.name}_bucket${this.labelText(k, ['le', '+Inf'])} ${s.count}\n`;
      out += `${this.name}_sum${this.labelText(k)} ${formatValue(s.sum)}\n`;
      out += `${this.name}_count${this.labelText(k)} ${s.count}\n`;
    }
    return out;
  }
}

type Collector = () => void | Promise<void>;

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric<string>>();
  private readonly collectors: Collector[] = [];

  counter<L extends string = never>(o: MetricOptions<L>): Counter<L> {
    return this.add(new Counter<L>(o));
  }

  gauge<L extends string = never>(o: MetricOptions<L>): Gauge<L> {
    return this.add(new Gauge<L>(o));
  }

  histogram<L extends string = never>(o: MetricOptions<L> & { buckets?: readonly number[] }): Histogram<L> {
    return this.add(new Histogram<L>(o));
  }

  /** Runs before every render, e.g. to read pool sizes or query the database into gauges. */
  onCollect(fn: Collector): void {
    this.collectors.push(fn);
  }

  /** Every registered metric name (HELP/TYPE lines are rendered even before a first value). */
  names(): string[] {
    return [...this.metrics.keys()];
  }

  async render(): Promise<string> {
    // A failing collector leaves its gauges as they were; collectors report their own health.
    await Promise.allSettled(this.collectors.map(async (c) => c()));
    let out = '';
    for (const m of this.metrics.values()) out += m.header() + m.lines();
    return out;
  }

  private add<M extends Metric<string>>(m: M): M {
    if (this.metrics.has(m.name)) throw new Error(`metric already registered: ${m.name}`);
    this.metrics.set(m.name, m);
    return m;
  }
}

/** Standard process gauges (names follow the Prometheus client conventions). */
export function registerProcessMetrics(registry: MetricsRegistry): void {
  const start = registry.gauge({ name: 'process_start_time_seconds', help: 'Start time of the process since the Unix epoch, in seconds.' });
  const rss = registry.gauge({ name: 'process_resident_memory_bytes', help: 'Resident memory size in bytes.' });
  const heap = registry.gauge({ name: 'nodejs_heap_size_used_bytes', help: 'V8 heap in use, in bytes.' });
  const lag = registry.gauge({ name: 'nodejs_eventloop_lag_p99_seconds', help: 'p99 event-loop delay since the previous scrape, in seconds.' });
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  start.set(undefined, Math.round(Date.now() / 1000 - process.uptime()));
  registry.onCollect(() => {
    const mem = process.memoryUsage();
    rss.set(undefined, mem.rss);
    heap.set(undefined, mem.heapUsed);
    lag.set(undefined, loop.count > 0 ? loop.percentile(99) / 1e9 : 0);
    loop.reset();
  });
}

export interface MetricsServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Serve `GET /metrics` on its own listener (an internal port, never the public API listener).
 * `port: 0` picks a free port (tests). Nothing else is served. With `token`, a scrape must send
 * `Authorization: Bearer <token>` (Prometheus `authorization.credentials`); otherwise 401.
 */
export function startMetricsServer(o: { registry: MetricsRegistry; port: number; host: string; token?: string }): Promise<MetricsServer> {
  const expected = o.token ? createHash('sha256').update(`Bearer ${o.token}`).digest() : null;
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }).end('method not allowed\n');
      return;
    }
    // Both sides hashed to one length, so the comparison takes the same time whatever was sent.
    if (expected && !timingSafeEqual(createHash('sha256').update(req.headers.authorization ?? '').digest(), expected)) {
      res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'text/plain' }).end('unauthorized\n');
      return;
    }
    o.registry
      .render()
      .then((body) => {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : body);
      })
      .catch(() => res.writeHead(500, { 'content-type': 'text/plain' }).end('metrics unavailable\n'));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : o.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
