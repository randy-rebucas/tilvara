import type { INestApplication } from '@nestjs/common';
import { HttpErrorFilter } from './infrastructure/http-error.filter.js';
import { correlationIdMiddleware } from './infrastructure/correlation-id.middleware.js';

/** Shared between main.ts and tests so the test app matches production wiring. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('v1');
  app.use(correlationIdMiddleware);
  app.useGlobalFilters(new HttpErrorFilter());
}
