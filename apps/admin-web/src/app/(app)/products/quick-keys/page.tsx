import Link from 'next/link';
import { ActionButton } from '@/components/actions';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { allProducts, api, type Me } from '@/lib/api';
import { getT } from '@/i18n/server';
import { ProductsTabs } from '../tabs';
import { SetQuickKey } from './set-key';

export const metadata = { title: 'Quick keys' };

const SLOTS = Array.from({ length: 48 }, (_, i) => i + 1);

/** The till's quick keys (ADR-0021 §3): 48 buttons on the Sell screen, in this order. */
export default async function QuickKeysPage() {
  const { t } = await getT();
  const [me, products] = await Promise.all([api<Me>('/me'), allProducts()]);
  const canManage = me.activeTenant?.permissions.includes('catalog.manage') ?? false;
  const live = (products?.data ?? []).filter((p) => !p.archivedAt);
  const keyed = new Map(
    live.flatMap((p) =>
      p.variants
        .filter((v) => !v.archivedAt && v.quickKeyPosition)
        .map((v) => [v.quickKeyPosition!, { variantId: v.id, productId: p.id, sku: v.sku, name: v.name ? `${p.name} — ${v.name}` : p.name }] as const),
    ),
  );
  const options = live.flatMap((p) =>
    p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, label: `${v.sku} · ${p.name}${v.name ? ` — ${v.name}` : ''}`, position: v.quickKeyPosition ?? null })),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('prod.title')} lede={t('prod.lede')} />
      <ProductsTabs active="quickKeys" />
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title pt-2">{t('qk.title')}</h2>
            <p className="mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('qk.lede')}</p>
          </div>
          {canManage && products && <SetQuickKey options={options} taken={Object.fromEntries([...keyed].map(([n, v]) => [n, v.name]))} />}
        </div>
        {!products ? (
          <Note><Empty>{t('common.noAccess')}</Empty></Note>
        ) : (
          <Note denom="blue" className="p-3 pr-6">
            {keyed.size === 0 && <p className="px-1 pb-3 text-muted">{t('qk.none')}</p>}
            <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8" aria-label={t('qk.order')}>
              {SLOTS.map((n) => {
                const k = keyed.get(n);
                return (
                  <li key={n} className={`flex min-h-[92px] flex-col justify-between gap-1 rounded-[5px] border p-2 ${k ? 'border-hair bg-white' : 'border-dashed border-hair-soft text-muted'}`}>
                    <span className="serial text-[0.75rem] text-muted">{n}</span>
                    {k ? (
                      <>
                        <Link href={`/products/${k.productId}`} className="line-clamp-2 text-[0.875rem] font-semibold underline">{k.name}</Link>
                        <Serial className="truncate">{k.sku}</Serial>
                        {canManage && <ActionButton method="PATCH" url={`/api/v1/variants/${k.variantId}`} body={{ quickKeyPosition: null }} label={t('qk.clear')} />}
                      </>
                    ) : (
                      <span className="text-[0.8125rem]">{t('qk.empty')}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </Note>
        )}
      </section>
    </div>
  );
}
