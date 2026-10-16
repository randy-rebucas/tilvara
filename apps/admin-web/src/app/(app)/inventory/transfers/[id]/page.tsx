import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { api, apiOrNull, type Branch, type Me, type Transfer } from '@/lib/api';
import { formatDateTime, peso, qty, signOf } from '@/lib/format';
import { branchLabel, docNo, isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { ReceiveTransferForm } from '../../forms';

export const metadata = { title: 'Transfer' };

export default async function TransferPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ branch?: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { branch: back } = await searchParams;
  const { t, lang } = await getT();
  const [me, transfer, branches] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<Transfer>(`/stock/transfers/${id}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  if (!transfer) notFound();
  const from = branches?.data.find((b) => b.id === transfer.fromBranchId);
  const received = transfer.status === 'RECEIVED';
  const canReceive = !received && (me.activeTenant?.permissions.includes('inventory.transfer') ?? false);
  const short = transfer.lines.some((l) => l.shortQuantity !== null && signOf(l.shortQuantity) > 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/inventory/transfers${back && isUuid(back) ? `?branch=${back}` : ''}`} className="text-[0.875rem] text-muted underline">{t('inv.transfers')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('inv.transferTitle', { n: docNo(transfer.transferNumber) })}</h1>
        <Serial className="mt-1 block">
          <span className="font-semibold text-gold">{branchLabel(branches?.data, transfer.fromBranchId)} → {branchLabel(branches?.data, transfer.toBranchId)}</span> · {formatDateTime(transfer.createdAt, lang)}
          {transfer.receivedAt && ` → ${formatDateTime(transfer.receivedAt, lang)}`}
        </Serial>
      </div>

      <Note denom="gold" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-4">
        <div>
          <div className="text-[0.8125rem] text-muted">{t('common.status')}</div>
          <span className="tag mt-1">{t(`status.${transfer.status}` as MessageKey)}</span>
        </div>
        <Figure label={t('inv.sentValue')}>{peso(transfer.sentValue)}</Figure>
        {received ? (
          <Figure label={t('inv.transitLoss')}>{peso(transfer.transitLossValue)}</Figure>
        ) : (
          <Figure label={t('inv.inTransit')}>{peso(transfer.inTransitValue)}</Figure>
        )}
        {from && (
          <div className="self-end">
            <Link href={`/books?entity=${from.legalEntityId}&source=${transfer.id}`} className="btn">{t('common.journalEntry')}</Link>
          </div>
        )}
      </Note>

      {canReceive && <div><ReceiveTransferForm transfer={transfer} /></div>}

      <Note denom="gold" className="pr-2">
        <RecordTable
          rows={transfer.lines}
          rowKey={(l) => l.id}
          columns={[
            { header: t('prod.sku'), cell: (l) => <Serial className="text-ink">{l.sku}</Serial> },
            { header: t('common.item'), cell: (l) => l.name },
            { header: t('inv.sent'), num: true, cell: (l) => <b>{qty(l.quantity)}</b> },
            { header: t('inv.arrived'), num: true, cell: (l) => qty(l.receivedQuantity) },
            ...(short ? [{ header: t('inv.short'), num: true, cell: (l: Transfer['lines'][number]) => qty(l.shortQuantity) }, { header: t('inv.shortReason'), cell: (l: Transfer['lines'][number]) => <span className="text-muted">{l.discrepancyReason ?? ''}</span> }] : []),
            { header: t('common.cost'), num: true, cell: (l) => <span className="money">{peso(l.unitCost)}</span> },
          ]}
          stacked={{
            title: (l) => l.name,
            meta: (l) => <Serial>{l.sku} · {t('inv.arrived')} {qty(l.receivedQuantity)}{l.discrepancyReason ? ` · ${l.discrepancyReason}` : ''}</Serial>,
            figure: (l) => <b>{qty(l.quantity)}</b>,
          }}
        />
      </Note>
    </div>
  );
}
