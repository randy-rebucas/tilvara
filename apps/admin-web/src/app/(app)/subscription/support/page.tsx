import Link from 'next/link';
import { Callout, Empty, Note, PageHeader, Serial } from '@/components/note';
import { ActionButton } from '@/components/actions';
import { getT } from '@/i18n/server';
import type { MessageKey } from '@/i18n/messages';
import { apiOrNull, type SupportGrant } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { SubscriptionTabs } from '../tabs';
import { GiveAccessForm } from './support-forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('subscription.support');

export default async function SupportAccessPage() {
  const { t, lang } = await getT();
  const list = await apiOrNull<{ data: SupportGrant[] }>('/support-access');
  const tone = (s: SupportGrant['status']) => (s === 'OPEN' ? 'text-orange' : 'text-muted');
  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageHeader title={t('support.title')} lede={t('support.lede')} />
      <SubscriptionTabs active="support" />
      {!list ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          <GiveAccessForm />
          <Callout tone="info">{t('support.readOnlyNote')}</Callout>
          {list.data.length === 0 ? (
            <Note><Empty>{t('support.empty')}</Empty></Note>
          ) : (
            <ul className="flex flex-col gap-3">
              {list.data.map((g) => (
                <li key={g.id}>
                  <Note denom={g.status === 'OPEN' ? 'orange' : 'none'} className="px-5 py-4" as="div">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold">{g.purpose}</p>
                        <Serial className="mt-1 block">
                          <span className={`font-semibold ${tone(g.status)}`}>{t(`support.status.${g.status}` as MessageKey)}</span>
                          {' · '}
                          {g.status === 'REVOKED' && g.revokedAt
                            ? t('support.endedAt', { date: formatDateTime(g.revokedAt, lang) })
                            : t('support.until', { date: formatDateTime(g.expiresAt, lang) })}
                          {g.ticketRef && ` · ${g.ticketRef}`}
                        </Serial>
                        <p className="mt-1 text-[0.8125rem] text-muted">{t('support.grantedBy', { name: g.grantedBy.name ?? '—', date: formatDateTime(g.grantedAt, lang) })}</p>
                      </div>
                      {g.status === 'OPEN' && <ActionButton url={`/api/v1/support-access/${g.id}/revoke`} label={t('support.end')} confirmText={t('support.endConfirm')} />}
                    </div>
                    <p className="mt-3 border-t border-dashed border-hair pt-3 text-[0.875rem]">
                      {g.activity.sessions === 0
                        ? t('support.unused')
                        : `${t('support.activity', { sessions: g.activity.sessions, requests: g.activity.requests, refused: g.activity.refusedWrites })}${g.activity.staff.length ? ` · ${t('support.staffNames', { names: g.activity.staff.join(', ') })}` : ''}`}
                      {' · '}
                      <Link href={`/audit?type=support_grant&record=${g.id}`} className="underline">{t('support.seeLog')}</Link>
                    </p>
                  </Note>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
