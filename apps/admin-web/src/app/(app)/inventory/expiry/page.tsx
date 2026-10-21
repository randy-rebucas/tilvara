import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Expiring, type Me, type StockLot } from '@/lib/api';
import { formatDate, peso, qty } from '@/lib/format';
import { getT } from '@/i18n/server';
import { InventoryChrome, inventoryBranch } from '../chrome';
import { WriteOffLot } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('inventory.expiry');

const WINDOWS = [7, 30, 90] as const;

/** Expired and soon-to-expire lots at the branch (ADR-0020 §3), soonest first, with a write-off per expired lot. */
export default async function ExpiryPage({ searchParams }: { searchParams: Promise<{ branch?: string; days?: string }> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const { branches, branch } = await inventoryBranch(sp.branch);
  const asked = Number(sp.days);
  const days = WINDOWS.includes(asked as (typeof WINDOWS)[number]) ? asked : undefined;
  const [me, list] = await Promise.all([
    api<Me>('/me'),
    branch ? apiOrNull<Expiring>(`/stock/expiring?branchId=${branch.id}${days ? `&withinDays=${days}` : ''}`) : null,
  ]);
  const canAdjust = me.activeTenant?.permissions.includes('inventory.adjust') ?? false;
  const within = list?.withinDays ?? days ?? 30;
  // ADR-0025 §5: a held lot (recall, advisory) is not sold where expired stock is blocked; it can be written off.
  const writable = (r: StockLot) => r.daysLeft < 0 || !!r.held;
  const held = (r: StockLot) => (r.held ? <span className="tag ml-1 border-[#ead3a6]! bg-amber-bg! text-[#6b4a12]!" data-lot-held>{t('exp.onHold')}</span> : null);
  const when = (r: StockLot) =>
    r.daysLeft < 0 ? <span className="tag text-red">{t('exp.expiredAgo', { n: String(-r.daysLeft) })}</span> : r.daysLeft === 0 ? <span className="tag">{t('exp.today')}</span> : t('exp.inDays', { n: String(r.daysLeft) });

  return (
    <InventoryChrome tab="expiry" branches={branches} branch={branch}>
      <section className="grid gap-3">
        <div>
          <h2 className="section-title">{t('exp.title')}</h2>
          <p className="mt-1 max-w-[68ch] text-[0.9375rem] text-muted">{t('exp.lede', { days: String(within) })}</p>
        </div>
        {branch && (
          <nav aria-label={t('exp.within')} className="flex flex-wrap items-center gap-2 text-[0.875rem]">
            <span className="text-muted">{t('exp.within')}</span>
            {WINDOWS.map((d) => (
              <Link key={d} href={`/inventory/expiry?branch=${branch.id}&days=${d}`} aria-current={d === within ? 'page' : undefined} className={`tag ${d === within ? 'font-semibold text-ink' : 'underline'}`}>
                {t('exp.days', { n: String(d) })}
              </Link>
            ))}
          </nav>
        )}
        {list && list.expired.lots > 0 && <p role="status" className="text-[0.9375rem] font-semibold text-red">{t('exp.expiredTotal', { lots: String(list.expired.lots), value: peso(list.expired.value) })}</p>}
        <Note denom="gold" className="pr-2">
          {list && list.data.length > 0 ? (
            <RecordTable
              rows={list.data}
              rowKey={(r) => r.lotId}
              columns={[
                { header: t('prod.sku'), cell: (r) => <Serial className="text-ink">{r.sku}</Serial> },
                { header: t('common.item'), cell: (r) => r.name },
                { header: t('exp.lot'), cell: (r) => <>{r.lotCode ? <Serial>{r.lotCode}</Serial> : '—'}{held(r)}</> },
                { header: t('exp.expiresOn'), cell: (r) => formatDate(r.expiresOn, lang) },
                { header: t('exp.left'), cell: when },
                { header: t('common.quantity'), num: true, cell: (r) => <b>{qty(r.quantity)}</b> },
                { header: t('common.value'), num: true, cell: (r) => <span className="money">{peso(r.value)}</span> },
                ...(canAdjust && branch
                  ? [{ header: '', cell: (r: StockLot) => (writable(r) ? <WriteOffLot branchId={branch.id} lot={r} confirmText={t('exp.writeOffConfirm', { qty: qty(r.quantity), name: r.name, date: formatDate(r.expiresOn, lang) })} /> : null) }]
                  : []),
              ]}
              stacked={{
                title: (r) => `${r.name} × ${qty(r.quantity)}`,
                meta: (r) => <><Serial>{r.sku}{r.lotCode ? ` · ${r.lotCode}` : ''} · {formatDate(r.expiresOn, lang)}</Serial>{held(r)}</>,
                figure: (r) => (canAdjust && branch && writable(r) ? <WriteOffLot branchId={branch.id} lot={r} confirmText={t('exp.writeOffConfirm', { qty: qty(r.quantity), name: r.name, date: formatDate(r.expiresOn, lang) })} /> : when(r)),
              }}
            />
          ) : (
            <Empty>{list ? t('exp.none', { days: String(within) }) : t('common.noAccess')}</Empty>
          )}
        </Note>
        <p className="text-[0.8125rem] text-muted">{t('exp.onlyDated')}</p>
      </section>
    </InventoryChrome>
  );
}
