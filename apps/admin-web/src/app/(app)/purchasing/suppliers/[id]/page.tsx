import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Branch, type Me, type PurchaseOrderRow, type Supplier } from '@/lib/api';
import { formatDate, formatDateTime, formatTin, peso } from '@/lib/format';
import { branchLabel, docNo, isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { EditSupplierForm } from '../../forms';

export const metadata = { title: 'Supplier' };

const OPEN = ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED'];

/** One supplier: details, edit, archive (refused while it has open orders), and its orders. */
export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [me, supplier, orders, branches] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<Supplier>(`/suppliers/${id}`),
    apiOrNull<{ data: PurchaseOrderRow[] }>(`/purchase-orders?supplierId=${id}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  if (!supplier) notFound();
  const canManage = me.activeTenant?.permissions.includes('purchasing.manage') ?? false;
  const open = orders?.data.filter((o) => OPEN.includes(o.status)).length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/purchasing" className="text-[0.875rem] text-muted underline">{t('pur.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{supplier.name}</h1>
        <Serial className="mt-1 block">
          <span className="font-semibold text-gold">{supplier.code}</span> · TIN {formatTin(supplier.tin)} · {t('pur.termsDays', { n: supplier.paymentTermsDays })}
        </Serial>
      </div>

      {supplier.archivedAt && <Callout>{t('pur.supplierArchived', { date: formatDateTime(supplier.archivedAt, lang) })}</Callout>}

      <Note denom="gold" className="grid grid-cols-1 gap-4 px-5 py-4 pr-8 sm:grid-cols-3">
        <div>
          <div className="text-[0.8125rem] text-muted">{t('pur.phone')}</div>
          <div className="mt-1">{supplier.phone ?? '—'}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[0.8125rem] text-muted">{t('auth.email')}</div>
          <div className="mt-1 break-all">{supplier.email ?? '—'}</div>
        </div>
        <div>
          <div className="text-[0.8125rem] text-muted">{t('pur.openOrders')}</div>
          <div className="mt-1 font-semibold tabular-nums">{open}</div>
        </div>
      </Note>

      {canManage && !supplier.archivedAt && (
        <div className="flex flex-wrap items-start gap-2">
          <EditSupplierForm supplier={supplier} />
          <ActionButton url={`/api/v1/suppliers/${supplier.id}/archive`} label={t('pur.archiveSupplier')} confirmText={t('pur.archiveConfirm', { name: supplier.name })} />
        </div>
      )}

      <section>
        <h2 className="section-title mb-3">{t('pur.orders')}</h2>
        <Note denom="gold" className="pr-2">
          {orders && orders.data.length > 0 ? (
            <RecordTable
              rows={orders.data}
              rowKey={(o) => o.id}
              dimmed={(o) => o.status === 'CANCELLED' || o.status === 'CLOSED'}
              columns={[
                { header: t('pur.poNo'), cell: (o) => <Link href={`/purchasing/orders/${o.id}`} className="serial font-semibold text-gold underline">{docNo(o.poNumber)}</Link> },
                { header: t('common.branch'), cell: (o) => <Serial className="text-ink">{branchLabel(branches?.data, o.branchId)}</Serial> },
                { header: t('common.status'), cell: (o) => <span className="tag">{t(`status.${o.status}` as MessageKey)}</span> },
                { header: t('pur.expectedOn'), cell: (o) => <span className="text-muted">{formatDate(o.expectedOn, lang)}</span> },
                { header: t('pur.orderValue'), num: true, cell: (o) => <span className="money font-semibold">{peso(o.orderedValue)}</span> },
              ]}
              stacked={{
                title: (o) => <Link href={`/purchasing/orders/${o.id}`} className="underline">{t('pur.poNo')} {docNo(o.poNumber)}</Link>,
                meta: (o) => <Serial>{branchLabel(branches?.data, o.branchId)} · {t(`status.${o.status}` as MessageKey)}</Serial>,
                figure: (o) => <span className="money font-semibold">{peso(o.orderedValue)}</span>,
              }}
            />
          ) : (
            <Empty>{orders ? t('pur.noOrders') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </div>
  );
}
