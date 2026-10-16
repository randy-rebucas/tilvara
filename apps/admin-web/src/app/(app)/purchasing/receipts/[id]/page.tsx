import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { apiOrNull, type Branch, type GoodsReceipt, type Product, type Supplier } from '@/lib/api';
import { formatDateTime, peso, qty, signOf } from '@/lib/format';
import { docNo, isUuid, variantNames } from '@/lib/options';
import { getT } from '@/i18n/server';

export const metadata = { title: 'Goods receipt' };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [receipt, branches, products] = await Promise.all([
    apiOrNull<GoodsReceipt>(`/goods-receipts/${id}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
    apiOrNull<{ data: Product[] }>('/products?limit=200'),
  ]);
  if (!receipt) notFound();
  const supplier = await apiOrNull<Supplier>(`/suppliers/${receipt.supplierId}`);
  const branch = branches?.data.find((b) => b.id === receipt.branchId);
  const names = variantNames(products?.data);
  const rejected = receipt.lines.some((l) => signOf(l.rejectedQuantity) > 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={receipt.purchaseOrderId ? `/purchasing/orders/${receipt.purchaseOrderId}` : '/purchasing'} className="text-[0.875rem] text-muted underline">
          {receipt.purchaseOrderId ? t('pur.againstOrder') : t('pur.title')}
        </Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('pur.receiptTitle', { n: docNo(receipt.receiptNumber) })}</h1>
        <Serial className="mt-1 block">
          <span className="font-semibold text-gold">{supplier?.code ?? '—'}</span> · {supplier?.name ?? ''} · {branch?.code ?? '—'} · {formatDateTime(receipt.createdAt, lang)}
        </Serial>
      </div>

      <Note denom="gold" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-4">
        <div>
          <div className="text-[0.8125rem] text-muted">{t('pur.invoiceRef')}</div>
          <Serial className="mt-1 block text-ink">{receipt.supplierInvoiceRef ?? '—'}</Serial>
        </div>
        <div>
          <div className="text-[0.8125rem] text-muted">{t('pur.deliveryRef')}</div>
          <Serial className="mt-1 block text-ink">{receipt.supplierDeliveryRef ?? '—'}</Serial>
        </div>
        <Figure label={t('pur.receivedValue')}>{peso(receipt.receivedValue)}</Figure>
        {branch && (
          <div className="self-end">
            <Link href={`/books?entity=${branch.legalEntityId}&source=${receipt.id}`} className="btn">{t('common.journalEntry')}</Link>
          </div>
        )}
      </Note>

      <Note denom="gold" className="pr-2">
        <RecordTable
          rows={receipt.lines}
          rowKey={(l) => l.id}
          columns={[
            { header: t('prod.sku'), cell: (l) => <Serial className="text-ink">{names.get(l.variantId)?.sku ?? '—'}</Serial> },
            { header: t('common.item'), cell: (l) => names.get(l.variantId)?.name ?? '—' },
            { header: t('pur.received'), num: true, cell: (l) => <b>{qty(l.quantity)}</b> },
            ...(rejected
              ? [
                  { header: t('pur.rejected'), num: true, cell: (l: GoodsReceipt['lines'][number]) => qty(l.rejectedQuantity) },
                  { header: t('pur.rejectReason'), cell: (l: GoodsReceipt['lines'][number]) => <span className="text-muted">{l.rejectionReason ?? ''}</span> },
                ]
              : []),
            { header: t('common.cost'), num: true, cell: (l) => <span className="money">{peso(l.unitCost)}</span> },
            { header: t('common.value'), num: true, cell: (l) => <span className="money font-semibold">{peso(l.lineValue)}</span> },
          ]}
          stacked={{
            title: (l) => names.get(l.variantId)?.name ?? '—',
            meta: (l) => (
              <Serial>
                {names.get(l.variantId)?.sku} · {qty(l.quantity)} × {peso(l.unitCost)}
                {signOf(l.rejectedQuantity) > 0 && ` · ${t('pur.rejected')} ${qty(l.rejectedQuantity)}`}
              </Serial>
            ),
            figure: (l) => <span className="money font-semibold">{peso(l.lineValue)}</span>,
          }}
        />
      </Note>
    </div>
  );
}
