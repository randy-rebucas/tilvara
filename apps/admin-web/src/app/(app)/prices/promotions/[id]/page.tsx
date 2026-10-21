import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/actions';
import { Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Branch, type Me, type Promotion } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { isUuid } from '@/lib/options';
import { describePromotion } from '@/lib/promotions';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { RenamePromotion, StateMark } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('prices.promotions.item');

/** One promotion: its terms in words, where and when it applies, its items; rename, end or copy it. */
export default async function PromotionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [me, promotion, branchList] = await Promise.all([api<Me>('/me'), apiOrNull<Promotion>(`/promotions/${id}`), apiOrNull<{ data: Branch[] }>('/branches')]);
  if (!promotion) notFound();
  const canManage = me.activeTenant?.permissions.includes('prices.manage') ?? false;
  const branches = promotion.branchIds.map((b) => branchList?.data.find((x) => x.id === b)).filter((b): b is Branch => !!b);
  const live = promotion.state !== 'ENDED';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/prices/promotions" className="text-[0.875rem] text-muted underline">{t('promo.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{promotion.name}</h1>
        <Serial className="mt-1 block">
          {t(`promo.kind.${promotion.kind}` as MessageKey)} · {t('promo.itemCount', { n: promotion.items.length })} · {promotion.allBranches ? t('promo.allBranches') : branches.map((b) => b.code).join(', ')}
        </Serial>
      </div>

      <Note denom="blue" className="flex flex-wrap items-start justify-between gap-4 px-5 py-4 pr-8">
        <div className="min-w-0">
          <p className="text-[0.8125rem] text-muted">{t('promo.terms')}</p>
          <p className="money text-[1.25rem] font-semibold">{describePromotion(promotion, t)}</p>
          <p className="mt-2 text-[0.875rem]">
            {t('promo.starts')}: {formatDateTime(promotion.startsAt, lang)} · {t('promo.ends')}: {promotion.endsAt ? formatDateTime(promotion.endsAt, lang) : t('promo.noEnd')}
          </p>
        </div>
        <StateMark state={promotion.state} />
      </Note>

      {canManage && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-start gap-2">
            {live && <RenamePromotion promotion={promotion} />}
            {live && (
              <ActionButton
                method="PATCH"
                url={`/api/v1/promotions/${promotion.id}`}
                body={{ endsAt: 'now' }}
                label={promotion.state === 'SCHEDULED' ? t('promo.callOff') : t('promo.endNow')}
                confirmText={promotion.state === 'SCHEDULED' ? t('promo.callOffConfirm', { name: promotion.name }) : t('promo.endConfirm', { name: promotion.name })}
              />
            )}
            <Link href={`/prices/promotions?copy=${promotion.id}`} className="btn">{t('promo.copy')}</Link>
          </div>
          <p className="max-w-[80ch] text-[0.8125rem] text-muted">{t('promo.termsFixed')}</p>
        </div>
      )}

      {!promotion.allBranches && (
        <section>
          <h2 className="section-title mb-3">{t('promo.where')}</h2>
          <ul className="flex flex-wrap gap-2">
            {branches.map((b) => (
              <li key={b.id} className="note flex items-center gap-2 px-3.5 py-2">
                <span className="font-semibold">{b.name}</span>
                <Serial className="text-violet">{b.code}</Serial>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="section-title mb-3">{t('promo.items')}</h2>
        <Note denom="blue" className="pr-2">
          <RecordTable
            rows={promotion.items}
            rowKey={(i) => i.variantId}
            columns={[
              { header: t('prod.sku'), cell: (i) => <Serial className="text-ink">{i.sku}</Serial> },
              { header: t('common.item'), cell: (i) => i.name },
            ]}
            stacked={{ title: (i) => i.name, meta: (i) => <Serial>{i.sku}</Serial> }}
          />
        </Note>
        <p className="mt-2 max-w-[80ch] text-[0.8125rem] text-muted">{t('promo.rules')}</p>
      </section>
    </div>
  );
}
