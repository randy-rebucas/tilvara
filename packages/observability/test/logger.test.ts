import { Writable } from 'node:stream';
import { context, trace, type Span, type SpanContext } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { createLogger, currentLogContext, enrichLogContext, withLogContext } from '../src/index.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)));
      cb();
    },
  });
  return { lines, logger: createLogger({ service: 'test', level: 'debug', destination }) };
}

describe('createLogger', () => {
  it('writes JSON with service, level label and ISO time', () => {
    const { lines, logger } = capture();
    logger.info({ route: '/v1/x' }, 'hello');
    expect(lines[0]).toMatchObject({ service: 'test', level: 'info', msg: 'hello', route: '/v1/x' });
    expect(String(lines[0]!.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('adds correlation/tenant/user ids from the async scope, including fields added later', async () => {
    const { lines, logger } = capture();
    await withLogContext({ correlationId: 'corr-12345678' }, async () => {
      await Promise.resolve();
      enrichLogContext({ tenantId: 't-1', userId: 'u-1' });
      logger.info('inside');
      expect(currentLogContext()).toMatchObject({ tenantId: 't-1' });
    });
    logger.info('outside');
    expect(lines[0]).toMatchObject({ correlation_id: 'corr-12345678', tenant_id: 't-1', user_id: 'u-1' });
    expect(lines[1]).not.toHaveProperty('correlation_id');
  });

  it('keeps concurrent scopes apart', async () => {
    const { lines, logger } = capture();
    await Promise.all(
      ['a', 'b', 'c'].map((t) =>
        withLogContext({ tenantId: t }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          logger.info(t);
        }),
      ),
    );
    for (const l of lines) expect(l.tenant_id).toBe(l.msg);
  });

  it('redacts credentials whatever the call site passes', () => {
    const { lines, logger } = capture();
    logger.info({ password: 'hunter2', user: { refreshToken: 'r', accessToken: 'a' }, headers: { authorization: 'Bearer x', cookie: 'c' } }, 'x');
    const s = JSON.stringify(lines[0]);
    for (const secret of ['hunter2', '"r"', '"a"', 'Bearer x', '"c"']) expect(s).not.toContain(secret);
  });

  it('adds trace_id/span_id when an OpenTelemetry span is active', () => {
    const { lines, logger } = capture();
    const spanContext: SpanContext = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: 1 };
    const span = trace.wrapSpanContext(spanContext) as Span;
    // The API has no context manager without an SDK, so pass the span through a stub manager.
    const ctx = trace.setSpan(context.active(), span);
    const original = trace.getActiveSpan;
    trace.getActiveSpan = () => trace.getSpan(ctx);
    try {
      logger.info('traced');
    } finally {
      trace.getActiveSpan = original;
    }
    logger.info('untraced');
    expect(lines[0]).toMatchObject({ trace_id: spanContext.traceId, span_id: spanContext.spanId });
    expect(lines[1]).not.toHaveProperty('trace_id');
  });
});
