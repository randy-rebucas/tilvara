import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { CorrelatedRequest } from './correlation-id.middleware.js';

/** Domain errors carry a stable machine-readable code (see docs/api/CONVENTIONS.md). */
export class AppError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus,
    readonly details?: Record<string, unknown>,
  ) {
    super(message, status);
  }
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

const TRANSIENT_NET = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
// SQLSTATE: connection exceptions (08…), shutdown/crash/cannot-connect (57P01-03), too many
// connections, statement timeout, serialization failure, deadlock — the transaction did not
// complete as asked, and the same request may be retried with the same Idempotency-Key.
const TRANSIENT_SQL = /^(08...|57P0[123]|53300|57014|40001|40P01)$/;
const TRANSIENT_MSG = /Connection terminated|timeout exceeded when trying to connect|connection error/i;

/** True when the database was unreachable or dropped/aborted the work: answer 503, not 500. */
export function isTransientDbError(e: unknown): boolean {
  for (let err = e as { code?: unknown; message?: unknown; cause?: unknown } | undefined, depth = 0; err && depth < 4; err = err.cause as typeof err, depth++) {
    if (typeof err.code === 'string' && (TRANSIENT_NET.has(err.code) || TRANSIENT_SQL.test(err.code))) return true;
    if (typeof err.message === 'string' && TRANSIENT_MSG.test(err.message)) return true;
  }
  return false;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<CorrelatedRequest>();
    const res = ctx.getResponse<Response>();
    const correlationId = req.correlationId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = exception instanceof AppError ? exception.code : (DEFAULT_CODES[status] ?? 'ERROR');
      const details = exception instanceof AppError ? exception.details : undefined;
      res.locals.errorCode = code; // read by the metrics middleware
      res.status(status).json({ error: { code, message: exception.message, details, correlationId } });
      return;
    }

    // Unknown error: log internally (no request body, no SQL parameters — they may hold PII
    // or token hashes), return a generic message.
    const err = exception as { name?: string; message?: string; cause?: { code?: string } };
    this.logger.error({
      correlationId,
      err: {
        name: err?.name ?? 'unknown',
        message: (err?.message ?? '').split('\nparams:')[0]!.slice(0, 500),
        pgCode: err?.cause?.code,
      },
    });
    if (isTransientDbError(exception)) {
      res.locals.errorCode = 'SERVICE_UNAVAILABLE';
      res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .setHeader('Retry-After', '2')
        .json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Retry the same request.', correlationId } });
      return;
    }
    res.locals.errorCode = 'INTERNAL';
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: { code: 'INTERNAL', message: 'An unexpected error occurred.', correlationId } });
  }
}
