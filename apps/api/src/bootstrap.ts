import type { INestApplication } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import type { Logger } from '@1pos/observability';
import { HttpErrorFilter } from './infrastructure/http-error.filter.js';
import { correlationIdMiddleware } from './infrastructure/correlation-id.middleware.js';
import { ENV } from './infrastructure/env.provider.js';
import { PinoNestLogger, requestLogger } from './infrastructure/logging.js';

/** Shared between main.ts and tests so the test app matches production wiring. */
export function configureApp(app: INestApplication, logger?: Logger): void {
  app.setGlobalPrefix('v1');
  app.use(correlationIdMiddleware);
  if (logger) {
    app.useLogger(new PinoNestLogger(logger));
    app.use(requestLogger(logger));
  }
  app.useGlobalFilters(new HttpErrorFilter());
  let origins: string[] = [];
  try {
    origins = app.get<ServerEnv>(ENV).CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  } catch {
    // Unit-test modules without the env provider: no CORS.
  }
  if (origins.length > 0) {
    app.enableCors({ origin: origins, exposedHeaders: ['X-Correlation-Id', 'Retry-After'], maxAge: 600 });
  }
}
