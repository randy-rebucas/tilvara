'use client';

import { useT } from '@/i18n/client';

/**
 * A page that failed to render. In production Next.js hides the server's message and passes only the
 * digest: for an API failure that is the API's correlation id (ApiError), otherwise Next's own hash of
 * the error in the admin's server log. Either way support can find it from the reference shown here.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const { t } = useT();
  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-4 px-4 py-16 sm:px-6">
      <h1 className="text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('error.title')}</h1>
      <p className="text-muted">{t('error.lede')}</p>
      {error.digest && (
        <p className="text-[0.9375rem]">
          {t('error.refLede')}{' '}
          {/* As typed, never upper-cased: log searches for the id are case-sensitive. */}
          <span className="select-all break-all font-mono font-semibold" data-testid="error-reference">
            {error.digest}
          </span>
        </p>
      )}
      <button type="button" className="btn btn-primary h-10 self-start" onClick={() => retry()}>
        {t('error.retry')}
      </button>
    </main>
  );
}
