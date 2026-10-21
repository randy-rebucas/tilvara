import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Me, type PackLink, type PackOpening } from '@/lib/api';
import { formatDateTime, peso, qty } from '@/lib/format';
import { getT } from '@/i18n/server';
import { InventoryChrome, inventoryBranch } from '../chrome';
import { OpenPackForm } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('inventory.packs');

/** Packs opened into pieces at the branch (ADR-0020 §2): by a sale short of pieces, or by hand. */
export default async function PacksPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const { branches, branch } = await inventoryBranch(sp.branch);
  const [me, links, openings] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: PackLink[] }>('/pack-conversions'),
    branch ? apiOrNull<{ data: PackOpening[] }>(`/stock/pack-openings?branchId=${branch.id}`) : null,
  ]);
  const canAdjust = me.activeTenant?.permissions.includes('inventory.adjust') ?? false;
  const options = (links?.data ?? []).map((l) => ({ id: l.id, label: t('prod.packLine', { pack: l.pack.name, n: l.piecesPerPack, piece: l.piece.name }) }));
  const rows = openings?.data ?? [];

  return (
    <InventoryChrome tab="packs" branches={branches} branch={branch}>
      <section className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-[640px] text-[0.9375rem] text-muted">{t('packs.lede')}</p>
          {canAdjust && branch && options.length > 0 && <OpenPackForm branchId={branch.id} links={options} />}
        </div>
        {links && links.data.length === 0 && <p className="text-[0.875rem] text-muted">{t('packs.noLinks')} <Link href="/products" className="underline">{t('prod.title')}</Link></p>}
        <h2 className="section-title pt-2">{t('packs.history')}</h2>
        <Note denom="gold" className="pr-2">
          {rows.length > 0 ? (
            <RecordTable
              rows={rows}
              rowKey={(r) => r.id}
              columns={[
                { header: t('common.date'), cell: (r) => formatDateTime(r.createdAt, lang) },
                { header: t('packs.link'), cell: (r) => <span>{r.pack.name} <Serial>{r.pack.sku}</Serial></span> },
                { header: t('common.quantity'), num: true, cell: (r) => <b>{qty(r.packs)}</b> },
                { header: t('packs.pieces'), num: true, cell: (r) => `${qty(r.pieces)} × ${r.piece.name}` },
                { header: t('common.value'), num: true, cell: (r) => <span className="money">{peso(r.packsValue)}</span> },
                { header: t('packs.how'), cell: (r) => (r.saleId ? <Link href={`/sales/${r.saleId}`} className="underline">{t('packs.forSale', { n: r.saleNumber ?? '' })}</Link> : r.reason) },
              ]}
              stacked={{
                title: (r) => `${r.pack.name} × ${qty(r.packs)} → ${qty(r.pieces)}`,
                meta: (r) => <Serial>{formatDateTime(r.createdAt, lang)} · {r.saleId ? t('packs.forSale', { n: r.saleNumber ?? '' }) : r.reason}</Serial>,
                figure: (r) => <span className="money">{peso(r.packsValue)}</span>,
              }}
            />
          ) : (
            <Empty>{openings ? t('packs.none') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </InventoryChrome>
  );
}
