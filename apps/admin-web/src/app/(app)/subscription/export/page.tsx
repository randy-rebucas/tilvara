import { Callout, Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { getT } from '@/i18n/server';
import type { MessageKey } from '@/i18n/messages';
import { apiOrNull, type DataExport } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { SubscriptionTabs } from '../tabs';
import { DownloadButton, RequestExportButton } from './export-actions';

export const metadata = { title: 'Your records' };

/** Bytes as KB/MB for people (the exact size and checksum are shown too). */
function size(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function ExportPage() {
  const { t, lang } = await getT();
  const list = await apiOrNull<{ data: DataExport[] }>('/data-exports');
  const preparing = list?.data.some((e) => e.status === 'REQUESTED') ?? false;
  const statusTone = (s: DataExport['status']) => (s === 'READY' ? 'text-blue' : s === 'FAILED' ? 'text-red' : 'text-muted');
  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageHeader title={t('export.title')} lede={t('export.lede')} actions={list ? <RequestExportButton disabled={preparing} /> : undefined} />
      <SubscriptionTabs active="export" />
      {!list ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          {preparing && <Callout tone="info">{t('export.preparing')}</Callout>}
          <Note denom="blue" className="pr-2">
            {list.data.length === 0 ? (
              <Empty>{t('export.empty')}</Empty>
            ) : (
              <RecordTable
                rows={list.data}
                rowKey={(e) => e.id}
                dimmed={(e) => e.status === 'EXPIRED'}
                columns={[
                  { header: t('export.requested'), cell: (e) => <span className="whitespace-nowrap">{formatDateTime(e.requestedAt, lang)}</span> },
                  { header: t('export.by'), cell: (e) => e.requestedBy.name ?? '—' },
                  { header: t('export.status'), cell: (e) => <span className={`font-semibold ${statusTone(e.status)}`}>{t(`export.status.${e.status}` as MessageKey)}</span> },
                  { header: t('export.rows'), num: true, cell: (e) => (e.totalRows === null ? '—' : e.totalRows.toLocaleString('en-PH')) },
                  { header: t('export.size'), num: true, cell: (e) => size(e.sizeBytes) },
                  { header: t('export.until'), cell: (e) => (e.expiresAt ? <span className="whitespace-nowrap text-muted">{formatDateTime(e.expiresAt, lang)}</span> : '—') },
                  {
                    header: '',
                    cell: (e) =>
                      e.status === 'READY' ? (
                        <DownloadButton id={e.id} />
                      ) : e.status === 'FAILED' ? (
                        <span className="text-[0.8125rem] text-muted">{t('export.failed')}</span>
                      ) : null,
                  },
                ]}
                stacked={{
                  title: (e) => formatDateTime(e.requestedAt, lang),
                  meta: (e) => (
                    <span className="text-[0.8125rem] text-muted">
                      <span className={`font-semibold ${statusTone(e.status)}`}>{t(`export.status.${e.status}` as MessageKey)}</span>
                      {e.sizeBytes !== null && ` · ${size(e.sizeBytes)}`}
                      {e.expiresAt && ` · ${t('export.until')} ${formatDateTime(e.expiresAt, lang)}`}
                    </span>
                  ),
                  figure: (e) => (e.status === 'READY' ? <DownloadButton id={e.id} /> : null),
                }}
              />
            )}
          </Note>
          {list.data.find((e) => e.status === 'READY' && e.sha256) && (
            <p className="text-[0.8125rem] text-muted">
              {t('export.checksum')}: <Serial className="break-all">{list.data.find((e) => e.status === 'READY')!.sha256}</Serial>
            </p>
          )}
          <Callout tone="info">{t('export.privacy')}</Callout>
          <p className="text-[0.9375rem] text-muted">{t('export.leaving')}</p>
        </>
      )}
    </div>
  );
}
