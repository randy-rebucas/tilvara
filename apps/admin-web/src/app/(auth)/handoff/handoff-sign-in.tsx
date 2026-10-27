'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Callout } from '@/components/note';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import { safeNext } from '@/lib/next-path';

/**
 * Redeems the one-time code only on a click: a hand-off link someone else made would otherwise sign
 * this browser in as them without a word. The code is taken out of the address bar at once (it is
 * spent on first use and lives 60 s), kept in memory only.
 */
export function HandoffSignIn({ shopName, signedIn }: { shopName: string | null; signedIn: { name: string; email: string } | true | null }) {
  const { t } = useT();
  const { submit, pending } = useSubmit();
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const link = useRef<{ code: string; next: string | null } | null>(null);

  useEffect(() => {
    if (link.current) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    // Keep the code out of the history and of any reload.
    window.history.replaceState(null, '', window.location.pathname);
    const code = params.get('code');
    if (!code) {
      setFailed(true);
      return;
    }
    link.current = { code, next: params.get('next') };
    setReady(true);
  }, []);

  async function proceed() {
    if (!link.current) return;
    const r = await submit('POST', '/api/auth/handoff', { code: link.current.code }, { refresh: false });
    // A full load into the new session (nothing cached from before it).
    if (r.ok) window.location.replace(safeNext(link.current.next));
    else setFailed(true);
  }

  if (failed) {
    return (
      <div role="alert" className="flex flex-col gap-4">
        <p className="text-[0.9375rem]">{t('handoff.failed')}</p>
        <Link href="/sign-in" className="btn btn-primary h-10 self-start">
          {t('auth.signIn')}
        </Link>
      </div>
    );
  }
  if (!ready) return <p role="status" className="text-[0.9375rem]">{t('auth.working')}</p>;
  return (
    <div className="flex flex-col gap-4">
      {signedIn && (
        <Callout tone="warn">
          {signedIn === true ? t('handoff.signedInHere') : t('handoff.signedInAs', { name: signedIn.name, email: signedIn.email })}
        </Callout>
      )}
      <p className="text-[0.9375rem]">{t('handoff.confirm')}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary h-10" disabled={pending} onClick={() => void proceed()}>
          {shopName ? t('handoff.continueTo', { name: shopName }) : t('handoff.continue')}
        </button>
        <Link href="/sign-in" className="btn h-10">
          {t('common.cancel')}
        </Link>
      </div>
    </div>
  );
}
