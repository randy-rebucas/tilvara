'use client';

import { Download } from 'lucide-react';
import { FormError } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';

const KNOWN: Record<string, MessageKey> = { EXPORT_IN_PROGRESS: 'export.inProgress', EXPORT_LIMIT: 'export.limit' };

export function RequestExportButton({ disabled }: { disabled: boolean }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-primary" disabled={pending || disabled} onClick={() => void submit('POST', '/api/v1/data-exports', {}, { idempotent: true })}>
        {t('export.request')}
      </button>
      <FormError message={error ? (KNOWN[error.code] ? t(KNOWN[error.code]!) : error.message) : null} />
    </span>
  );
}

/**
 * A fresh short-lived link per click (the API audits each), then the browser follows it. A dev link
 * is an API path, fetched through the BFF; object storage would give a full https URL.
 */
export function DownloadButton({ id }: { id: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  async function go() {
    const r = await submit<{ url: string }>('POST', `/api/v1/data-exports/${id}/link`, {}, { refresh: false });
    if (r.ok) window.location.assign(r.data.url.startsWith('/v1/') ? `/api${r.data.url}` : r.data.url);
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn" disabled={pending} onClick={() => void go()}>
        <Download aria-hidden className="size-4" /> {t('export.download')}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}
