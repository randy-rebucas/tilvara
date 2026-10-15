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
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: { code: 'INTERNAL', message: 'An unexpected error occurred.', correlationId } });
  }
}
