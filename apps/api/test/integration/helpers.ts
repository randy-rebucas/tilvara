import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';
import { ENV } from '../../src/infrastructure/env.provider.js';
import { loadServerEnv, type ServerEnv } from '@1pos/config';

export async function createApp(envOverrides: Partial<ServerEnv> = {}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (Object.keys(envOverrides).length > 0) {
    builder.overrideProvider(ENV).useValue({ ...loadServerEnv(), ...envOverrides });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

export const PASSWORD = 'correct horse battery staple';

export const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

export interface SignedUp {
  userId: string;
  tenantId: string;
  email: string;
  access: string;
  refresh: string;
}

export async function signup(app: INestApplication, prefix = 'shop'): Promise<SignedUp> {
  const slug = uniq(prefix);
  const email = `${slug}@example.ph`;
  const res = await request(app.getHttpServer())
    .post('/v1/auth/signup')
    .send({ email, password: PASSWORD, displayName: `Owner ${slug}`, businessName: `Biz ${slug}`, tenantSlug: slug })
    .expect(201);
  return {
    userId: res.body.user.id,
    tenantId: res.body.activeTenantId,
    email,
    access: res.body.tokens.accessToken,
    refresh: res.body.tokens.refreshToken,
  };
}

/** Schema-owner pool for test arrangement that the app role is (correctly) not allowed to do. */
export function ownerPool(): pg.Pool {
  return new pg.Pool({ connectionString: process.env.TEST_DATABASE_MIGRATOR_URL, max: 2 });
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
