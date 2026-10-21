import Link from 'next/link';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { allProducts, api, apiOrNull, type Branch, type CurrentPrice, type Me, type PriceList } from '@/lib/api';
import { formatDateTime, peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { ActionButton } from '@/components/actions';
import { AssignBranch, NewPriceList, RenamePriceList, SetPrice } from './set-price';
import { PricesTabs } from './tabs';

export const metadata = { title: 'Prices' };

export default async function PricesPage({ searchParams }: { searchParams: Promise<{ list?: string }> }) {
  const { t, lang } = await getT();
  const { list } = await searchParams;
  const [me, lists, products, branchList] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: PriceList[] }>('/price-lists'),
    allProducts(),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  const active = lists?.data.filter((l) => !l.archivedAt) ?? [];
  const selected = active.find((l) => l.id === list) ?? active.find((l) => l.isDefault) ?? active[0];
  const branches = branchList?.data.filter((b) => !b.archivedAt) ?? [];
  const assignedAnywhere = new Set(active.flatMap((l) => l.branchIds));
  // The default list serves every branch without its own list; any other list serves the branches assigned to it.
  const usedBy = selected ? branches.filter((b) => selected.branchIds.includes(b.id) || (selected.isDefault && !assignedAnywhere.has(b.id))) : [];
  const assignable = selected ? branches.filter((b) => !usedBy.some((u) => u.id === b.id)) : [];
  const prices = selected ? await apiOrNull<{ data: CurrentPrice[] }>(`/price-lists/${selected.id}/prices`) : null;
  const canManage = me.activeTenant?.permissions.includes('prices.manage') ?? false;
  const variants = (products?.data ?? [])
    .filter((p) => !p.archivedAt)
    .flatMap((p) => p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, label: `${v.sku} · ${p.name}${v.name ? ` — ${v.name}` : ''}` })));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('price.title')} lede={t('price.lede')} />
      <PricesTabs active="lists" />

      <div>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('price.lists')}</h2>
          {canManage && <NewPriceList />}
        </div>
        {active.length > 0 ? (
          <div role="tablist" aria-label={t('price.lists')} className="flex flex-wrap gap-2">
            {active.map((l) => {
              const on = l.id === selected?.id;
              return (
                <Link key={l.id} role="tab" aria-selected={on} href={`/prices?list=${l.id}`}
                  className={`note flex items-center gap-3 px-4 py-2.5 ${on ? 'outline-2 outline-blue' : 'hover:bg-white'}`}>
                  <span className="font-semibold">{l.name}</span>
                  <Serial>{l.currency} · {l.pricesIncludeTax ? t('price.inclTax') : t('price.exclTax')}</Serial>
                  {l.isDefault && <span className="chip bg-blue">{t('price.default')}</span>}
                </Link>
              );
            })}
          </div>
        ) : (
          <Note><Empty>{lists ? t('loc.empty') : t('common.noAccess')}</Empty></Note>
        )}
      </div>

      {selected && (
        <section>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <h2 className="section-title pt-2">{selected.name}</h2>
            {canManage && (
              <div className="flex flex-wrap items-start gap-2">
                <SetPrice listId={selected.id} variants={variants} />
                <RenamePriceList list={selected} />
                {!selected.isDefault && <ActionButton url={`/api/v1/price-lists/${selected.id}`} method="PATCH" body={{ isDefault: true }} label={t('price.makeDefault')} confirmText={t('price.makeDefaultConfirm', { name: selected.name })} />}
              </div>
            )}
          </div>
          <Note className="mb-4 flex flex-col gap-3 px-4 py-3">
            <p className="text-[0.875rem]">
              <span className="font-semibold">{t('price.usedBy')}</span>{' '}
              {usedBy.length > 0 ? usedBy.map((b) => b.code).join(', ') : t('price.usedByNone')}
              {selected.isDefault && <span className="text-muted"> · {t('price.defaultHint')}</span>}
            </p>
            {canManage && (
              <div className="flex flex-wrap items-end gap-4">
                {assignable.length > 0 && <AssignBranch listId={selected.id} branches={assignable} />}
                {!selected.isDefault && usedBy.map((b) => (
                  <ActionButton key={b.id} url={`/api/v1/branches/${b.id}/price-list`} method="PUT" body={{ priceListId: null }} label={t('price.backToDefault', { code: b.code })} />
                ))}
              </div>
            )}
          </Note>
          <Note denom="blue" className="overflow-x-auto pr-2">
            {prices && prices.data.length > 0 ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('prod.sku')}</th>
                    <th>{t('prod.name')}</th>
                    <th className="num">{t('price.current')}</th>
                    <th>{t('price.effective')}</th>
                    <th className="num">{t('price.scheduled')}</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.data.map((p) => (
                    <tr key={p.priceId}>
                      <td><Serial className="text-ink">{p.sku}</Serial></td>
                      <td>{p.variantName ? `${p.productName} — ${p.variantName}` : p.productName}</td>
                      <td className="num money font-semibold">{peso(p.amount)}</td>
                      <td className="text-muted">{formatDateTime(p.effectiveFrom, lang)}</td>
                      <td className="num">
                        {p.scheduled ? (
                          <span className="money">
                            {peso(p.scheduled.amount)} <span className="block text-[0.8125rem] text-muted">{formatDateTime(p.scheduled.effectiveFrom, lang)}</span>
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>{t('overview.noPrices')}</Empty>
            )}
          </Note>
        </section>
      )}
    </div>
  );
}
