'use client';

import { FormError } from '@/components/fields';
import { Note } from '@/components/note';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { SampleData } from '@/lib/api';

/**
 * The trial's sample items (ADR-0016 slice 6): offered before the first sale, removable any time.
 * Shown only to someone who manages the catalog; the API checks it again.
 */
export function SampleCard({ state }: { state: SampleData }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  if (!state.canLoad && state.loaded === 0) return null;
  return (
    <Note denom="orange" className="px-5 py-4">
      <h2 className="text-[1.0625rem] font-semibold">{t('sample.title')}</h2>
      {state.loaded > 0 ? (
        <>
          <p className="mt-1 text-[0.9375rem] text-muted">{t('sample.loaded', { n: state.loaded })}</p>
          <button
            type="button"
            className="btn mt-3 w-full"
            disabled={pending}
            onClick={() => {
              if (window.confirm(t('sample.removeConfirm'))) void submit('POST', '/api/v1/sample-data/remove', {}, { idempotent: true });
            }}
          >
            {t('sample.remove')}
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-[0.9375rem] text-muted">{t('sample.lede')}</p>
          <button type="button" className="btn btn-primary mt-3 w-full" disabled={pending} onClick={() => void submit('POST', '/api/v1/sample-data', {}, { idempotent: true })}>
            {t('sample.load')}
          </button>
        </>
      )}
      <div className="mt-2">
        <FormError message={error?.message} />
      </div>
    </Note>
  );
}
