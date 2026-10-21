import Link from 'next/link';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { SubNav } from '@/components/sub-nav';
import { allProducts, api, apiOrNull, type Branch, type Me, type Promotion } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { isUuid } from '@/lib/options';
import { describePromotion } from '@/lib/promotions';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { PricesTabs } from '../tabs';
import { NewPromotion, StateMark } from './forms';

export const metadata = { title: 'Promotions' };

const STATES = ['CURRENT', 'ENDED', 'ALL'] as const;
type StateFilter = (typeof STATES)[number];

/** Multi-buys, buy-X-get-Y and quantity breaks (ADR-0021 §1): the list, what each kind means, and a new one. */
export default async function PromotionsPage({ searchParams }: { searchParams: Promise<{ state?: string; copy?: string }> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const state: StateFilter = STATES.find((s) => s === sp.state) ?? 'CURRENT';
  const [me, list, branchList] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: Promotion[] }>(`/promotions?state=${state}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  const canManage = me.activeTenant?.permissions.includes('prices.manage') ?? false;
  const branches = branchList?.data.filter((b) => !b.archivedAt) ?? [];
  const code = (id: string) => branchList?.data.find((b) => b.id === id)?.code ?? '—';
  const products = canManage ? ((await allProducts())?.data ?? []) : [];
  const copyOf = canManage && sp.copy && isUuid(sp.copy) ? await apiOrNull<Promotion>(`/promotions/${sp.copy}`) : null;
  const pickable = products
    .filter((p) => !p.archivedAt)
    .map((p) => ({ id: p.id, name: p.name, variants: p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, sku: v.sku, name: v.name, barcodes: v.barcodes })) }))
    .filter((p) => p.variants.length > 0);
  const where = (p: Promotion) => (p.allBranches ? t('promo.allBranches') : p.branchIds.map(code).join(', '));
  const when = (p: Promotion) =>
    p.endsAt ? t('promo.fromTo', { from: formatDateTime(p.startsAt, lang), to: formatDateTime(p.endsAt, lang) }) : t('promo.fromOpen', { from: formatDateTime(p.startsAt, lang) });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('price.title')} lede={t('price.lede')} />
      <PricesTabs active="promotions" />

      <section aria-labelledby="promo-kinds" className="flex flex-col gap-3">
        <h2 id="promo-kinds" className="section-title">{t('promo.kindsTitle')}</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {(['MULTI_BUY', 'BUY_X_GET_Y', 'QUANTITY_BREAK'] as const).map((k) => (
            <Note key={k} denom="blue" className="px-4 py-3 pr-6">
              <p className="font-semibold">{t(`promo.kind.${k}` as MessageKey)}</p>
              <p className="money mt-0.5 text-[0.9375rem]">{t(`promo.example.${k}` as MessageKey)}</p>
              <p className="mt-1 text-[0.875rem] text-muted">{t(`promo.explain.${k}` as MessageKey)}</p>
            </Note>
          ))}
        </div>
        <p className="max-w-[80ch] text-[0.875rem] text-muted">{t('promo.rules')}</p>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('promo.title')}</h2>
          {canManage && (
            <NewPromotion
              key={copyOf?.id ?? 'new'}
              products={pickable}
              branches={branches.map((b) => ({ id: b.id, code: b.code, name: b.name }))}
              copyOf={copyOf}
            />
          )}
        </div>
        <div className="mb-3">
          <SubNav
            level={2}
            label={t('promo.filter')}
            active={state}
            items={STATES.map((s) => ({ key: s, href: `/prices/promotions?state=${s}`, label: t(`promo.filter.${s}` as MessageKey) }))}
          />
        </div>
        <Note denom="blue" className="pr-2">
          {list && list.data.length > 0 ? (
            <RecordTable
              rows={list.data}
              rowKey={(p) => p.id}
              dimmed={(p) => p.state === 'ENDED'}
              columns={[
                { header: t('common.name'), cell: (p) => <Link href={`/prices/promotions/${p.id}`} className="font-semibold underline">{p.name}</Link> },
                { header: t('promo.terms'), cell: (p) => <span className="money">{describePromotion(p, t)}</span> },
                { header: t('promo.items'), num: true, cell: (p) => p.items.length },
                { header: t('promo.where'), cell: (p) => <Serial className="text-ink">{where(p)}</Serial> },
                { header: t('promo.when'), cell: (p) => <span className="text-muted">{when(p)}</span> },
                { header: t('common.status'), cell: (p) => <StateMark state={p.state} /> },
              ]}
              stacked={{
                title: (p) => <Link href={`/prices/promotions/${p.id}`} className="underline">{p.name}</Link>,
                meta: (p) => (
                  <>
                    <span className="money block text-ink">{describePromotion(p, t)}</span>
                    <Serial>{t('promo.itemCount', { n: p.items.length })} · {where(p)}</Serial>
                    <span className="block">{when(p)}</span>
                  </>
                ),
                figure: (p) => <StateMark state={p.state} />,
              }}
            />
          ) : (
            <Empty>{!list ? t('common.noAccess') : state === 'ENDED' ? t('promo.noneEnded') : t('promo.none')}</Empty>
          )}
        </Note>
      </section>
    </div>
  );
}
