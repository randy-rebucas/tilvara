/**
 * The API resources the same-origin proxy (`/api/v1/[...path]`) forwards to. Accepting an invitation
 * goes through `/api/auth` (it sets the session cookies), never through the proxy.
 */
export const PROXY_ALLOWED =
  /^(legal-entities|branches|registers|terminals|uoms|tax-categories|categories|products|variants|pack-conversions|barcodes|price-lists|promotions|members|roles|invitations(?!\/accept)|me|suppliers|supplier-items|customers|purchase-orders|goods-receipts|supplier-returns|supplier-invoices|supplier-payments(?:\/[0-9a-f-]{36}\/void)?|stock|accounts|journal-entries|accounting|sync\/transactions|support-access|api-keys|webhooks|webhook-deliveries|business|extensions|data-exports|data-export-files|sample-data|cashier-sessions\/[0-9a-f-]{36}\/approve-variance)(\/|$)/;

// Next decodes each catch-all segment, so `%2F` arrives as `/` inside one segment: a segment may never
// carry a separator, a dot segment, a percent (double encoding) or a control character.
// eslint-disable-next-line no-control-regex
const BAD_SEGMENT = /[/\\%\u0000-\u001f\u007f]/;

/**
 * The URL the proxy forwards to, or null (404) when the path is not an allowed resource or would
 * resolve anywhere else under the API: `API_URL` + the encoded segments + the request's query.
 */
export function proxyTarget(apiUrl: string, segments: readonly string[], search = ''): string | null {
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '' || s === '.' || s === '..' || BAD_SEGMENT.test(s))) return null;
  if (!PROXY_ALLOWED.test(segments.join('/'))) return null;
  const encoded = segments.map(encodeURIComponent).join('/');
  const base = new URL(apiUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const target = `${apiUrl.replace(/\/+$/, '')}/${encoded}${search.startsWith('?') ? search : ''}`;
  let resolved: URL;
  try {
    resolved = new URL(target);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin || resolved.pathname !== `${basePath}/${encoded}`) return null;
  return target;
}

export const PROXY_NO_STORE = 'private, no-store';

/**
 * Cache-Control for a proxied reply: tenant data behind a session, never kept by a shared cache.
 * The API's own caching (hash-addressed branding images, data exports) passes through, with
 * `public` (and shared-cache directives) downgraded to `private`; nothing from the API = no-store.
 */
export function proxiedCacheControl(fromApi: string | null | undefined): string {
  if (!fromApi?.trim()) return PROXY_NO_STORE;
  const parts = fromApi
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !/^(public|private|proxy-revalidate|s-maxage\s*=.*)$/i.test(p));
  return ['private', ...parts].join(', ');
}
