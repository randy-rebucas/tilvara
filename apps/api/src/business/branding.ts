import { sql, type BrandAssetKind, type BrandImageType, type Database } from '@1pos/database';

export interface BrandImageView {
  sha256: string;
  contentType: BrandImageType;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface BrandingView {
  displayName: string | null;
  brandColor: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  website: string | null;
  facebook: string | null;
  instagram: string | null;
  displayWelcome: string | null;
  displayThanks: string | null;
  publicSignIn: boolean;
  logo: BrandImageView | null;
  background: BrandImageView | null;
  updatedAt: string | null;
}

/** What a business without a branding row looks like: Tilvara's own look, no messages. */
export const NO_BRANDING: BrandingView = {
  displayName: null,
  brandColor: null,
  receiptHeader: null,
  receiptFooter: null,
  contactPhone: null,
  contactEmail: null,
  website: null,
  facebook: null,
  instagram: null,
  displayWelcome: null,
  displayThanks: null,
  publicSignIn: false,
  logo: null,
  background: null,
  updatedAt: null,
};

/** The editable text fields, in the order the audit row names them. */
export const BRANDING_FIELDS = [
  'displayName', 'brandColor', 'receiptHeader', 'receiptFooter', 'contactPhone', 'contactEmail', 'website',
  'facebook', 'instagram', 'displayWelcome', 'displayThanks', 'publicSignIn',
] as const satisfies readonly (keyof BrandingView)[];

type Row = {
  display_name: string | null;
  brand_color: string | null;
  receipt_header: string | null;
  receipt_footer: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  website: string | null;
  facebook: string | null;
  instagram: string | null;
  display_welcome: string | null;
  display_thanks: string | null;
  public_sign_in: boolean;
  updated_at: string;
  logo: BrandImageView | null;
  background: BrandImageView | null;
};

const image = (alias: string) => sql.raw(
  `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object('sha256', ${alias}.sha256, 'contentType', ${alias}.content_type,
     'width', ${alias}.width, 'height', ${alias}.height, 'sizeBytes', ${alias}.size_bytes) END`,
);

/** The current business's branding (inside its tenant transaction). */
export async function readBranding(db: Database): Promise<BrandingView> {
  const { rows: [r] } = await db.execute<Row>(sql`
    SELECT b.display_name, b.brand_color, b.receipt_header, b.receipt_footer, b.contact_phone, b.contact_email, b.website,
           b.facebook, b.instagram, b.display_welcome, b.display_thanks, b.public_sign_in, b.updated_at,
           ${image('l')} AS logo, ${image('g')} AS background
      FROM tenant_branding b
      LEFT JOIN brand_assets l ON l.tenant_id = b.tenant_id AND l.id = b.logo_asset_id
      LEFT JOIN brand_assets g ON g.tenant_id = b.tenant_id AND g.id = b.background_asset_id`);
  if (!r) return NO_BRANDING;
  return {
    displayName: r.display_name,
    brandColor: r.brand_color,
    receiptHeader: r.receipt_header,
    receiptFooter: r.receipt_footer,
    contactPhone: r.contact_phone,
    contactEmail: r.contact_email,
    website: r.website,
    facebook: r.facebook,
    instagram: r.instagram,
    displayWelcome: r.display_welcome,
    displayThanks: r.display_thanks,
    publicSignIn: r.public_sign_in,
    logo: r.logo,
    background: r.background,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/** The image the business uses as its logo or background, or null. */
export async function readBrandImage(db: Database, kind: BrandAssetKind): Promise<{ contentType: string; bytes: Buffer; sha256: string } | null> {
  const column = sql.raw(kind === 'LOGO' ? 'logo_asset_id' : 'background_asset_id');
  const { rows: [r] } = await db.execute<{ content_type: string; bytes: Buffer; sha256: string }>(sql`
    SELECT a.content_type, a.bytes, a.sha256 FROM tenant_branding b JOIN brand_assets a ON a.tenant_id = b.tenant_id AND a.id = b.${column}`);
  return r ? { contentType: r.content_type, bytes: r.bytes, sha256: r.sha256 } : null;
}

/**
 * The shop's contact details as receipt lines (the till and the server print the same ones): phone,
 * email, website without its scheme, and the social pages.
 */
export function contactLines(b: Pick<BrandingView, 'contactPhone' | 'contactEmail' | 'website' | 'facebook' | 'instagram'>): string[] {
  return [
    b.contactPhone,
    b.contactEmail,
    b.website?.replace(/^https?:\/\//i, '').replace(/\/$/, '') ?? null,
    b.facebook ? `facebook.com/${b.facebook}` : null,
    b.instagram ? `instagram.com/${b.instagram}` : null,
  ].filter((l): l is string => l !== null);
}

/** What a receipt adds from the branding: messages above and below, the contact lines, and the logo. */
export interface ReceiptBranding {
  header: string[];
  footer: string[];
  contact: string[];
  logoSha256: string | null;
}

export function receiptBranding(b: BrandingView): ReceiptBranding {
  const lines = (v: string | null) => (v ? v.split('\n').filter((l) => l.trim() !== '') : []);
  return { header: lines(b.receiptHeader), footer: lines(b.receiptFooter), contact: contactLines(b), logoSha256: b.logo?.sha256 ?? null };
}

/** Answer an image: cached for good under its hash (the URL carries `?v=<sha256>`), never sniffed. */
export function imageHeaders(img: { contentType: string; bytes: Buffer; sha256: string }, cache: 'private' | 'public') {
  return {
    'content-type': img.contentType,
    'content-length': String(img.bytes.length),
    'cache-control': `${cache}, max-age=31536000, immutable`,
    etag: `"${img.sha256}"`,
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
  };
}
