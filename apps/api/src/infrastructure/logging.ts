import type { LoggerService } from '@nestjs/common';
import { currentLogContext, withLogContext, type Logger } from '@1pos/observability';
import type { NextFunction, Response } from 'express';
import type { CorrelatedRequest } from './correlation-id.middleware.js';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Routes Nest's own logging (bootstrap, Logger instances, the error filter) into pino. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...rest: unknown[]) {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    // Nest passes (message, stack?, context?).
    const stack = rest.length > 1 && typeof rest[0] === 'string' ? rest.shift() : undefined;
    this.write('error', message, rest, stack ? { stack } : {});
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.write('trace', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.write('fatal', message, rest);
  }

  private write(level: Level, message: unknown, rest: unknown[], extra: Record<string, unknown> = {}) {
    const context = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : undefined;
    const fields = { ...(context ? { context } : {}), ...extra };
    if (message && typeof message === 'object') this.logger[level]({ ...fields, ...(message as object) });
    else this.logger[level](fields, String(message));
  }
}

/**
 * One access-log line per request: route pattern (aggregatable), method, status, duration.
 * Deliberately no query string, body or headers — they can carry PII or credentials.
 */
export function requestLogger(logger: Logger) {
  return (req: CorrelatedRequest, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    const ctx = currentLogContext();
    res.on('finish', () => {
      // Nest's catch-all not-found route is a wildcard pattern; log the concrete path instead.
      const matched = (req.route as { path?: string } | undefined)?.path;
      const routePath = matched && !matched.includes('*') ? matched : undefined;
      const line = {
        method: req.method,
        route: routePath ? `${req.baseUrl}${routePath}` : undefined,
        path: routePath ? undefined : req.originalUrl.split('?')[0],
        status: res.statusCode,
        duration_ms: Number((process.hrtime.bigint() - started) / 1000n) / 1000,
      };
      const level = res.statusCode >= 500 ? 'error' : req.originalUrl.startsWith('/v1/health') ? 'debug' : 'info';
      // 'finish' fires outside the request's async scope; restore it for the context fields.
      withLogContext({ ...ctx }, () => logger[level](line, 'request completed'));
    });
    next();
  };
}
