import type { CSSProperties } from 'react';
import { darken, lighten } from '@1pos/validation';

/**
 * The business's colour as the band's own (session 39): set on the band element only, so the rest of
 * the admin keeps its denomination colours. The API takes only colours white text reads on.
 */
export function brandVars(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  return { '--color-blue': color, '--color-blue-deep': darken(color, 0.2), '--color-blue-ink': lighten(color, 0.85) } as CSSProperties;
}

/** The business's image through the BFF; the hash makes the URL change with the image (cached for good). */
export const brandImageUrl = (kind: 'logo' | 'background', sha256: string) => `/api/v1/business/branding/${kind}?v=${sha256}`;

/** A shop's image on its public sign-in page (no session). */
export const publicImageUrl = (slug: string, kind: 'logo' | 'background', sha256: string) => `/api/public/shops/${slug}/${kind}?v=${sha256}`;
