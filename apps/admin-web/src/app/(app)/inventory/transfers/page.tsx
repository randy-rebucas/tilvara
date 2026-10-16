import Link from 'next/link';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Me, type Product, type TransferRow } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { branchLabel, docNo, variantOptions } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { InventoryChrome, inventoryBranch } from '../chrome';
import { TransferForm } from '../forms';

export const metadata = { title: 'Transfers' };

export default async function TransfersPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const { t, lang } = await getT();
  const { branches, branch } = await inventoryBranch((await searchParams).branch);
  const [me, transfers, products] = await Promise.all([
    api<Me>('/me'),
    branch ? apiOrNull<{ data: TransferRow[] }>(`/stock/transfers?branchId=${branch.id}`) : null,
    apiOrNull<{ data: Product[] }>('/products?limit=200'),
  ]);
  const canTransfer = me.activeTenant?.permissions.includes('inventory.transfer') ?? false;
  const destinations = branch ? branches.filter((b) => b.id !== branch.id && b.legalEntityId === branch.legalEntityId) : [];
  const href = (x: TransferRow) => `/inventory/transfers/${x.id}?branch=${branch?.id}`;

  return (
    <InventoryChrome tab="transfers" branches={branches} branch={branch}>
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('inv.transfers')}</h2>
          {canTransfer && branch && destinations.length > 0 && (
            <TransferForm from={branch} destinations={destinations} variants={variantOptions(products?.data, { stocked: true })} />
          )}
        </div>
        {canTransfer && branch && destinations.length === 0 && <div className="mb-3"><Callout>{t('inv.oneBranch')}</Callout></div>}
        <Note denom="gold" className="pr-2">
          {transfers && transfers.data.length > 0 ? (
            <RecordTable
              rows={transfers.data}
              rowKey={(x) => x.id}
              columns={[
                { header: t('common.number'), cell: (x) => <Link href={href(x)} className="serial font-semibold text-gold underline">{docNo(x.transferNumber)}</Link> },
                { header: t('inv.direction'), cell: (x) => (x.fromBranchId === branch?.id ? t('inv.out') : t('inv.in')) },
                { header: t('inv.route'), cell: (x) => <Serial className="text-ink">{branchLabel(branches, x.fromBranchId)} → {branchLabel(branches, x.toBranchId)}</Serial> },
                { header: t('common.status'), cell: (x) => <span className="tag">{t(`status.${x.status}` as MessageKey)}</span> },
                { header: t('common.date'), cell: (x) => <span className="text-muted">{formatDateTime(x.createdAt, lang)}</span> },
              ]}
              stacked={{
                title: (x) => <Link href={href(x)} className="underline">{branchLabel(branches, x.fromBranchId)} → {branchLabel(branches, x.toBranchId)}</Link>,
                meta: (x) => <Serial>{docNo(x.transferNumber)} · {formatDateTime(x.createdAt, lang)}</Serial>,
                figure: (x) => <span className="tag">{t(`status.${x.status}` as MessageKey)}</span>,
              }}
            />
          ) : (
            <Empty>{transfers ? t('inv.noTransfers') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </InventoryChrome>
  );
}
