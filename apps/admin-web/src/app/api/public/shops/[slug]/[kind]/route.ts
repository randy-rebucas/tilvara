import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/config';
import { visitorHeaders } from '@/lib/visitor';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * A shop's logo or background for its public sign-in page (session 39): no session, GET only, and
 * only what the API's public route gives (nothing for a shop that has not switched the page on).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; kind: string }> }) {
  const { slug, kind } = await params;
  if (!SLUG.test(slug) || (kind !== 'logo' && kind !== 'background')) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 });
  }
  const res = await fetch(`${API_URL}/public/shops/${slug}/${kind}`, { headers: visitorHeaders(request.headers), cache: 'no-store' });
  if (!res.ok) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 });
  const headers: Record<string, string> = { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream' };
  for (const h of ['cache-control', 'content-length', 'etag', 'x-content-type-options']) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return new NextResponse(await res.arrayBuffer(), { status: 200, headers });
}
