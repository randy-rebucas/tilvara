import type { INestApplication } from '@nestjs/common';
import bodyParser from 'body-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import type { ServerEnv } from '@1pos/config';
import type { Logger } from '@1pos/observability';
import { HttpErrorFilter } from './infrastructure/http-error.filter.js';
import { correlationIdMiddleware } from './infrastructure/correlation-id.middleware.js';
import { ENV } from './infrastructure/env.provider.js';
import { ApiMetrics, httpMetrics } from './infrastructure/metrics.js';
import { PinoNestLogger, requestLogger } from './infrastructure/logging.js';
import { clientIpMiddleware } from './infrastructure/client-ip.js';

/** Shared between main.ts and tests so the test app matches production wiring. */
export function configureApp(app: INestApplication, logger?: Logger): void {
  // First, so every request is timed and counted (unit-test modules without ApiMetrics skip it).
  try {
    app.use(httpMetrics(app.get(ApiMetrics)));
  } catch {
    // no metrics provider
  }
  // The API serves JSON only: nothing may frame or run it (CSP default-src 'none'), HSTS for a year.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.setGlobalPrefix('v1');
  // A product file (up to 2,000 rows) and a brand image are larger than the 100 kB every other route accepts. Parsed here,
  // before Nest's own parser, which then leaves the request alone. Not named `jsonParser`: Nest would take
  // it for its own and register no parser for the other routes.
  const importJson = bodyParser.json({ limit: '2mb' });
  app.use(['/v1/products/import', '/v1/products/import/preview'], function productImportJson(req: Request, res: Response, next: NextFunction) {
    importJson(req, res, next);
  });
  // A logo (256 KB) or background (1 MB) arrives as base64 JSON.
  app.use(['/v1/business/branding/logo', '/v1/business/branding/background'], function brandImageJson(req: Request, res: Response, next: NextFunction) {
    importJson(req, res, next);
  });
  app.use(correlationIdMiddleware);
  if (logger) {
    app.useLogger(new PinoNestLogger(logger));
    app.use(requestLogger(logger));
  }
  app.useGlobalFilters(new HttpErrorFilter());
  let origins: string[] = [];
  try {
    const env = app.get<ServerEnv>(ENV);
    origins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
    // req.ip (per-IP rate limits, logs) believes X-Forwarded-For only from this many proxies.
    if (env.TRUST_PROXY_HOPS > 0) app.getHttpAdapter().getInstance().set('trust proxy', env.TRUST_PROXY_HOPS);
    // The admin's visitors, each in their own per-IP bucket (session 40); ignored without the secret.
    app.use(clientIpMiddleware(env.BFF_SHARED_SECRET));
  } catch {
    // Unit-test modules without the env provider: no CORS.
  }
  if (origins.length > 0) {
    app.enableCors({ origin: origins, exposedHeaders: ['X-Correlation-Id', 'Retry-After'], maxAge: 600 });
  }
}
