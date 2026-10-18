import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
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
  configureApp(app, logger);
  app.enableShutdownHooks();
  const env = app.get<ServerEnv>(ENV);
  await app.listen(env.API_PORT, env.API_HOST);
  logger.info({ port: env.API_PORT, host: env.API_HOST }, `Tilvara API listening on http://${env.API_HOST}:${env.API_PORT}/v1`);
}

void bootstrap();
