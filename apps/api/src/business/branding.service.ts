import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql, type BrandAssetKind } from '@1pos/database';
import { BRAND_IMAGE_LIMITS, type BrandImageInput, type BrandingUpdateInput } from '@1pos/validation';
import { createHash } from 'node:crypto';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { readImage } from './brand-image.js';
import { BRANDING_FIELDS, readBranding, readBrandImage, type BrandingView } from './branding.js';

/** The public sign-in page's view of a shop: nothing beyond what the page shows. */
export interface PublicShop {
  tenantId: string;
  name: string;
  brandColor: string | null;
  logoSha256: string | null;
  backgroundSha256: string | null;
}

/**
 * How the business presents itself (session 39): the till, the customer display, receipts, the admin's
 * band and the optional public sign-in page. Every member reads it (the till shows it to cashiers);
 * changing it needs tenant.manage.
 */
@Injectable()
export class BrandingService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  get(auth: AuthContext): Promise<BrandingView> {
    return this.read(auth, readBranding);
  }

  update(auth: AuthContext, input: BrandingUpdateInput): Promise<BrandingView> {
    this.assertCan(auth, 'tenant.manage');
    const by = membershipOf(auth);
    return this.mutate(auth, async (db) => {
      // One branding change at a time per business (the row may not exist yet to lock).
      await db.execute(sql`SELECT 1 FROM tenants FOR UPDATE`);
      const before = await readBranding(db);
      const changed = BRANDING_FIELDS.filter((f) => before[f] !== input[f]);
      if (changed.length === 0) return before;
      await db.execute(sql`
        INSERT INTO tenant_branding (tenant_id, display_name, brand_color, receipt_header, receipt_footer, contact_phone, contact_email,
                                     website, facebook, instagram, display_welcome, display_thanks, public_sign_in, updated_by)
        VALUES (${tenantOf(auth).tenantId}, ${input.displayName}, ${input.brandColor}, ${input.receiptHeader}, ${input.receiptFooter},
                ${input.contactPhone}, ${input.contactEmail}, ${input.website}, ${input.facebook}, ${input.instagram},
                ${input.displayWelcome}, ${input.displayThanks}, ${input.publicSignIn}, ${by})
        ON CONFLICT (tenant_id) DO UPDATE SET
          display_name = EXCLUDED.display_name, brand_color = EXCLUDED.brand_color, receipt_header = EXCLUDED.receipt_header,
          receipt_footer = EXCLUDED.receipt_footer, contact_phone = EXCLUDED.contact_phone, contact_email = EXCLUDED.contact_email,
          website = EXCLUDED.website, facebook = EXCLUDED.facebook, instagram = EXCLUDED.instagram,
          display_welcome = EXCLUDED.display_welcome, display_thanks = EXCLUDED.display_thanks,
          public_sign_in = EXCLUDED.public_sign_in, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      // Field names only: the contact details may be a sole proprietor's own phone and email.
      await this.audit(db, auth, 'tenant.branding_updated', 'tenant', tenantOf(auth).tenantId, { fields: changed });
      return readBranding(db);
    });
  }

  /** Sets (or with `data: null` removes) the logo or background; the image it replaces is deleted. */
  setImage(auth: AuthContext, kind: BrandAssetKind, input: BrandImageInput): Promise<BrandingView> {
    this.assertCan(auth, 'tenant.manage');
    const by = membershipOf(auth);
    const upload = input.data === null ? null : checkImage(kind, Buffer.from(input.data, 'base64'));
    const column = sql.raw(kind === 'LOGO' ? 'logo_asset_id' : 'background_asset_id');
    return this.mutate(auth, async (db) => {
      const tenantId = tenantOf(auth).tenantId;
      // Two uploads at once: the second waits, then replaces (and deletes) the first's image.
      await db.execute(sql`SELECT 1 FROM tenants FOR UPDATE`);
      const { rows: [current] } = await db.execute<{ asset_id: string | null }>(sql`SELECT ${column} AS asset_id FROM tenant_branding`);
      const previous = current?.asset_id ?? null;
      if (!upload && !previous) return readBranding(db);
      let assetId: string | null = null;
      if (upload) {
        const { rows: [a] } = await db.execute<{ id: string }>(sql`
          INSERT INTO brand_assets (tenant_id, kind, content_type, bytes, size_bytes, sha256, width, height, created_by)
          VALUES (${tenantId}, ${kind}, ${upload.contentType}, ${upload.bytes}, ${upload.bytes.length}, ${upload.sha256},
                  ${upload.width}, ${upload.height}, ${by})
          RETURNING id`);
        assetId = a!.id;
      }
      await db.execute(sql`
        INSERT INTO tenant_branding (tenant_id, ${column}, updated_by) VALUES (${tenantId}, ${assetId}, ${by})
        ON CONFLICT (tenant_id) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      if (previous) await db.execute(sql`DELETE FROM brand_assets WHERE id = ${previous}`);
      await this.audit(
        db, auth, upload ? 'tenant.branding_image_set' : 'tenant.branding_image_removed', 'tenant', tenantId,
        upload ? { kind, sha256: upload.sha256, sizeBytes: upload.bytes.length, contentType: upload.contentType } : { kind },
      );
      return readBranding(db);
    });
  }

  /** The image's bytes for the admin (its band, the Branding tab). */
  async image(auth: AuthContext, kind: BrandAssetKind) {
    const found = await this.read(auth, (db) => readBrandImage(db, kind));
    if (!found) throw notFound(kind === 'LOGO' ? 'Logo' : 'Background');
    return found;
  }

  /** The public sign-in page's shop, when the business switched the page on. */
  async publicShop(slug: string): Promise<PublicShop> {
    const { rows: [r] } = await this.tenantDb.tx((tx) =>
      tx.client.query<{ tenant_id: string; name: string; display_name: string | null; brand_color: string | null; logo_sha256: string | null; background_sha256: string | null }>(
        'SELECT * FROM auth_public_shop($1)',
        [slug],
      ),
    );
    if (!r) throw notFound('Shop');
    return { tenantId: r.tenant_id, name: r.display_name ?? r.name, brandColor: r.brand_color, logoSha256: r.logo_sha256, backgroundSha256: r.background_sha256 };
  }

  async publicImage(slug: string, kind: BrandAssetKind) {
    const { rows: [r] } = await this.tenantDb.tx((tx) =>
      tx.client.query<{ content_type: string; bytes: Buffer; sha256: string }>('SELECT * FROM auth_public_shop_image($1, $2)', [slug, kind]),
    );
    if (!r) throw notFound(kind === 'LOGO' ? 'Logo' : 'Background');
    return { contentType: r.content_type, bytes: r.bytes, sha256: r.sha256 };
  }
}

/** Only a member's own session writes branding (API keys and support sessions are read-only anyway). */
function membershipOf(auth: AuthContext): string {
  const id = tenantOf(auth).membershipId;
  if (!id) throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN);
  return id;
}

function checkImage(kind: BrandAssetKind, bytes: Buffer) {
  if (bytes.length === 0) throw invalidImage('The file is empty');
  if (bytes.length > BRAND_IMAGE_LIMITS[kind]) {
    throw new AppError('IMAGE_TOO_LARGE', `The ${kind === 'LOGO' ? 'logo' : 'background'} may be ${BRAND_IMAGE_LIMITS[kind] / 1024} KB at most`, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  const info = readImage(bytes);
  if (!info) throw invalidImage('Use a PNG, JPEG or WebP image');
  return { ...info, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const invalidImage = (message: string) => new AppError('IMAGE_INVALID', message, HttpStatus.UNPROCESSABLE_ENTITY);
