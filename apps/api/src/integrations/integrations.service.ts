import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { ServerEnv } from '@1pos/config';
import {
  and,
  apiKeys,
  desc,
  eq,
  isPublicAddress,
  newSigningSalt,
  sql,
  users,
  webhookDeliveries,
  webhookEndpoints,
  webhookSecret,
  WEBHOOK_PING,
  type Database,
} from '@1pos/database';
import type { CreateApiKeyInput, CreateWebhookInput, UpdateWebhookInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertFeature } from '../billing/entitlements.js';
import { dbNow } from '../common/clock.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { unprocessable } from '../tax/tax.service.js';

/** The SHA-256 a key is stored and looked up by (the whole key, prefix included). */
export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');
/** `tlv_<prefix>_<secret>`: the prefix finds the row, the hash of the whole key proves it. */
export const API_KEY_FORMAT = /^tlv_([a-z0-9]{10})_([A-Za-z0-9_-]{43})$/;

/**
 * API keys and webhooks (session 20, SPEC §6.11, ADR-0019). Managed with `integrations.manage` (a
 * privileged permission: two-step sign-in), on plans that include `api_access`. Keys and secrets are
 * shown once; the database keeps only a key's hash, and no webhook secret at all.
 */
@Injectable()
export class IntegrationsService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {
    super(tenantDb);
  }

  private async guard(db: Database, auth: AuthContext) {
    this.assertCan(auth, 'integrations.manage');
    await assertFeature(db, 'api_access');
  }

  // ---------------------------------------------------------------- API keys

  listKeys(auth: AuthContext) {
    return this.read(auth, async (db) => {
      this.assertCan(auth, 'integrations.manage');
      const rows = await db
        .select({ k: { id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, createdAt: apiKeys.createdAt, expiresAt: apiKeys.expiresAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt }, createdByName: users.displayName })
        .from(apiKeys)
        .leftJoin(users, eq(users.id, apiKeys.createdBy))
        .orderBy(desc(apiKeys.createdAt));
      return { data: rows.map((r) => ({ ...r.k, createdByName: r.createdByName })) };
    });
  }

  /** A new read-only key. The key is in this answer only; afterwards just its prefix is shown. */
  createKey(auth: AuthContext, input: CreateApiKeyInput) {
    return this.mutate(auth, async (db) => {
      await this.guard(db, auth);
      if (input.expiresAt && new Date(input.expiresAt).getTime() <= (await dbNow(db)).getTime()) {
        throw unprocessable('EXPIRY_IN_PAST', 'A key must expire in the future', { path: ['expiresAt'] });
      }
      const prefix = randomBytes(8).toString('hex').slice(0, 10);
      const key = `tlv_${prefix}_${randomBytes(32).toString('base64url')}`;
      const [row] = await db
        .insert(apiKeys)
        .values({ tenantId: tenantOf(auth).tenantId, name: input.name, prefix, keyHash: hashApiKey(key), scopes: [...input.scopes], createdBy: auth.userId, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null })
        .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, createdAt: apiKeys.createdAt, expiresAt: apiKeys.expiresAt });
      await this.audit(db, auth, 'api_key.created', 'api_key', row!.id, { name: input.name, prefix, scopes: input.scopes });
      return { ...row!, key };
    });
  }

  revokeKey(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      this.assertCan(auth, 'integrations.manage');
      const [row] = await db.select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt, prefix: apiKeys.prefix }).from(apiKeys).where(eq(apiKeys.id, id));
      if (!row) throw notFound('API key');
      if (!row.revokedAt) {
        await db.update(apiKeys).set({ revokedAt: sql`now()`, revokedBy: auth.userId }).where(eq(apiKeys.id, id));
        await this.audit(db, auth, 'api_key.revoked', 'api_key', id, { prefix: row.prefix });
      }
      return { id, revoked: true };
    }, { allowReadOnlyBusiness: true });
  }

  // ---------------------------------------------------------------- webhooks

  /**
   * An endpoint must be https on a public host (no request forgery into the hosting network); the
   * worker checks the resolved address again at each delivery. Development may allow http and
   * private hosts (WEBHOOK_ALLOW_INSECURE).
   */
  private assertUrl(url: string) {
    if (this.env.WEBHOOK_ALLOW_INSECURE) return;
    const u = new URL(url);
    if (u.protocol !== 'https:') throw unprocessable('WEBHOOK_URL_INSECURE', 'Use an https address', { path: ['url'] });
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || (isIP(host) && !isPublicAddress(host))) {
      throw unprocessable('WEBHOOK_URL_PRIVATE', 'The address must be reachable on the internet', { path: ['url'] });
    }
  }

  listWebhooks(auth: AuthContext) {
    return this.read(auth, async (db) => {
      this.assertCan(auth, 'integrations.manage');
      const rows = await db.select().from(webhookEndpoints).orderBy(desc(webhookEndpoints.createdAt));
      const { rows: stats } = await db.execute<{ endpoint_id: string; pending: number; dead: number; last_delivered: string | null }>(sql`
        SELECT endpoint_id, count(*) FILTER (WHERE status IN ('PENDING','DELIVERING'))::int AS pending, count(*) FILTER (WHERE status = 'DEAD')::int AS dead,
               max(delivered_at)::text AS last_delivered
          FROM webhook_deliveries GROUP BY 1`);
      return {
        data: rows.map((w) => {
          const s = stats.find((x) => x.endpoint_id === w.id);
          return { ...this.endpointView(w), pending: s?.pending ?? 0, dead: s?.dead ?? 0, lastDeliveredAt: s?.last_delivered ?? null };
        }),
      };
    });
  }

  /** A new endpoint and its signing secret, shown in this answer only. */
  createWebhook(auth: AuthContext, input: CreateWebhookInput) {
    this.assertUrl(input.url);
    return this.mutate(auth, async (db) => {
      await this.guard(db, auth);
      const salt = newSigningSalt();
      const [row] = await db
        .insert(webhookEndpoints)
        .values({ tenantId: tenantOf(auth).tenantId, url: input.url, description: input.description ?? null, topics: [...input.topics], signingSalt: salt, createdBy: auth.userId })
        .returning();
      await this.audit(db, auth, 'webhook.created', 'webhook_endpoint', row!.id, { host: new URL(input.url).host, topics: input.topics });
      return { ...this.endpointView(row!), secret: webhookSecret(this.env.WEBHOOK_SIGNING_KEY, row!.id, salt) };
    });
  }

  updateWebhook(auth: AuthContext, id: string, input: UpdateWebhookInput) {
    if (input.url) this.assertUrl(input.url);
    return this.mutate(auth, async (db) => {
      await this.loadEndpoint(db, auth, id);
      if (input.enabled !== false) await assertFeature(db, 'api_access');
      const [row] = await db
        .update(webhookEndpoints)
        .set({ ...input, ...(input.topics && { topics: [...input.topics] }), updatedAt: sql`now()` })
        .where(eq(webhookEndpoints.id, id))
        .returning();
      await this.audit(db, auth, 'webhook.updated', 'webhook_endpoint', id, { fields: Object.keys(input), ...(input.enabled !== undefined && { enabled: input.enabled }) });
      return this.endpointView(row!);
    });
  }

  /** A new secret; the old one stops working at once (deliveries already queued are signed with the new one). */
  rotateSecret(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      await this.loadEndpoint(db, auth, id);
      const salt = newSigningSalt();
      await db.update(webhookEndpoints).set({ signingSalt: salt, updatedAt: sql`now()` }).where(eq(webhookEndpoints.id, id));
      await this.audit(db, auth, 'webhook.secret_rotated', 'webhook_endpoint', id);
      return { id, secret: webhookSecret(this.env.WEBHOOK_SIGNING_KEY, id, salt) };
    });
  }

  /** Queue a `webhook.ping` for this endpoint (the worker sends it like any delivery). */
  ping(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const endpoint = await this.loadEndpoint(db, auth, id);
      await assertFeature(db, 'api_access');
      const [row] = await db
        .insert(webhookDeliveries)
        .values({ tenantId: endpoint.tenantId, endpointId: id, topic: WEBHOOK_PING, payload: { endpointId: id, requestedBy: auth.userId }, maxAttempts: 1 })
        .returning();
      await this.audit(db, auth, 'webhook.ping', 'webhook_endpoint', id, { deliveryId: row!.id });
      return this.deliveryView(row!);
    });
  }

  deliveries(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      await this.loadEndpoint(db, auth, id);
      const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, id)).orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id)).limit(100);
      return { data: rows.map((d) => this.deliveryView(d)) };
    });
  }

  /** Send a DEAD delivery again (after the receiver is fixed): attempts start over. */
  retryDelivery(auth: AuthContext, deliveryId: string) {
    return this.mutate(auth, async (db) => {
      this.assertCan(auth, 'integrations.manage');
      const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).for('update');
      if (!d) throw notFound('Delivery');
      if (d.status !== 'DEAD') throw new AppError('DELIVERY_NOT_DEAD', 'Only a delivery that gave up can be sent again', HttpStatus.CONFLICT, { status: d.status });
      await assertFeature(db, 'api_access');
      const [row] = await db
        .update(webhookDeliveries)
        .set({ status: 'PENDING', attempts: 0, availableAt: sql`now()`, lastError: null })
        .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, 'DEAD')))
        .returning();
      await this.audit(db, auth, 'webhook.delivery_retried', 'webhook_endpoint', d.endpointId, { deliveryId });
      return this.deliveryView(row!);
    });
  }

  private async loadEndpoint(db: Database, auth: AuthContext, id: string) {
    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    if (!row) throw notFound('Webhook');
    this.assertCan(auth, 'integrations.manage');
    return row;
  }

  private endpointView(w: typeof webhookEndpoints.$inferSelect) {
    return { id: w.id, url: w.url, description: w.description, topics: w.topics, enabled: w.enabled, createdAt: w.createdAt, updatedAt: w.updatedAt };
  }

  private deliveryView(d: typeof webhookDeliveries.$inferSelect) {
    return {
      id: d.id, endpointId: d.endpointId, eventId: d.eventId, topic: d.topic, status: d.status, attempts: d.attempts, maxAttempts: d.maxAttempts,
      lastStatusCode: d.lastStatusCode, lastError: d.lastError, availableAt: d.availableAt, deliveredAt: d.deliveredAt, createdAt: d.createdAt,
    };
  }
}
