import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry, registerProcessMetrics, startMetricsServer, type MetricsServer } from '../src/index.js';

const get = (port: number, path: string, method = 'GET', headers: Record<string, string> = {}) =>
  new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });

describe('MetricsRegistry', () => {
  it('renders counters, gauges and histograms in the Prometheus text format', async () => {
    const r = new MetricsRegistry();
    const c = r.counter({ name: 'app_requests_total', help: 'Requests.', labelNames: ['route', 'status'] });
    const g = r.gauge({ name: 'app_queue_depth', help: 'Depth.' });
    const h = r.histogram({ name: 'app_latency_seconds', help: 'Latency.', labelNames: ['route'], buckets: [0.1, 1] });
    c.inc({ route: '/v1/sales', status: '201' });
    c.inc({ route: '/v1/sales', status: '201' }, 2);
    g.set(undefined, 7);
    h.observe({ route: '/v1/sales' }, 0.05);
    h.observe({ route: '/v1/sales' }, 0.5);
    h.observe({ route: '/v1/sales' }, 3);
    expect(await r.render()).toBe(
      [
        '# HELP app_requests_total Requests.',
        '# TYPE app_requests_total counter',
        'app_requests_total{route="/v1/sales",status="201"} 3',
        '# HELP app_queue_depth Depth.',
        '# TYPE app_queue_depth gauge',
        'app_queue_depth 7',
        '# HELP app_latency_seconds Latency.',
        '# TYPE app_latency_seconds histogram',
        'app_latency_seconds_bucket{route="/v1/sales",le="0.1"} 1',
        'app_latency_seconds_bucket{route="/v1/sales",le="1"} 2',
        'app_latency_seconds_bucket{route="/v1/sales",le="+Inf"} 3',
        'app_latency_seconds_sum{route="/v1/sales"} 3.55',
        'app_latency_seconds_count{route="/v1/sales"} 3',
        '',
      ].join('\n'),
    );
  });

  it('escapes label values and help text', async () => {
    const r = new MetricsRegistry();
    r.counter({ name: 'x_total', help: 'a \\ b\nc', labelNames: ['v'] }).inc({ v: 'say "hi"\\\n' });
    expect(await r.render()).toContain('# HELP x_total a \\\\ b\\nc\n');
    expect(await r.render()).toContain('x_total{v="say \\"hi\\"\\\\\\n"} 1');
  });

  it('refuses bad names, unknown or missing labels, decreasing counters and duplicate registration', () => {
    const r = new MetricsRegistry();
    expect(() => r.counter({ name: 'bad-name', help: '' })).toThrow(/invalid metric name/);
    expect(() => r.histogram({ name: 'h', help: '', labelNames: ['le'] })).toThrow(/invalid label/);
    expect(() => r.histogram({ name: 'h2', help: '', buckets: [1, 1] })).toThrow(/increasing/);
    const c = r.counter({ name: 'c_total', help: '', labelNames: ['a'] });
    expect(() => c.inc({ b: 'x' } as never)).toThrow(/expected labels/);
    expect(() => c.inc()).toThrow(/expected labels/);
    expect(() => c.inc({ a: 'x' }, -1)).toThrow(/only go up/);
    expect(() => r.counter({ name: 'c_total', help: '' })).toThrow(/already registered/);
  });

  it('lists names before any value, runs collectors on render and survives a failing collector', async () => {
    const r = new MetricsRegistry();
    const g = r.gauge({ name: 'g', help: 'G.', labelNames: ['k'] });
    r.counter({ name: 'never_total', help: 'Never incremented.' });
    let n = 0;
    r.onCollect(() => {
      g.reset();
      g.set({ k: 'a' }, ++n);
    });
    r.onCollect(() => {
      throw new Error('collector down');
    });
    expect(r.names()).toEqual(['g', 'never_total']);
    expect(await r.render()).toContain('g{k="a"} 1');
    const second = await r.render();
    expect(second).toContain('g{k="a"} 2');
    expect(second).toContain('# TYPE never_total counter');
  });

  it('caps the number of series of one metric', () => {
    const r = new MetricsRegistry();
    const c = r.counter({ name: 'many_total', help: '', labelNames: ['id'] });
    for (let i = 0; i < 2_100; i++) c.inc({ id: String(i) });
    expect(c.get({ id: '1999' })).toBe(1);
    expect(c.get({ id: '2050' })).toBe(0);
  });

  it('registers standard process gauges', async () => {
    const r = new MetricsRegistry();
    registerProcessMetrics(r);
    const text = await r.render();
    expect(text).toMatch(/^process_resident_memory_bytes \d+$/m);
    expect(text).toMatch(/^process_start_time_seconds \d+$/m);
    expect(text).toMatch(/^nodejs_eventloop_lag_p99_seconds [\d.e-]+$/m);
  });
});

describe('startMetricsServer', () => {
  let server: MetricsServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('serves only GET/HEAD /metrics on its own listener', async () => {
    const r = new MetricsRegistry();
    r.gauge({ name: 'up_gauge', help: 'Up.' }).set(undefined, 1);
    server = await startMetricsServer({ registry: r, port: 0, host: '127.0.0.1' });
    const ok = await get(server.port, '/metrics');
    expect(ok.status).toBe(200);
    expect(ok.type).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(ok.body).toContain('up_gauge 1');
    expect((await get(server.port, '/metrics?x=1')).status).toBe(200);
    expect((await get(server.port, '/metrics', 'HEAD')).status).toBe(200);
    expect((await get(server.port, '/')).status).toBe(404);
    expect((await get(server.port, '/v1/health/ready')).status).toBe(404);
    expect((await get(server.port, '/metrics', 'POST')).status).toBe(405);
  });

  it('with a token, answers only a scrape that sends it', async () => {
    const r = new MetricsRegistry();
    r.gauge({ name: 'up_gauge', help: 'Up.' }).set(undefined, 1);
    const token = 'scrape-token-0123456789abcdef0123456789';
    server = await startMetricsServer({ registry: r, port: 0, host: '127.0.0.1', token });
    const none = await get(server.port, '/metrics');
    expect(none.status).toBe(401);
    expect(none.body).not.toContain('up_gauge');
    expect((await get(server.port, '/metrics', 'GET', { authorization: `Bearer ${token}x` })).status).toBe(401);
    expect((await get(server.port, '/metrics', 'GET', { authorization: token })).status).toBe(401);
    const ok = await get(server.port, '/metrics', 'GET', { authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('up_gauge 1');
    expect((await get(server.port, '/', 'GET', { authorization: `Bearer ${token}` })).status).toBe(404);
  });
});
