import { sql } from 'drizzle-orm';
import { boolean, check, customType, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantMemberships } from './identity.js';
import { tenants } from './platform.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const BRAND_ASSET_KINDS = ['LOGO', 'BACKGROUND'] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];

export const BRAND_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type BrandImageType = (typeof BRAND_IMAGE_TYPES)[number];

/**
 * A business's images (logo, background), kept in the database: small (256 KB / 1 MB), backed up and
 * exported with the rest, and served by the API (tills cache them by `sha256`). Never changed; a new
 * upload is a new row, and the one it replaces is deleted once nothing points at it.
 */
export const brandAssets = pgTable(
  'brand_assets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').$type<BrandAssetKind>().notNull(),
    contentType: text('content_type').$type<BrandImageType>().notNull(),
    bytes: bytea('bytes').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('brand_assets_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.createdBy], foreignColumns: [tenantMemberships.tenantId, tenantMemberships.id] }),
    check('brand_assets_kind_check', sql`${t.kind} IN ('LOGO','BACKGROUND')`),
    check('brand_assets_content_type_check', sql`${t.contentType} IN ('image/png','image/jpeg','image/webp')`),
    check('brand_assets_size_check', sql`${t.sizeBytes} = octet_length(${t.bytes}) AND ${t.sizeBytes} <= 1048576`),
    check('brand_assets_sha256_format', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('brand_assets_dimensions_check', sql`${t.width} BETWEEN 1 AND 8192 AND ${t.height} BETWEEN 1 AND 8192`),
    index('brand_assets_tenant_idx').on(t.tenantId, t.kind),
  ],
);

/**
 * How a business presents itself (one row per business; no row = Tilvara's look). Shown on the till,
 * the customer display, receipts (beside, never instead of, the legal names a receipt must print), the
 * admin's band and, when `publicSignIn` is on, a public sign-in page at /s/<slug>. Changing it bumps the
 * catalog version, so tills fetch it with their next snapshot.
 */
export const tenantBranding = pgTable(
  'tenant_branding',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    displayName: text('display_name'),
    /** `#rrggbb`, dark enough for white text (checked by the API). */
    brandColor: text('brand_color'),
    logoAssetId: uuid('logo_asset_id'),
    backgroundAssetId: uuid('background_asset_id'),
    receiptHeader: text('receipt_header'),
    receiptFooter: text('receipt_footer'),
    contactPhone: text('contact_phone'),
    contactEmail: text('contact_email'),
    website: text('website'),
    facebook: text('facebook'),
    instagram: text('instagram'),
    displayWelcome: text('display_welcome'),
    displayThanks: text('display_thanks'),
    publicSignIn: boolean('public_sign_in').notNull().default(false),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.logoAssetId], foreignColumns: [brandAssets.tenantId, brandAssets.id] }),
    foreignKey({ columns: [t.tenantId, t.backgroundAssetId], foreignColumns: [brandAssets.tenantId, brandAssets.id] }),
    foreignKey({ columns: [t.tenantId, t.updatedBy], foreignColumns: [tenantMemberships.tenantId, tenantMemberships.id] }),
    check('tenant_branding_color_format', sql`${t.brandColor} IS NULL OR ${t.brandColor} ~ '^#[0-9a-f]{6}$'`),
  ],
);
