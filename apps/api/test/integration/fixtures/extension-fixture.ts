import { Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import { AppModule } from '../../../src/app.module.js';
import { RequirePermissions, RequiresExtension } from '../../../src/auth/auth-context.js';
import { configureApp } from '../../../src/bootstrap.js';
import { EXTENSION_MANIFESTS, type ServerExtension } from '../../../src/extensions/registry.js';

/**
 * Test-only extensions (ADR-0026): the shipped catalog is empty until the first real extension, so the
 * mechanism is proven with these. `seedExtensionFixtures` writes their catalog and permission rows and
 * lets Growth and Enterprise (not Starter) switch them on; it is idempotent (the test DB is reused).
 */
export const FIXTURE = 'test_fixture';
export const FIXTURE_ADDON = 'test_addon';
export const FIXTURE_WITHDRAWN = 'test_withdrawn';
/** Seeded into `permissions` for the fixture; not in the shared catalog, so auth.test leaves `test_*` codes out. */
export const FIXTURE_PERMISSION = 'test_fixture.use';

/** What `disableBlockers` reports for the fixture; tests set it. */
export const fixtureState = { openRecords: 0, enabledHookRuns: 0 };

export const FIXTURE_MANIFESTS: readonly ServerExtension[] = [
  {
    code: FIXTURE,
    permissions: [FIXTURE_PERMISSION],
    roleTemplates: [{ key: 'fixture_clerk', name: 'Fixture clerk', permissions: ['catalog.read', FIXTURE_PERMISSION] }],
    async onEnable() {
      fixtureState.enabledHookRuns += 1;
    },
    async disableBlockers() {
      return fixtureState.openRecords ? [{ code: 'OPEN_FIXTURE_RECORDS', count: fixtureState.openRecords }] : [];
    },
  },
  { code: FIXTURE_ADDON, requires: [FIXTURE], permissions: [] },
];

/** An extension's own routes: writes need the extension, reads stay open. */
@RequirePermissions('catalog.read')
@RequiresExtension(FIXTURE)
@Controller('test-fixture')
class FixtureController {
  @Get()
  read() {
    return { ok: true };
  }

  @HttpCode(200)
  @Post()
  write() {
    return { ok: true };
  }
}

@Module({ controllers: [FixtureController] })
class FixtureModule {}

export async function seedExtensionFixtures(owner: pg.Pool): Promise<void> {
  await owner.query(
    `INSERT INTO extensions (code, name, description, active) VALUES
       ($1, 'Test fixture', 'Used by the integration tests', true),
       ($2, 'Test add-on', 'Builds on the test fixture', true),
       ($3, 'Test withdrawn', 'No longer offered', false)
     ON CONFLICT (code) DO NOTHING`,
    [FIXTURE, FIXTURE_ADDON, FIXTURE_WITHDRAWN],
  );
  await owner.query(`INSERT INTO permissions (code, description) VALUES ($1, 'Test fixture extension') ON CONFLICT (code) DO NOTHING`, [FIXTURE_PERMISSION]);
  await owner.query(
    `UPDATE plans SET extensions = (SELECT jsonb_agg(DISTINCT x ORDER BY x) FROM jsonb_array_elements_text(extensions || $1::jsonb) AS x)
      WHERE code IN ('growth', 'enterprise')`,
    [JSON.stringify([FIXTURE, FIXTURE_ADDON, FIXTURE_WITHDRAWN])],
  );
}

/** The API with the fixture extensions served and the fixture's routes mounted. */
export async function createFixtureApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, FixtureModule] })
    .overrideProvider(EXTENSION_MANIFESTS)
    .useValue(FIXTURE_MANIFESTS)
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}
