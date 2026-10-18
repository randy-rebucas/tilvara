import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';
export * from './metrics.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Request/job-scoped fields attached to every log line written inside the scope. */
export interface LogContext {
  correlationId?: string;
  tenantId?: string;
  userId?: string;
  [key: string]: string | undefined;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Run `fn` with log context; nested scopes inherit and may add fields. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

/** Add fields to the current scope (e.g. tenant/user once authentication succeeds). No-op outside a scope. */
export function enrichLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

export function currentLogContext(): Readonly<LogContext> | undefined {
  return storage.getStore();
}

const SNAKE: Record<string, string> = { correlationId: 'correlation_id', tenantId: 'tenant_id', userId: 'user_id' };

/** Credentials: never logged. */
const SECRET_KEYS = ['password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'secret', 'credential', 'apiKey', 'authorization', 'cookie'];

/**
 * Personal data (privacy pack, processing register): the field names it travels under in requests,
 * rows and events. Generic keys such as `name` are left out on purpose (product names, error names);
 * a person's name is logged under one of these keys or not at all.
 */
export const PERSONAL_KEYS = [
  'email', 'newEmail', 'displayName', 'fullName', 'customerName', 'beneficiaryName', 'beneficiaries', 'beneficiary',
  'idNumber', 'tin', 'phone', 'address', 'userAgent', 'ip', 'ipAddress', 'remoteAddress', 'recipient',
];

/**
 * Secrets and personal data never reach log sinks, whatever a call site passes, at the top level or
 * up to three objects deep. Request bodies are not logged at all; these paths are the safety net
 * for metadata objects (`logger-redaction` tests every key at every depth).
 */
export const REDACT_PATHS = [
  ...[...SECRET_KEYS, ...PERSONAL_KEYS].flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]),
  'req.headers.authorization', 'req.headers.cookie',
];

/** `r***@example.com`: enough to tell two mails apart in a dev log, not enough to name the person. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email[0]}***${email.slice(at)}` : '***';
}

export interface CreateLoggerOptions {
  service: string;
  level?: LogLevel;
  /** Defaults to stdout; tests pass a capturing stream. */
  destination?: DestinationStream;
}

/**
 * JSON logger: ISO time, service name, the active LogContext (snake_case keys) and, when an
 * OpenTelemetry SDK has registered a tracer and a span is active, `trace_id`/`span_id` so logs
 * join traces. Without an SDK the OTel API is a no-op and adds nothing.
 */
export function createLogger({ service, level = 'info', destination }: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    mixin() {
      const out: Record<string, string> = {};
      const ctx = storage.getStore();
      if (ctx) {
        for (const [k, v] of Object.entries(ctx)) if (v !== undefined) out[SNAKE[k] ?? k] = v;
      }
      const span = trace.getActiveSpan()?.spanContext();
      if (span && span.traceId !== '00000000000000000000000000000000') {
        out.trace_id = span.traceId;
        out.span_id = span.spanId;
      }
      return out;
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
