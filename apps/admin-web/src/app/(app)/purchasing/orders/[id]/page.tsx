import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton, ReasonAction } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { allProducts, api, apiOrNull, type Branch, type Me, type PurchaseOrder, type Supplier } from '@/lib/api';
import { formatDate, formatDateTime, peso, qty, signOf } from '@/lib/format';
import { branchLabel, docNo, isUuid, variantOptions } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { EditDraftForm, ReceiveForm } from '../../forms';

export const metadata = { title: 'Purchase order' };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [me, order, branches] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<PurchaseOrder>(`/purchase-orders/${id}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  if (!order) notFound();
  const perms = me.activeTenant?.permissions ?? [];
  const canManage = perms.includes('purchasing.manage');
  const editing = canManage && order.status === 'DRAFT';
  const [suppliers, products] = editing ? await Promise.all([apiOrNull<{ data: Supplier[] }>('/suppliers'), allProducts()]) : [null, null];
  const canReceive = canManage || perms.includes('inventory.adjust');
  const receiving = order.status === 'APPROVED' || order.status === 'PARTIALLY_RECEIVED';
  const base = `/api/v1/purchase-orders/${order.id}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/purchasing" className="text-[0.875rem] text-muted underline">{t('pur.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('pur.orderTitle', { n: docNo(order.poNumber) })}</h1>
        <Serial className="mt-1 block">
          <span className="font-semibold text-gold">{order.supplier.code}</span> · {order.supplier.name} · {branchLabel(branches?.data, order.branchId)} · {formatDateTime(order.createdAt, lang)}
        </Serial>
      </div>

      {order.status === 'DRAFT' && <Callout>{t('pur.draftNote')}</Callout>}
      {order.endReason && <Callout>{t('pur.endedNote', { reason: order.endReason })}</Callout>}

      <Note denom="gold" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-4">
        <div>
          <div className="text-[0.8125rem] text-muted">{t('common.status')}</div>
          <span className="tag mt-1">{t(`status.${order.status}` as MessageKey)}</span>
        </div>
        <div>
          <div className="text-[0.8125rem] text-muted">{t('pur.expectedOn')}</div>
          <div className="mt-1">{formatDate(order.expectedOn, lang)}</div>
        </div>
        <Figure label={t('pur.orderValue')}>{peso(order.orderedValue)}</Figure>
        <Figure label={t('pur.receivedValue')}>{peso(order.receivedValue)}</Figure>
      </Note>

      {/* Receiving opens full width in its own row, so the other actions never wrap around the panel. */}
      {canReceive && receiving && <div><ReceiveForm order={order} /></div>}
      {editing && <div><EditDraftForm order={order} suppliers={suppliers?.data ?? []} variants={variantOptions(products?.data)} /></div>}
      {canManage && (
        <div className="flex flex-wrap items-start gap-2">
          {order.status === 'DRAFT' && <ActionButton url={`${base}/approve`} label={t('pur.approve')} primary />}
          {(order.status === 'DRAFT' || order.status === 'APPROVED') && (
            <ReasonAction url={`${base}/cancel`} label={t('pur.cancelOrder')} reasonLabel={t('common.reason')} danger />
          )}
          {(order.status === 'PARTIALLY_RECEIVED' || order.status === 'RECEIVED') && (
            <ReasonAction url={`${base}/close`} label={t('pur.closeOrder')} reasonLabel={t('common.reason')} hint={t('pur.closeHint')} />
          )}
        </div>
      )}

      <Note denom="gold" className="pr-2">
        <RecordTable
          rows={order.lines}
          rowKey={(l) => l.id}
          columns={[
            { header: t('prod.sku'), cell: (l) => <Serial className="text-ink">{l.sku}{l.supplierSku && <span className="block text-muted">{t('pur.supplierSku')} {l.supplierSku}</span>}</Serial> },
            { header: t('common.item'), cell: (l) => l.name },
            { header: t('pur.ordered'), num: true, cell: (l) => qty(l.quantity) },
            { header: t('pur.received'), num: true, cell: (l) => qty(l.receivedQuantity) },
            { header: t('pur.rejected'), num: true, cell: (l) => qty(l.rejectedQuantity) },
            { header: t('pur.remaining'), num: true, cell: (l) => <b>{qty(l.remainingQuantity)}</b> },
            { header: t('common.cost'), num: true, cell: (l) => <span className="money">{peso(l.unitCost)}</span> },
            { header: t('common.value'), num: true, cell: (l) => <span className="money font-semibold">{peso(l.lineValue)}</span> },
          ]}
          stacked={{
            title: (l) => l.name,
            meta: (l) => (
              <Serial>
                {l.sku} · {t('pur.received')} {qty(l.receivedQuantity)}/{qty(l.quantity)}
                {signOf(l.rejectedQuantity) > 0 && ` · ${t('pur.rejected')} ${qty(l.rejectedQuantity)}`} · {t('pur.remaining')} {qty(l.remainingQuantity)}
              </Serial>
            ),
            figure: (l) => <span className="money font-semibold">{peso(l.lineValue)}</span>,
          }}
          foot={{ cells: ['', t('common.total'), '', '', '', '', '', <span key="v" className="money">{peso(order.orderedValue)}</span>], title: t('common.total'), figure: <span className="money">{peso(order.orderedValue)}</span> }}
        />
      </Note>

      <section>
        <h2 className="section-title mb-3">{t('pur.receipts')}</h2>
        <Note denom="gold" className="pr-2">
          {order.receipts.length > 0 ? (
            <ul>
              {order.receipts.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-hair-soft px-4 py-3 last:border-b-0">
                  <Link href={`/purchasing/receipts/${r.id}`} className="font-semibold underline">{t('pur.receiptTitle', { n: docNo(r.receiptNumber) })}</Link>
                  <Serial>{r.supplierInvoiceRef ? `${r.supplierInvoiceRef} · ` : ''}{formatDateTime(r.createdAt, lang)}</Serial>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('pur.noReceipts')}</Empty>
          )}
        </Note>
      </section>
    </div>
  );
}
