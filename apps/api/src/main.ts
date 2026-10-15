import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { ENV } from './infrastructure/env.provider.js';
import type { ServerEnv } from '@1pos/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.use(helmet());
  configureApp(app);
  app.enableShutdownHooks();
  const env = app.get<ServerEnv>(ENV);
  await app.listen(env.API_PORT, '127.0.0.1');
  console.log(`1POS API listening on http://127.0.0.1:${env.API_PORT}/v1`);
}

void bootstrap();
