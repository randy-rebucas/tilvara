import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/config';
import { ACCESS_COOKIE } from '@/lib/cookies';
import { rejectCrossSite } from '@/lib/csrf';
import { PROXY_NO_STORE, proxiedCacheControl, proxyTarget } from '@/lib/proxy-path';
import { visitorHeaders } from '@/lib/visitor';

/**
 * Same-origin proxy for client components: attaches the httpOnly bearer token server-side and
 * forwards to the API. Only an allow-listed set of resources is reachable through it, and only at
 * the path it names (`proxyTarget`: no encoded slashes or dot segments).
 */
const NO_STORE = { 'cache-control': PROXY_NO_STORE, vary: 'Cookie' };
const notFound = () => NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404, headers: NO_STORE });

async function forward(request: NextRequest, path: string[]) {
  const target = proxyTarget(API_URL, path, request.nextUrl.search);
  if (!target) return notFound();
  if (request.method !== 'GET') {
    const refused = rejectCrossSite(request);
    if (refused) return refused;
  }
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Session expired' } }, { status: 401, headers: NO_STORE });

  const headers: Record<string, string> = { ...visitorHeaders(request.headers), authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const idem = request.headers.get('idempotency-key');
  if (idem) headers['idempotency-key'] = idem;
  const correlation = request.headers.get('x-correlation-id');
  if (correlation) headers['x-correlation-id'] = correlation;

  const res = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' ? undefined : await request.text(),
    cache: 'no-store',
  });
  // Bytes, not text: a data export is a ZIP, a logo an image. Download headers pass through.
  const headersOut: Record<string, string> = {
    'content-type': res.headers.get('content-type') ?? 'application/json',
    'cache-control': proxiedCacheControl(res.headers.get('cache-control')),
    vary: 'Cookie',
  };
  for (const h of ['content-disposition', 'content-length', 'etag', 'x-content-type-options']) {
    const v = res.headers.get(h);
    if (v) headersOut[h] = v;
  }
  const body = res.status === 204 ? null : await res.arrayBuffer();
  return new NextResponse(body && body.byteLength > 0 ? body : null, { status: res.status, headers: headersOut });
}

type Ctx = { params: Promise<{ path: string[] }> };
export const GET = async (r: NextRequest, c: Ctx) => forward(r, (await c.params).path);
export const POST = async (r: NextRequest, c: Ctx) => forward(r, (await c.params).path);
export const PATCH = async (r: NextRequest, c: Ctx) => forward(r, (await c.params).path);
export const PUT = async (r: NextRequest, c: Ctx) => forward(r, (await c.params).path);
