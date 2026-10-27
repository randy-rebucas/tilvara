import { z } from 'zod';

// ------------------------------------------------------------------ branding (session 39)

/** Empty strings from forms mean "none". */
const blankToNull = <T extends z.ZodType>(s: T) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), s);
const optional = <T extends z.ZodType>(s: T) => blankToNull(s.nullable().optional()).transform((v) => (v ?? null) as z.infer<T> | null);

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Contrast of white text on `#rrggbb` (1–21). The band and the till's buttons print white on the brand colour. */
export function whiteTextContrast(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

/** White text needs 4.5:1 on the brand colour (WCAG AA for body text). */
export const BRAND_COLOR_MIN_CONTRAST = 4.5;

/** `#rrggbb` scaled toward black by `amount` (0–1): the hover shade of a brand-coloured button. */
export function darken(hex: string, amount: number): string {
  const part = (i: number) =>
    Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount))
      .toString(16)
      .padStart(2, '0');
  return `#${part(1)}${part(3)}${part(5)}`;
}

/** `#rrggbb` mixed toward white by `amount` (0–1): pale text on a brand-coloured band. */
export function lighten(hex: string, amount: number): string {
  const part = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(c + (255 - c) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${part(1)}${part(3)}${part(5)}`;
}

export const brandColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, 'Use a colour like #2a5da8')
  .refine((c) => whiteTextContrast(c) >= BRAND_COLOR_MIN_CONTRAST, 'Too light: white text would be hard to read on it');

/** Receipt lines are printed centred on 32–48 columns; a few short lines at most. */
const receiptLines = z
  .string()
  .trim()
  .max(160)
  .refine((v) => v.split(/\r?\n/).length <= 3, 'Three lines at most')
  .transform((v) => v.replace(/\r\n/g, '\n'));

/** A Facebook page or Instagram handle, with or without the @. */
const handle = z
  .string()
  .trim()
  .transform((v) => v.replace(/^@/, ''))
  .pipe(z.string().regex(/^[A-Za-z0-9._-]{1,60}$/, 'Use the page name only: letters, digits, dots, _ or -'));

export const brandingUpdateSchema = z.object({
  /** A shorter name for the till and the customer display; receipts still print the legal names. */
  displayName: optional(z.string().trim().max(40)),
  brandColor: optional(brandColorSchema),
  receiptHeader: optional(receiptLines),
  receiptFooter: optional(receiptLines),
  contactPhone: optional(z.string().trim().regex(/^[0-9+() -]{5,30}$/, 'Use digits, spaces, +, ( ) or -')),
  contactEmail: optional(z.string().trim().toLowerCase().max(254).pipe(z.email())),
  website: optional(
    z
      .string()
      .trim()
      .max(200)
      .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
      .pipe(z.url({ protocol: /^https?$/, hostname: z.regexes.domain })),
  ),
  facebook: optional(handle),
  instagram: optional(handle),
  displayWelcome: optional(z.string().trim().max(80)),
  displayThanks: optional(z.string().trim().max(80)),
  /** A public sign-in page at /s/<slug> with the shop's name and look. Off until the business switches it on. */
  publicSignIn: z.boolean().default(false),
});
export type BrandingUpdateInput = z.infer<typeof brandingUpdateSchema>;

export const BRAND_IMAGE_LIMITS = { LOGO: 256 * 1024, BACKGROUND: 1024 * 1024 } as const;

/** An image as base64 (PNG, JPEG or WebP; the type is read from the bytes), or null to remove it. */
export const brandImageSchema = z.object({
  data: z
    .string()
    .max(Math.ceil((BRAND_IMAGE_LIMITS.BACKGROUND * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Not base64')
    .nullable(),
});
export type BrandImageInput = z.infer<typeof brandImageSchema>;
