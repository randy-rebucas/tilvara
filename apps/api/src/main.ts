import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { createLogger, LOG_LEVELS, type LogLevel } from '@1pos/observability';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { ENV } from './infrastructure/env.provider.js';
import { PinoNestLogger } from './infrastructure/logging.js';
import type { ServerEnv } from '@1pos/config';

async function bootstrap(): Promise<void> {
  // The env is validated by the ENV provider during module init; the level is needed earlier.
  const requested = process.env.LOG_LEVEL as LogLevel | undefined;
  const logger = createLogger({ service: 'api', level: requested && LOG_LEVELS.includes(requested) ? requested : 'info' });
  const app = await NestFactory.create(AppModule, { logger: new PinoNestLogger(logger) });
  app.use(helmet());
  configureApp(app, logger);
  app.enableShutdownHooks();
  const env = app.get<ServerEnv>(ENV);
  await app.listen(env.API_PORT, '127.0.0.1');
  logger.info({ port: env.API_PORT }, `1POS API listening on http://127.0.0.1:${env.API_PORT}/v1`);
}

void bootstrap();
