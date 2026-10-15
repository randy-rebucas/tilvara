import type { Pool } from 'pg';

export interface CreateTenantInput {
  slug: string;
  name: string;
  timezone?: string;
  currency?: string;
}

/**
 * Provision a tenant through the audited SECURITY DEFINER function. This is the only
 * path by which the runtime role can create a tenant row (RLS blocks direct inserts).
 */
export async function createTenant(pool: Pool, input: CreateTenantInput): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT platform_create_tenant($1, $2, $3, $4) AS id',
    [input.slug, input.name, input.timezone ?? 'Asia/Manila', input.currency ?? 'PHP'],
  );
  return rows[0]!.id;
}
