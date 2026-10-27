import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiBlob, api } from './api';
import { usePublishBrand } from './customer-display';
import { useTill } from './till';

/**
 * The business's look on the till (session 39): its name, colour, logo and background, and the
 * customer display's words. A desktop till reads them from its snapshot (so before sign-in and
 * offline too) and keeps the images in its file; a till in a browser fetches them after sign-in.
 */
export interface TillBrand {
  displayName: string | null;
  brandColor: string | null;
  displayWelcome: string | null;
  displayThanks: string | null;
  /** Object URLs of the images, or null. */
  logoUrl: string | null;
  backgroundUrl: string | null;
}

interface BrandContext {
  brand: TillBrand | null;
  /** Browser mode: read the signed-in business's branding (a desktop till follows its snapshot instead). */
  loadFromServer(): Promise<void>;
  /** Signed out of a browser till: back to Tilvara's own look. */
  clear(): void;
}

const Ctx = createContext<BrandContext>({ brand: null, loadFromServer: async () => {}, clear: () => {} });

export const useBrand = () => useContext(Ctx);

const scale = (hex: string, f: (c: number) => number) =>
  `#${[1, 3, 5].map((i) => Math.round(f(parseInt(hex.slice(i, i + 2), 16))).toString(16).padStart(2, '0')).join('')}`;
/** The hover shade of a brand-coloured button. */
export const darken = (hex: string, amount: number) => scale(hex, (c) => c * (1 - amount));
/** Pale text on a brand-coloured band. */
export const lighten = (hex: string, amount: number) => scale(hex, (c) => c + (255 - c) * amount);

const HEX = /^#[0-9a-f]{6}$/;

/** The brand colour as the till's action colour (band, main buttons, focus), or Tilvara blue when unset. */
export function applyBrandColor(color: string | null | undefined, root: HTMLElement = document.documentElement): void {
  const names = ['--color-blue', '--color-blue-deep', '--color-blue-ink'];
  if (!color || !HEX.test(color)) {
    for (const n of names) root.style.removeProperty(n);
    return;
  }
  root.style.setProperty('--color-blue', color);
  root.style.setProperty('--color-blue-deep', darken(color, 0.2));
  root.style.setProperty('--color-blue-ink', lighten(color, 0.85));
}

const toUrl = (img: { contentType: string; data: string } | null) => {
  if (!img) return null;
  const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: img.contentType }));
};

interface ServerBranding {
  displayName: string | null;
  brandColor: string | null;
  displayWelcome: string | null;
  displayThanks: string | null;
  logo: { sha256: string } | null;
  background: { sha256: string } | null;
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const till = useTill();
  const [brand, setBrand] = useState<TillBrand | null>(null);
  const snapshotAt = till.status?.snapshot?.fetchedAt ?? null;

  // A replaced brand gives its image URLs back.
  useEffect(() => () => {
    if (brand?.logoUrl) URL.revokeObjectURL(brand.logoUrl);
    if (brand?.backgroundUrl) URL.revokeObjectURL(brand.backgroundUrl);
  }, [brand]);

  useEffect(() => applyBrandColor(brand?.brandColor), [brand?.brandColor]);

  // Desktop: whatever the latest snapshot says; images from the till's file (fetched once).
  useEffect(() => {
    const engine = till.engine;
    if (!engine) return;
    let cancelled = false;
    void (async () => {
      const b = await engine.branding();
      if (!b) {
        if (!cancelled) setBrand(null);
        return;
      }
      const [logo, background] = [await engine.brandImage('logo').catch(() => null), await engine.brandImage('background').catch(() => null)];
      if (cancelled) return;
      setBrand({
        displayName: b.displayName, brandColor: b.brandColor, displayWelcome: b.displayWelcome, displayThanks: b.displayThanks,
        logoUrl: toUrl(logo), backgroundUrl: toUrl(background),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [till.engine, snapshotAt]);

  const loadFromServer = useCallback(async () => {
    if (till.engine) return;
    const b = await api<ServerBranding>('GET', '/v1/business/branding').catch(() => null);
    if (!b) return;
    const image = async (kind: 'logo' | 'background', sha: string | undefined) =>
      sha ? apiBlob(`/v1/business/branding/${kind}?v=${sha}`).then((blob) => URL.createObjectURL(blob), () => null) : null;
    setBrand({
      displayName: b.displayName, brandColor: b.brandColor, displayWelcome: b.displayWelcome, displayThanks: b.displayThanks,
      logoUrl: await image('logo', b.logo?.sha256), backgroundUrl: await image('background', b.background?.sha256),
    });
  }, [till.engine]);

  const clear = useCallback(() => {
    if (!till.engine) setBrand(null);
  }, [till.engine]);

  // The customer display follows the till's look (it holds no token and no snapshot of its own).
  usePublishBrand(
    brand && {
      displayName: brand.displayName, brandColor: brand.brandColor, welcome: brand.displayWelcome, thanks: brand.displayThanks,
      logoUrl: brand.logoUrl, backgroundUrl: brand.backgroundUrl,
    },
  );

  const value = useMemo(() => ({ brand, loadFromServer, clear }), [brand, loadFromServer, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
