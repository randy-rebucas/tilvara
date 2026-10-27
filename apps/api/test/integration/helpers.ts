import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';
import { ENV } from '../../src/infrastructure/env.provider.js';
import { loadServerEnv, type ServerEnv } from '@1pos/config';
import { PasswordService } from '../../src/auth/password.service.js';
import type { Logger } from '@1pos/observability';

export async function createApp(envOverrides: Partial<ServerEnv> = {}, logger?: Logger): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (Object.keys(envOverrides).length > 0) {
    builder.overrideProvider(ENV).useValue({ ...loadServerEnv(), ...envOverrides });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, logger);
  await app.init();
  // Adversarial tests fire many parallel requests at one server.
  app.getHttpServer().setMaxListeners(160);
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

/** Test prices for the plans (the migrations ship them at 0, which is never billed; ADR-0027). */
export const PLAN_PRICES = { starter: '499.00', growth: '1499.00', enterprise: '4999.00' } as const;

export async function ensurePlanPrices(owner: pg.Pool): Promise<void> {
  for (const [plan, price] of Object.entries(PLAN_PRICES)) {
    await owner.query(
      `SELECT platform_set_plan_price($1, $2, 'tests', 'test plan prices') FROM plans WHERE code = $1 AND monthly_price <> $2::numeric`,
      [plan, price],
    );
  }
}

/** Arrange a member with a system role at a scope (invitation API not built yet). */
export async function addMember(
  owner: pg.Pool,
  tenantId: string,
  roleKey: string,
  scope: { type: 'TENANT' | 'LEGAL_ENTITY' | 'BRANCH' | 'REGISTER'; id: string | null } = { type: 'TENANT', id: null },
): Promise<{ email: string; userId: string; membershipId: string }> {
  const email = `${uniq(roleKey)}@example.ph`;
  const hash = await new PasswordService().hash(PASSWORD);
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const u = await c.query<{ id: string }>('SELECT auth_register_user($1, $2, $3) AS id', [email, roleKey, hash]);
    const m = await c.query<{ id: string }>(
      `INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2) RETURNING id`,
      [tenantId, u.rows[0]!.id],
    );
    await c.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id, scope_type, scope_id)
       SELECT $1, $2, id, $4, $5 FROM roles WHERE tenant_id = $1 AND key = $3`,
      [tenantId, m.rows[0]!.id, roleKey, scope.type, scope.id],
    );
    await c.query('COMMIT');
    return { email, userId: u.rows[0]!.id, membershipId: m.rows[0]!.id };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Run SQL as the schema owner inside a tenant context (FORCE RLS applies to the owner too). */
export async function asOwnerInTenant<T>(owner: pg.Pool, tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export async function loginToken(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  return res.body.tokens.accessToken;
}
