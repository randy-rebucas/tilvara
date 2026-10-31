import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, idempotencyRecords, sql, type Database } from '@1pos/database';
import type { Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { from, Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/auth-context.js';
import { AppError } from './http-error.filter.js';
import { TenantDb } from './tenant-db.service.js';

export const IDEMPOTENT = 'onepos:idempotent';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETENTION_HOURS = 24;

export interface IdempotentOptions {
  /** Financial endpoints (Phase 2+) require the header; Phase 1 master-data endpoints accept it optionally. */
  required?: boolean;
}

/**
 * Mark a mutating route as idempotent. Never use it on routes whose response contains a
 * secret (e.g. terminal registration) — the response is stored for replay.
 */
export const Idempotent = (options: IdempotentOptions = {}) => SetMetadata(IDEMPOTENT, options);

interface IdempotencyContext {
  scope: string;
  key: string;
  requestHash: string;
  userId: string;
  responseStatus: number;
  consumed: boolean;
}

const storage = new AsyncLocalStorage<IdempotencyContext>();

export class IdempotencyConflict extends Error {
  constructor() {
    super('Concurrent request with the same idempotency key committed first');
    this.name = 'IdempotencyConflict';
  }
}

/** Stable JSON (sorted keys) so semantically identical bodies hash the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Called by TenantService.mutate as the first statement of the business transaction.
 * The INSERT blocks on the unique index while a concurrent duplicate is in flight; once
 * that one commits we get no row back and abort so the interceptor can replay its result.
 */
export async function claimIdempotency(db: Database): Promise<IdempotencyContext | null> {
  const ctx = storage.getStore();
  if (!ctx || ctx.consumed) return null;
  ctx.consumed = true;
  const { rows } = await db.execute<{ id: string }>(sql`
    INSERT INTO idempotency_records (tenant_id, scope, key, user_id, request_hash, response_status, expires_at)
    VALUES (app_current_tenant_id(), ${ctx.scope}, ${ctx.key}, ${ctx.userId}, ${ctx.requestHash}, ${ctx.responseStatus},
            now() + make_interval(hours => ${RETENTION_HOURS}))
    ON CONFLICT (tenant_id, scope, key) DO NOTHING
    RETURNING id`);
  if (!rows[0]) throw new IdempotencyConflict();
  return ctx;
}

/** Answer fields that hold a secret shown once (an API key, a signing secret, a terminal credential). */
export const SECRET_RESPONSE_FIELDS: readonly string[] = ['key', 'secret', 'credential', 'token', 'refreshToken', 'accessToken', 'recoveryCodes', 'password'];

/**
 * The stored answer is kept 24 hours and replayed: one carrying a secret would put it in plain text in
 * `idempotency_records` (audit 47 #3). Such a route must not be @Idempotent; this refuses it outright,
 * rolling the change back, so the mistake shows up in the first test that calls the route.
 */
export function assertStorableResponse(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const found = SECRET_RESPONSE_FIELDS.filter((f) => Object.hasOwn(body, f));
  if (found.length > 0) {
    throw new Error(`An @Idempotent route answered a secret field (${found.join(', ')}); it must not be stored for replay`);
  }
}

/** Store the response in the same transaction as the business change. */
export async function completeIdempotency(db: Database, ctx: IdempotencyContext, body: unknown): Promise<void> {
  assertStorableResponse(body);
  const json = body === undefined ? null : JSON.parse(JSON.stringify(body));
  await db
    .update(idempotencyRecords)
    .set({ responseBody: json })
    .where(and(eq(idempotencyRecords.scope, ctx.scope), eq(idempotencyRecords.key, ctx.key)));
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<IdempotentOptions | undefined>(IDEMPOTENT, context.getHandler());
    if (!options) return next.handle();
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = req.header('idempotency-key');
    if (!key) {
      if (options.required) {
        throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'This operation requires an Idempotency-Key header', HttpStatus.BAD_REQUEST);
      }
      return next.handle();
    }
    if (!UUID.test(key)) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must be a UUID', HttpStatus.BAD_REQUEST);
    const auth = req.auth;
    if (!auth?.tenant) return next.handle();

    const path = req.originalUrl.split('?')[0]!;
    const scope = `${req.method} ${path}`;
    const requestHash = createHash('sha256').update(`${auth.userId}\n${scope}\n${stableStringify(req.body)}`).digest('hex');
    const declared = this.reflector.get<number | undefined>('__httpCode__', context.getHandler());
    const responseStatus = declared ?? (req.method === 'POST' ? 201 : 200);

    const replay = async (): Promise<unknown | undefined> => {
      const [rec] = await this.tenantDb.run(auth, (db) =>
        db
          .select({ requestHash: idempotencyRecords.requestHash, status: idempotencyRecords.responseStatus, body: idempotencyRecords.responseBody })
          .from(idempotencyRecords)
          .where(and(eq(idempotencyRecords.scope, scope), eq(idempotencyRecords.key, key))),
      );
      if (!rec) return undefined;
      if (rec.requestHash !== requestHash) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      res.status(rec.status);
      res.setHeader('Idempotent-Replayed', 'true');
      return rec.body;
    };

    const ctx: IdempotencyContext = { scope, key, requestHash, userId: auth.userId, responseStatus, consumed: false };
    return from(
      (async () => {
        const previous = await replay();
        if (previous !== undefined) return previous;
        try {
          return await new Promise<unknown>((resolve, reject) => {
            storage.run(ctx, () => {
              next.handle().subscribe({ next: resolve, error: reject });
            });
          });
        } catch (e) {
          if (e instanceof IdempotencyConflict) {
            const winner = await replay();
            if (winner !== undefined) return winner;
          }
          throw e;
        }
      })(),
    );
  }
}
