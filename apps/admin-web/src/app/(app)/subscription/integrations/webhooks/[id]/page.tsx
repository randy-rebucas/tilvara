import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/actions';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('subscription.integrations.webhooks.item');

interface Delivery { id: string; topic: string; status: 'PENDING' | 'DELIVERING' | 'DELIVERED' | 'DEAD'; attempts: number; maxAttempts: number; lastStatusCode: number | null; lastError: string | null; availableAt: string; deliveredAt: string | null; createdAt: string }

/** The last 100 deliveries of one endpoint: what was sent, what came back, and "Send again" for one that gave up. */
export default async function WebhookDeliveriesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [list, hooks] = await Promise.all([
    apiOrNull<{ data: Delivery[] }>(`/webhooks/${id}/deliveries`),
    apiOrNull<{ data: { id: string; url: string }[] }>('/webhooks'),
  ]);
  if (!list) notFound();
  const hook = hooks?.data.find((h) => h.id === id);
  const tone = (s: Delivery['status']) => (s === 'DELIVERED' ? 'chip bg-violet' : s === 'DEAD' ? 'chip bg-red' : 'tag');

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <div>
        <Link href="/subscription/integrations" className="text-[0.875rem] text-muted underline">{t('int.title')}</Link>
        <PageHeader title={t('int.deliveries')} lede={hook?.url ?? ''} />
      </div>
      <Note className="pr-2">
        {list.data.length > 0 ? (
          <RecordTable
            rows={list.data}
            rowKey={(d) => d.id}
            columns={[
              { header: t('int.event'), cell: (d) => <span>{d.topic === 'webhook.ping' ? t('int.pingEvent') : t(`int.topic.${d.topic}` as MessageKey)}</span> },
              { header: t('int.when'), cell: (d) => <span className="text-muted">{formatDateTime(d.createdAt, lang)}</span> },
              { header: t('common.status'), cell: (d) => <span className={tone(d.status)}>{t(`int.status.${d.status}` as MessageKey)}</span> },
              { header: t('int.attempts'), num: true, cell: (d) => `${d.attempts}/${d.maxAttempts}` },
              { header: t('int.answer'), cell: (d) => <Serial className="text-ink">{d.lastStatusCode ?? d.lastError ?? '—'}</Serial> },
              { header: '', cell: (d) => (d.status === 'DEAD' ? <ActionButton url={`/api/v1/webhook-deliveries/${d.id}/retry`} label={t('int.sendAgain')} /> : null) },
            ]}
            stacked={{
              title: (d) => (d.topic === 'webhook.ping' ? t('int.pingEvent') : t(`int.topic.${d.topic}` as MessageKey)),
              meta: (d) => <Serial>{formatDateTime(d.createdAt, lang)} · {d.attempts}/{d.maxAttempts} · {d.lastStatusCode ?? d.lastError ?? '—'}</Serial>,
              figure: (d) => <span className={tone(d.status)}>{t(`int.status.${d.status}` as MessageKey)}</span>,
            }}
          />
        ) : (
          <Empty>{t('int.noDeliveries')}</Empty>
        )}
      </Note>
    </div>
  );
}
