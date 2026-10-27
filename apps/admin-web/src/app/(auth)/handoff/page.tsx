import { cookies, headers } from 'next/headers';
import { AuthFace, AuthStub } from '@/components/auth-note';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';
import type { Me } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/cookies';
import { findShop, SHOP_HEADER } from '@/lib/shop-host';
import { visitorHeaders } from '@/lib/visitor';
import { HandoffSignIn } from './handoff-sign-in';

export const generateMetadata = pageTitle('handoff');

/**
 * A business's own address picking up a sign-in made on the main one (session 41). The one-time code
 * comes in the fragment, which no server sees; the page sends it to this address's own auth route, but
 * only on the person's click (a link from someone else would otherwise sign this browser in as them).
 * When this address already has a session, the page names who is signed in, so a swap is never silent.
 */
export default async function HandoffPage() {
  const { t } = await getT();
  const [h, jar] = await Promise.all([headers(), cookies()]);
  const slug = h.get(SHOP_HEADER);
  const shop = slug ? await findShop(slug, { visitor: visitorHeaders(h) }) : null;
  const signedIn = await currentUser(jar.get(ACCESS_COOKIE)?.value, !!jar.get(REFRESH_COOKIE)?.value, visitorHeaders(h));
  return (
    <AuthStub denom="blue" face={<AuthFace denom="blue" title={t('handoff.title')} lede={t('handoff.lede')} />}>
      <HandoffSignIn shopName={shop?.name ?? null} signedIn={signedIn} />
    </AuthStub>
  );
}

/**
 * Who this browser is signed in as on this address: the name (and email) when the access cookie still
 * answers, `true` when only a refresh cookie is left (signed in, name unknown), null when signed out.
 */
async function currentUser(access: string | undefined, hasRefresh: boolean, visitor: Record<string, string>): Promise<{ name: string; email: string } | true | null> {
  if (access) {
    const res = await fetch(`${API_URL}/me`, { headers: { ...visitor, authorization: `Bearer ${access}` }, cache: 'no-store' }).catch(() => null);
    if (res?.ok) {
      const me = (await res.json().catch(() => null)) as Me | null;
      if (me) return { name: me.user.displayName, email: me.user.email };
    }
  }
  return access || hasRefresh ? true : null;
}
