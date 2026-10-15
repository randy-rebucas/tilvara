import type { INestApplication } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { HttpErrorFilter } from './infrastructure/http-error.filter.js';
import { correlationIdMiddleware } from './infrastructure/correlation-id.middleware.js';
import { ENV } from './infrastructure/env.provider.js';

/** Shared between main.ts and tests so the test app matches production wiring. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('v1');
  app.use(correlationIdMiddleware);
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
