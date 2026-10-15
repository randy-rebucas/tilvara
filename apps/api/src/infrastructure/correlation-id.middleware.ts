import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export type CorrelatedRequest = Request & { correlationId?: string };

/** Accept a well-formed client correlation id or mint one; echo it on every response. */
export function correlationIdMiddleware(req: CorrelatedRequest, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.correlationId = id;
  res.setHeader('X-Correlation-Id', id);
  next();
}
