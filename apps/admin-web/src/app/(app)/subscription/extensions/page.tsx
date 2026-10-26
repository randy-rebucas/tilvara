import { ActionButton } from '@/components/actions';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { en, type MessageKey } from '@/i18n/messages';
import { pageTitle } from '@/i18n/page-title';
import { getT } from '@/i18n/server';
import { apiOrNull, type Extension } from '@/lib/api';
import { SubscriptionTabs } from '../tabs';

export const generateMetadata = pageTitle('subscription.extensions');

/**
 * Extensions (ADR-0026): the trades' tools a business adds to the shop basics, switched on by whoever may
 * manage the business when the plan includes them. Switching one off keeps its records.
 */
export default async function ExtensionsPage() {
  const { t } = await getT();
  const list = await apiOrNull<Extension[]>('/extensions');
  // An extension's own copy when this build has it (`ext.<code>.name`/`.desc`), else the catalog's words.
  const copy = (code: string, part: 'name' | 'desc', fallback: string) => {
    const key = `ext.${code}.${part}`;
    return key in en ? t(key as MessageKey) : fallback;
  };
  const byCode = new Map(list?.map((e) => [e.code, copy(e.code, 'name', e.name)]));
  const names = (codes: string[]) => codes.map((c) => byCode.get(c) ?? c).join(', ');
  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageHeader title={t('ext.title')} lede={t('ext.lede')} />
      <SubscriptionTabs active="extensions" />
      {!list ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : list.length === 0 ? (
        <Note><Empty>{t('ext.empty')}</Empty></Note>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="extensions">
          {list.map((e) => {
            const name = copy(e.code, 'name', e.name);
            const status = e.usable ? t('ext.on') : e.enabled ? t('ext.notUsable') : t('ext.off');
            const blocked = !e.enabled && (!e.allowedByPlan ? t('ext.notOnPlan') : e.missing.length ? t('ext.needs', { names: names(e.missing) }) : null);
            return (
              <li key={e.code} data-extension={e.code}>
                <Note denom={e.usable ? 'green' : 'none'} className="px-5 py-4" as="div">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">{name}</p>
                      <Serial className="mt-1 block">
                        <span className={`font-semibold ${e.usable ? 'text-green' : e.enabled ? 'text-orange' : 'text-muted'}`}>{status}</span>
                        {blocked && ` · ${blocked}`}
                      </Serial>
                      <p className="mt-2 text-[0.9375rem]">{copy(e.code, 'desc', e.description)}</p>
                    </div>
                    {e.enabled ? (
                      <ActionButton url={`/api/v1/extensions/${e.code}/disable`} label={t('ext.disable')} confirmText={t('ext.disableConfirm', { name })} />
                    ) : (
                      !blocked && <ActionButton url={`/api/v1/extensions/${e.code}/enable`} label={t('ext.enable')} primary />
                    )}
                  </div>
                </Note>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
