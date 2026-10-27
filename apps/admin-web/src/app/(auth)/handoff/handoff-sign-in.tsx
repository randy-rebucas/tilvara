'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import { safeNext } from '@/lib/next-path';

export function HandoffSignIn() {
  const { t } = useT();
  const { submit } = useSubmit();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    // The code is spent on first use: keep it out of the history and of any reload.
    window.history.replaceState(null, '', window.location.pathname);
    const code = params.get('code');
    if (!code) {
      setFailed(true);
      return;
    }
    void submit('POST', '/api/auth/handoff', { code }, { refresh: false }).then((r) => {
      // A full load into the new session (nothing cached from before it).
      if (r.ok) window.location.replace(safeNext(params.get('next')));
      else setFailed(true);
    });
  }, [submit]);

  if (!failed) return <p role="status" className="text-[0.9375rem]">{t('auth.working')}</p>;
  return (
    <div role="alert" className="flex flex-col gap-4">
      <p className="text-[0.9375rem]">{t('handoff.failed')}</p>
      <Link href="/sign-in" className="btn btn-primary h-10 self-start">
        {t('auth.signIn')}
      </Link>
    </div>
  );
}
