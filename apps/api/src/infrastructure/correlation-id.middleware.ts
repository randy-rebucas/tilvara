import { randomUUID } from 'node:crypto';
import { withLogContext } from '@1pos/observability';
import type { NextFunction, Request, Response } from 'express';

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** `receivedAt`: performance.now() when the request arrived, before any guard or pool wait. */
export type CorrelatedRequest = Request & { correlationId?: string; receivedAt?: number };

/**
 * Accept a well-formed client correlation id or mint one; echo it on every response, and open
 * the log scope for the rest of the request (AuthGuard adds tenant/user ids to it).
 */
export function correlationIdMiddleware(req: CorrelatedRequest, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.receivedAt = performance.now();
  req.correlationId = id;
  res.setHeader('X-Correlation-Id', id);
  withLogContext({ correlationId: id }, next);
}
