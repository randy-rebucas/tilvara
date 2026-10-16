import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type CountRow, type Me, type Product } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { docNo, variantOptions } from '@/lib/options';
import { getT } from '@/i18n/server';
import { InventoryChrome, inventoryBranch } from '../chrome';
import { CountForm } from '../forms';

export const metadata = { title: 'Counts' };

export default async function CountsPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const { t, lang } = await getT();
  const { branches, branch } = await inventoryBranch((await searchParams).branch);
  const [me, counts, products] = await Promise.all([
    api<Me>('/me'),
    branch ? apiOrNull<{ data: CountRow[] }>(`/stock/counts?branchId=${branch.id}`) : null,
    apiOrNull<{ data: Product[] }>('/products?limit=200'),
  ]);
  const canCount = me.activeTenant?.permissions.includes('inventory.adjust') ?? false;
  const href = (c: CountRow) => `/inventory/counts/${c.id}?branch=${branch?.id}`;

  return (
    <InventoryChrome tab="counts" branches={branches} branch={branch}>
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('inv.counts')}</h2>
          {canCount && branch && <CountForm branchId={branch.id} variants={variantOptions(products?.data, { stocked: true })} />}
        </div>
        <Note denom="gold" className="pr-2">
          {counts && counts.data.length > 0 ? (
            <RecordTable
              rows={counts.data}
              rowKey={(c) => c.id}
              columns={[
                { header: t('common.number'), cell: (c) => <Link href={href(c)} className="serial font-semibold text-gold underline">{docNo(c.countNumber)}</Link> },
                { header: t('common.date'), cell: (c) => formatDateTime(c.createdAt, lang) },
                { header: t('common.notes'), cell: (c) => <span className="text-muted">{c.notes ?? ''}</span> },
              ]}
              stacked={{
                title: (c) => <Link href={href(c)} className="underline">{t('inv.countTitle', { n: docNo(c.countNumber) })}</Link>,
                meta: (c) => <Serial>{formatDateTime(c.createdAt, lang)}</Serial>,
              }}
            />
          ) : (
            <Empty>{counts ? t('inv.noCounts') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </InventoryChrome>
  );
}
