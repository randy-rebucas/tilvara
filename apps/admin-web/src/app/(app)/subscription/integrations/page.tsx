import Link from 'next/link';
import { ActionButton } from '@/components/actions';
import { Callout, Empty, Note, PageHeader, Serial } from '@/components/note';
import { apiOrNull, type Me } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { SubscriptionTabs } from '../tabs';
import { CreateKeyForm, CreateWebhookForm, RotateSecretButton } from './forms';

export const metadata = { title: 'Integrations' };

interface ApiKey { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null; createdByName: string | null }
/** Expired keys answer 401 like revoked ones (the check is in `auth_api_key`). */
const expired = (k: ApiKey) => k.expiresAt !== null && Date.parse(k.expiresAt) <= Date.now();
interface Webhook { id: string; url: string; description: string | null; topics: string[]; enabled: boolean; pending: number; dead: number; lastDeliveredAt: string | null }

/**
 * API keys and webhooks (ADR-0019): read-only keys for another system, and endpoints that receive the
 * business's events. Keys and secrets are shown once. Plans with API access only.
 */
export default async function IntegrationsPage() {
  const { t, lang } = await getT();
  const [keys, hooks, me] = await Promise.all([
    apiOrNull<{ data: ApiKey[] }>('/api-keys'),
    apiOrNull<{ data: Webhook[] }>('/webhooks'),
    apiOrNull<Me>('/me'),
  ]);
  const included = me?.activeTenant?.features?.includes('api_access') ?? true;

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageHeader title={t('int.title')} lede={t('int.lede')} />
      <SubscriptionTabs active="integrations" />
      {!keys || !hooks ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          {!included && <Callout tone="warn">{t('int.notIncluded')}</Callout>}

          <section className="grid gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="section-title">{t('int.keys')}</h2>
                <p className="mt-1 text-[0.875rem] text-muted">{t('int.keysLede')}</p>
              </div>
              {included && <CreateKeyForm />}
            </div>
            {keys.data.length === 0 ? (
              <Note><Empty>{t('int.noKeys')}</Empty></Note>
            ) : (
              <ul className="grid gap-3">
                {keys.data.map((k) => (
                  <li key={k.id}>
                    <Note denom={k.revokedAt || expired(k) ? 'none' : 'violet'} className="px-5 py-4" as="div">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold">{k.name}</p>
                          <p className="mt-1 text-[0.875rem]">
                            <code className="font-mono text-[0.8125rem]">tlv_{k.prefix}_…</code>
                            {' · '}{k.scopes.map((s) => t(`int.scope.${s}` as MessageKey)).join(', ')}
                          </p>
                          <p className="mt-1 text-[0.8125rem] text-muted">
                            {k.revokedAt
                              ? t('int.revokedAt', { date: formatDateTime(k.revokedAt, lang) })
                              : k.lastUsedAt ? t('int.lastUsed', { date: formatDateTime(k.lastUsedAt, lang) }) : t('int.neverUsed')}
                            {!k.revokedAt && k.expiresAt && (
                              expired(k)
                                ? <span className="font-semibold text-red"> · {t('int.expiredOn', { date: formatDateTime(k.expiresAt, lang) })}</span>
                                : ` · ${t('int.expiresOn', { date: formatDateTime(k.expiresAt, lang) })}`
                            )}
                            {k.createdByName && ` · ${t('int.madeBy', { name: k.createdByName })}`}
                          </p>
                        </div>
                        {!k.revokedAt && <ActionButton url={`/api/v1/api-keys/${k.id}/revoke`} label={t('int.revoke')} confirmText={t('int.revokeConfirm', { name: k.name })} />}
                      </div>
                    </Note>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="section-title">{t('int.hooks')}</h2>
                <p className="mt-1 text-[0.875rem] text-muted">{t('int.hooksLede')}</p>
              </div>
              {included && <CreateWebhookForm />}
            </div>
            {hooks.data.length === 0 ? (
              <Note><Empty>{t('int.noHooks')}</Empty></Note>
            ) : (
              <ul className="grid gap-3">
                {hooks.data.map((w) => (
                  <li key={w.id}>
                    <Note denom={w.enabled ? 'violet' : 'none'} className="px-5 py-4" as="div">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-all font-semibold">{w.url}</p>
                          {w.description && <p className="text-[0.875rem]">{w.description}</p>}
                          <Serial className="mt-1 block">{w.topics.map((x) => t(`int.topic.${x}` as MessageKey)).join(', ')}</Serial>
                          <p className="mt-1 text-[0.8125rem] text-muted">
                            {w.enabled ? t('int.on') : t('int.off')}
                            {' · '}{t('int.waiting', { n: w.pending })}
                            {w.dead > 0 && <span className="font-semibold text-red"> · {t('int.dead', { n: w.dead })}</span>}
                            {w.lastDeliveredAt && ` · ${t('int.lastDelivered', { date: formatDateTime(w.lastDeliveredAt, lang) })}`}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Link href={`/subscription/integrations/webhooks/${w.id}`} className="btn btn-sm">{t('int.deliveries')}</Link>
                          {included && w.enabled && <ActionButton url={`/api/v1/webhooks/${w.id}/ping`} label={t('int.ping')} />}
                          <ActionButton url={`/api/v1/webhooks/${w.id}`} method="PATCH" body={{ enabled: !w.enabled }} label={w.enabled ? t('int.turnOff') : t('int.turnOn')} />
                          <RotateSecretButton id={w.id} />
                        </div>
                      </div>
                    </Note>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[0.8125rem] text-muted">{t('int.signingNote')}</p>
          </section>
        </>
      )}
    </div>
  );
}
