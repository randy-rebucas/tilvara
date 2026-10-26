import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql, type Database } from '@1pos/database';
import { dependentsOf, missingRequirements, type RoleTemplate } from '@1pos/validation';
import { addRoleTemplates } from '../auth/role-templates.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { EXTENSION_MANIFESTS, type ServerExtension } from './registry.js';

type CatalogRow = {
  code: string;
  name: string;
  description: string;
  active: boolean;
  state_id: string | null;
  enabled: boolean;
  allowed: boolean;
  plan_code: string | null;
};

/** The built-in roles that hold every base code; they also get every code of an extension switched on. */
const FULL_ROLES = ['owner', 'admin'];

/**
 * Extensions (ADR-0026): the catalog as this business sees it, and switching one on or off
 * (`tenant.manage`). Switching off keeps the extension's records, roles and grants, so switching it
 * back on loses nothing; while off, its writes are refused (`@RequiresExtension`, `assertExtension`).
 */
@Injectable()
export class ExtensionsService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(EXTENSION_MANIFESTS) private readonly manifests: readonly ServerExtension[],
  ) {
    super(tenantDb);
  }

  list(auth: AuthContext) {
    this.assertCan(auth, 'tenant.manage');
    return this.read(auth, async (db) => {
      const rows = await catalog(db);
      const enabled = rows.filter((r) => r.enabled).map((r) => r.code);
      return rows.filter((r) => r.active || r.enabled).map((r) => this.view(r, enabled));
    });
  }

  enable(auth: AuthContext, code: string) {
    this.assertCan(auth, 'tenant.manage');
    return this.mutate(auth, async (db) => {
      const { row, enabled } = await this.locked(db, code);
      if (row.enabled) return this.view(row, enabled);
      if (!row.allowed) {
        throw new AppError('ENTITLEMENT_REQUIRED', `Your ${row.plan_code ?? ''} plan does not include the ${code} extension`, HttpStatus.FORBIDDEN, {
          extension: code,
          plan: row.plan_code,
        });
      }
      const manifest = this.manifest(code);
      const missing = manifest ? missingRequirements(manifest, enabled) : [];
      if (missing.length) {
        throw new AppError('EXTENSION_REQUIRES', 'Switch on the extensions this one builds on first', HttpStatus.CONFLICT, { extension: code, missing });
      }
      const tenantId = tenantOf(auth).tenantId;
      const { rows: saved } = await db.execute<{ id: string }>(sql`
        INSERT INTO tenant_extensions (tenant_id, extension_code, enabled, changed_by)
        VALUES (${tenantId}, ${code}, true, ${member(auth)})
        ON CONFLICT (tenant_id, extension_code) DO UPDATE SET enabled = true, changed_by = EXCLUDED.changed_by, changed_at = now()
        RETURNING id`);
      const stateId = saved[0]!.id;
      const rolesAdded = [...(await addRoleTemplates(db, tenantId, (manifest?.roleTemplates ?? []) as readonly RoleTemplate[])).keys()];
      if (manifest?.permissions.length) {
        // Codes match ^[a-z0-9_.]+$ (manifest test), so a comma list is safe to split.
        await db.execute(sql`
          INSERT INTO role_permissions (tenant_id, role_id, permission_code)
          SELECT r.tenant_id, r.id, p.code
            FROM roles r CROSS JOIN unnest(string_to_array(${manifest.permissions.join(',')}, ',')) AS p(code)
           WHERE r.is_system AND r.archived_at IS NULL AND r.key IN (${sql.join(FULL_ROLES.map((k) => sql`${k}`), sql`, `)})
          ON CONFLICT DO NOTHING`);
      }
      await manifest?.onEnable?.(db, auth);
      await this.audit(db, auth, 'tenant.extension_enabled', 'tenant_extension', stateId, { extension: code, rolesAdded });
      await emitEvent(db, { tenantId, topic: 'extension.enabled', payload: { extension: code }, correlationId: auth.correlationId ?? null });
      return this.view({ ...row, enabled: true, state_id: stateId }, [...enabled, code]);
    });
  }

  disable(auth: AuthContext, code: string) {
    this.assertCan(auth, 'tenant.manage');
    return this.mutate(auth, async (db) => {
      const { row, enabled } = await this.locked(db, code);
      if (!row.enabled) return this.view(row, enabled);
      const dependents = dependentsOf(code, enabled, this.manifests);
      if (dependents.length) {
        throw new AppError('EXTENSION_REQUIRED_BY', 'Switch off the extensions that build on this one first', HttpStatus.CONFLICT, {
          extension: code,
          dependents,
        });
      }
      const blockers = (await this.manifest(code)?.disableBlockers?.(db)) ?? [];
      if (blockers.length) {
        throw new AppError('EXTENSION_IN_USE', 'Finish the open records of this extension before switching it off', HttpStatus.CONFLICT, {
          extension: code,
          blockers,
        });
      }
      await db.execute(sql`UPDATE tenant_extensions SET enabled = false, changed_by = ${member(auth)}, changed_at = now() WHERE id = ${row.state_id}`);
      await this.audit(db, auth, 'tenant.extension_disabled', 'tenant_extension', row.state_id!, { extension: code });
      await emitEvent(db, { tenantId: tenantOf(auth).tenantId, topic: 'extension.disabled', payload: { extension: code }, correlationId: auth.correlationId ?? null });
      return this.view({ ...row, enabled: false }, enabled.filter((c) => c !== code));
    });
  }

  private manifest(code: string): ServerExtension | undefined {
    return this.manifests.find((m) => m.code === code);
  }

  /**
   * One change at a time per business, so two extensions that depend on each other cannot cross. An
   * extension withdrawn from the catalog is not found, unless the business still has it on (it may switch it off).
   */
  private async locked(db: Database, code: string) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(app_current_tenant_id()::text || ':extensions'))`);
    const rows = await catalog(db);
    const row = rows.find((r) => r.code === code);
    if (!row || (!row.active && !row.enabled)) throw notFound('Extension');
    return { row, enabled: rows.filter((r) => r.enabled).map((r) => r.code) };
  }

  private view(r: CatalogRow, enabled: readonly string[]) {
    const manifest = this.manifest(r.code);
    return {
      code: r.code,
      name: r.name,
      description: r.description,
      enabled: r.enabled,
      allowedByPlan: r.allowed,
      usable: r.enabled && r.active && r.allowed,
      requires: [...(manifest?.requires ?? [])],
      missing: manifest ? missingRequirements(manifest, enabled) : [],
    };
  }
}

/** Who switched it: a member (support sessions and API keys never write). */
function member(auth: AuthContext): string {
  const id = tenantOf(auth).membershipId;
  if (!id) throw new AppError('FORBIDDEN', 'Only a member of the business can do this', HttpStatus.FORBIDDEN);
  return id;
}

async function catalog(db: Database): Promise<CatalogRow[]> {
  const { rows } = await db.execute<CatalogRow>(sql`
    SELECT e.code, e.name, e.description, e.active, te.id AS state_id, coalesce(te.enabled, false) AS enabled,
           coalesce(p.extensions ? e.code, false) AS allowed, s.plan_code
      FROM extensions e
      LEFT JOIN tenant_extensions te ON te.extension_code = e.code
      LEFT JOIN subscriptions s ON true
      LEFT JOIN plans p ON p.code = s.plan_code
     ORDER BY e.code`);
  return rows;
}
