'use client';

import { useEffect, useRef, useState } from 'react';
import { BRAND_COLOR_MIN_CONTRAST, BRAND_IMAGE_LIMITS, isSubdomainSlug, whiteTextContrast } from '@1pos/validation';
import { FormError, TextField } from '@/components/fields';
import { Note } from '@/components/note';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import type { Branding } from '@/lib/api';
import { brandImageUrl, brandVars } from '@/lib/brand';

const TILVARA_BLUE = '#2a5da8';
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The file's bytes as base64 (what the API takes), without the data-URL prefix. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Logo and background: each saved as soon as it is chosen; the band and the till follow. */
export function BrandImages({ branding, canEdit }: { branding: Branding; canEdit: boolean }) {
  return (
    <div className="mt-4 grid gap-5 sm:grid-cols-2">
      <ImagePicker kind="logo" image={branding.logo} canEdit={canEdit} />
      <ImagePicker kind="background" image={branding.background} canEdit={canEdit} />
    </div>
  );
}

function ImagePicker({ kind, image, canEdit }: { kind: 'logo' | 'background'; image: Branding['logo']; canEdit: boolean }) {
  const { t } = useT();
  const { pending, submit, error, setError } = useSubmit();
  const input = useRef<HTMLInputElement>(null);
  const limit = BRAND_IMAGE_LIMITS[kind === 'logo' ? 'LOGO' : 'BACKGROUND'];
  const tooLarge: MessageKey = kind === 'logo' ? 'brand.logoTooLarge' : 'brand.backgroundTooLarge';
  const label = t(kind === 'logo' ? 'brand.logo' : 'brand.background');

  async function choose(file: File | undefined) {
    if (!file) return;
    if (file.size > limit) {
      setError({ code: 'IMAGE_TOO_LARGE', message: t(tooLarge), status: 422 });
      return;
    }
    await submit('PUT', `/api/v1/business/branding/${kind}`, { data: await readBase64(file) });
    if (input.current) input.current.value = '';
  }

  const message =
    error?.code === 'IMAGE_TOO_LARGE' ? t(tooLarge) : error?.code === 'IMAGE_INVALID' ? t('brand.imageInvalid') : error?.message;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[0.875rem] font-semibold">{label}</span>
      <div
        className={`flex items-center justify-center overflow-hidden rounded-[3px] border border-hair bg-paper ${kind === 'logo' ? 'h-28' : 'h-28 sm:h-36'}`}
      >
        {image ? (
          // A small image through the BFF, cached by its hash.
          <img
            src={brandImageUrl(kind, image.sha256)}
            alt={label}
            className={kind === 'logo' ? 'max-h-24 max-w-[80%] object-contain' : 'h-full w-full object-cover'}
          />
        ) : (
          <span className="text-[0.875rem] text-muted">{t('brand.noImage')}</span>
        )}
      </div>
      <p className="hint">{t(kind === 'logo' ? 'brand.logoHint' : 'brand.backgroundHint')}</p>
      {image && (
        <p className="text-[0.8125rem] text-muted tabular-nums">
          {t('brand.imageSize', { w: image.width, h: image.height, kb: Math.max(1, Math.round(image.sizeBytes / 1024)) })}
        </p>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            id={`brand-${kind}-file`}
            onChange={(e) => void choose(e.currentTarget.files?.[0])}
            disabled={pending}
          />
          <label htmlFor={`brand-${kind}-file`} className={`btn ${pending ? 'pointer-events-none opacity-60' : ''}`}>
            {pending ? t('brand.uploading') : image ? t('brand.replace') : t('brand.choose')}
          </label>
          {image && (
            <button type="button" className="btn btn-danger" disabled={pending} onClick={() => void submit('PUT', `/api/v1/business/branding/${kind}`, { data: null })}>
              {t('brand.remove')}
            </button>
          )}
        </div>
      )}
      <FormError message={message} />
    </div>
  );
}

type Fields = Omit<Branding, 'logo' | 'background' | 'updatedAt' | 'publicSignIn'>;
const TEXT_FIELDS: (keyof Fields)[] = [
  'displayName', 'brandColor', 'receiptHeader', 'receiptFooter', 'contactPhone', 'contactEmail', 'website',
  'facebook', 'instagram', 'displayWelcome', 'displayThanks',
];

/** Everything but the images, saved together; previews follow what is typed. */
export function BrandingForm({ branding, businessName, slug, shopDomain, canEdit }: { branding: Branding; businessName: string; slug: string; shopDomain: string | null; canEdit: boolean }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const [done, setDone] = useState(false);
  // Suggested receipt messages: filled in until the business first saves its branding, then one press away.
  const suggested = { receiptHeader: t('brand.defaultHeader'), receiptFooter: t('brand.defaultFooter') };
  const [values, setValues] = useState<Record<keyof Fields, string>>(() => {
    const saved = Object.fromEntries(TEXT_FIELDS.map((k) => [k, branding[k] ?? ''])) as Record<keyof Fields, string>;
    return branding.updatedAt === null ? { ...saved, ...suggested } : saved;
  });
  const useSuggested = (k: keyof typeof suggested) =>
    canEdit && values[k] !== suggested[k] ? (
      <button type="button" className="text-[0.8125rem] font-semibold text-blue underline" onClick={() => { setDone(false); setValues((v) => ({ ...v, [k]: suggested[k] })); }}>
        {t('brand.useSuggested')}
      </button>
    ) : null;
  const [publicSignIn, setPublicSignIn] = useState(branding.publicSignIn);
  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setDone(false);
    setValues((v) => ({ ...v, [k]: e.target.value }));
  };

  const color = values.brandColor.trim();
  const colorValid = color === '' || HEX.test(color);
  const colorReadable = color === '' || (colorValid && whiteTextContrast(color.toLowerCase()) >= BRAND_COLOR_MIN_CONTRAST);
  const colorError = !colorValid ? t('brand.colorFormat') : !colorReadable ? t('brand.colorTooLight') : fieldError('brandColor') ? t('brand.colorTooLight') : undefined;
  const lines = (v: string) => v.split('\n').map((l) => l.trim()).filter(Boolean);
  const contact = [
    values.contactPhone, values.contactEmail, values.website.replace(/^https?:\/\//i, '').replace(/\/$/, ''),
    values.facebook && `facebook.com/${values.facebook.replace(/^@/, '')}`, values.instagram && `instagram.com/${values.instagram.replace(/^@/, '')}`,
  ].map((l) => l.trim()).filter(Boolean);
  // The full address needs the browser's origin: read after hydration, so server and client render the same first.
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const signInUrl = `${origin}/s/${slug}`;
  // The business's own address (session 40), where hosting gives shops a subdomain and the slug can be one.
  const [ownUrl, setOwnUrl] = useState<string | null>(null);
  useEffect(() => {
    if (shopDomain && isSubdomainSlug(slug)) setOwnUrl(`${window.location.protocol}//${slug}.${shopDomain}${window.location.port ? `:${window.location.port}` : ''}`);
  }, [shopDomain, slug]);
  const shownName = values.displayName.trim() || businessName;

  return (
    <form
      className="flex flex-col gap-6"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (!colorValid || !colorReadable) return;
        setDone(false);
        const r = await submit('PUT', '/api/v1/business/branding', { ...values, brandColor: color.toLowerCase(), publicSignIn });
        if (r.ok) setDone(true);
      }}
    >
      <fieldset disabled={!canEdit} className="contents">
        <Note className="px-5 py-5">
          <h2 className="text-[1.0625rem] font-semibold">{t('brand.look')}</h2>
          <div className="form-grid mt-4">
            <TextField
              span="half"
              label={t('brand.displayName')}
              name="displayName"
              value={values.displayName}
              onChange={set('displayName')}
              maxLength={40}
              placeholder={businessName}
              hint={t('brand.displayNameHint')}
              error={fieldError('displayName')}
            />
            <div className="field span-half">
              <label htmlFor="brand-color">{t('brand.color')}</label>
              <div className="flex items-center gap-2">
                <input
                  aria-label={t('brand.colorPicker')}
                  type="color"
                  className="h-10 w-12 shrink-0 cursor-pointer rounded-[3px] border border-hair bg-white p-1"
                  value={colorValid && color ? color.toLowerCase() : TILVARA_BLUE}
                  onChange={(e) => {
                    setDone(false);
                    setValues((v) => ({ ...v, brandColor: e.target.value }));
                  }}
                />
                <input
                  id="brand-color"
                  name="brandColor"
                  className="input font-mono"
                  value={values.brandColor}
                  onChange={set('brandColor')}
                  placeholder={TILVARA_BLUE}
                  maxLength={7}
                  aria-invalid={colorError ? true : undefined}
                  aria-describedby="brand-color-hint"
                />
              </div>
              <p id="brand-color-hint" className={`hint ${colorError ? 'text-red!' : ''}`}>{colorError ?? t('brand.colorHint')}</p>
            </div>
          </div>
          {/* The band as the admin and the till will show it. */}
          <div className="mt-4">
            <span className="text-[0.8125rem] font-semibold text-muted">{t('brand.preview')}</span>
            <div
              data-testid="brand-band-preview"
              className="band mt-1 flex h-12 items-center gap-3 rounded-[3px] px-4 text-white"
              style={brandVars(colorValid && colorReadable && color ? color.toLowerCase() : null)}
            >
              <span className="truncate font-bold tracking-[0.02em]">{shownName}</span>
              <span className="btn btn-primary ml-auto pointer-events-none border border-white/40">{t('brand.previewButton')}</span>
            </div>
          </div>
        </Note>

        <Note className="px-5 py-5">
          <h2 className="text-[1.0625rem] font-semibold">{t('brand.receipts')}</h2>
          <p className="mt-1 text-[0.875rem] text-muted">{t('brand.receiptsLede')}</p>
          <div className="mt-4 grid gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
            <div className="form-grid content-start">
              <TextArea label={t('brand.receiptHeader')} name="receiptHeader" value={values.receiptHeader} onChange={set('receiptHeader')} hint={t('brand.linesHint')} error={fieldError('receiptHeader')} action={useSuggested('receiptHeader')} />
              <TextArea label={t('brand.receiptFooter')} name="receiptFooter" value={values.receiptFooter} onChange={set('receiptFooter')} hint={t('brand.footerHint')} error={fieldError('receiptFooter')} action={useSuggested('receiptFooter')} />
              <TextField span="half" label={t('brand.phone')} name="contactPhone" type="tel" value={values.contactPhone} onChange={set('contactPhone')} maxLength={30} error={fieldError('contactPhone')} />
              <TextField span="half" label={t('brand.email')} name="contactEmail" type="email" value={values.contactEmail} onChange={set('contactEmail')} maxLength={254} error={fieldError('contactEmail')} />
              <TextField label={t('brand.website')} name="website" value={values.website} onChange={set('website')} maxLength={200} placeholder="www.example.ph" error={fieldError('website') && t('brand.websiteInvalid')} />
              <TextField span="half" label={t('brand.facebook')} name="facebook" value={values.facebook} onChange={set('facebook')} maxLength={61} placeholder="yourpage" hint={t('brand.handleHint')} error={fieldError('facebook') && t('brand.handleInvalid')} />
              <TextField span="half" label={t('brand.instagram')} name="instagram" value={values.instagram} onChange={set('instagram')} maxLength={61} placeholder="yourshop" hint={t('brand.instagramHint')} error={fieldError('instagram') && t('brand.handleInvalid')} />
            </div>
            {/* What the top and bottom of a receipt will read (the legal names and figures in between are fixed). */}
            <div aria-label={t('brand.receiptPreview')} role="group" className="self-start rounded-[3px] border border-hair bg-white px-4 py-4 text-center font-mono text-[0.75rem] leading-[1.45] text-ink">
              {lines(values.receiptHeader).map((l, i) => <p key={`h${i}`} className="font-semibold">{l}</p>)}
              <p className="mt-1">{t('brand.previewLegal')}</p>
              <p className="my-2 border-y border-dashed border-hair py-2 text-muted">{t('brand.previewItems')}</p>
              {lines(values.receiptFooter).map((l, i) => <p key={`f${i}`}>{l}</p>)}
              {contact.length > 0 && <div className="mt-2 text-muted">{contact.map((l, i) => <p key={`c${i}`} className="break-all">{l}</p>)}</div>}
            </div>
          </div>
        </Note>

        <Note className="px-5 py-5">
          <h2 className="text-[1.0625rem] font-semibold">{t('brand.display')}</h2>
          <p className="mt-1 text-[0.875rem] text-muted">{t('brand.displayLede')}</p>
          <div className="form-grid mt-4">
            <TextField span="half" label={t('brand.welcome')} name="displayWelcome" value={values.displayWelcome} onChange={set('displayWelcome')} maxLength={80} placeholder={t('brand.welcomePlaceholder')} error={fieldError('displayWelcome')} />
            <TextField span="half" label={t('brand.thanks')} name="displayThanks" value={values.displayThanks} onChange={set('displayThanks')} maxLength={80} placeholder={t('brand.thanksPlaceholder')} error={fieldError('displayThanks')} />
          </div>
        </Note>

        <Note className="px-5 py-5">
          <h2 className="text-[1.0625rem] font-semibold">{t('brand.signIn')}</h2>
          <label className="mt-3 flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-blue)]" checked={publicSignIn} onChange={(e) => { setDone(false); setPublicSignIn(e.target.checked); }} />
            <span>
              <span className="font-semibold">{t('brand.signInToggle')}</span>
              <span className="mt-0.5 block text-[0.875rem] text-muted">{t('brand.signInHint')}</span>
            </span>
          </label>
          {/* One address: the business's own where hosting gives one (session 41), else the page under the main one. */}
          {publicSignIn && !ownUrl && (
            <p className="mt-3 text-[0.875rem]">
              {t('brand.signInAddress')}{' '}
              <a className="font-mono font-semibold text-blue underline break-all" href={`/s/${slug}`} target="_blank" rel="noopener">{signInUrl}</a>
            </p>
          )}
          {publicSignIn && ownUrl && (
            <p className="mt-3 text-[0.875rem]">
              {t('brand.ownAddress')}{' '}
              <a className="font-mono font-semibold text-blue underline break-all" href={ownUrl} target="_blank" rel="noopener" data-testid="own-address">{ownUrl}</a>
            </p>
          )}
        </Note>
      </fieldset>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
          {done && <span role="status" className="text-[0.875rem] text-green">{t('brand.saved')}</span>}
          <FormError message={error?.code === 'VALIDATION_FAILED' ? t('brand.checkFields') : error?.message} />
        </div>
      )}
    </form>
  );
}

function TextArea({
  label, hint, error, action, ...props
}: { label: string; hint?: string; error?: string | undefined; /** Beside the label, e.g. "Use suggested text". */ action?: React.ReactNode } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = `brand-${props.name}`;
  return (
    <div className="field">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id}>{label}</label>
        {action}
      </div>
      <textarea id={id} className="input min-h-[4.5rem] py-2" rows={3} maxLength={160} aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint`} {...props} />
      <p id={`${id}-hint`} className={`hint ${error ? 'text-red!' : ''}`}>{error ?? hint}</p>
    </div>
  );
}
