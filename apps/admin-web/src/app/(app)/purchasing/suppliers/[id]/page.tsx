import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { allProducts, api, apiOrNull, type Branch, type Me, type PurchaseOrderRow, type Supplier, type SupplierItem } from '@/lib/api';
import { formatDate, formatDateTime, formatTin, peso } from '@/lib/format';
import { branchLabel, docNo, isUuid, variantOptions } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { AddSupplierItemForm, EditSupplierForm, EditSupplierItemForm } from '../../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('purchasing.suppliers.item');

const OPEN = ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED'];

/** One supplier: details, edit, archive (refused while it has open orders), and its orders. */
export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [me, supplier, orders, branches, catalog] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<Supplier>(`/suppliers/${id}`),
    apiOrNull<{ data: PurchaseOrderRow[] }>(`/purchase-orders?supplierId=${id}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
    apiOrNull<{ data: SupplierItem[] }>(`/suppliers/${id}/items`),
  ]);
  if (!supplier) notFound();
  const canManage = me.activeTenant?.permissions.includes('purchasing.manage') ?? false;
  const products = canManage && !supplier?.archivedAt ? await allProducts() : null;
  const listed = new Set(catalog?.data.map((i) => i.variantId));
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

      <div className="flex flex-wrap items-start gap-2">
        <Link href={`/purchasing/invoices?supplier=${supplier.id}`} className="btn">{t('ap.supplierInvoices')}</Link>
        {canManage && !supplier.archivedAt && (
          <>
            <EditSupplierForm supplier={supplier} />
            <ActionButton url={`/api/v1/suppliers/${supplier.id}/archive`} label={t('pur.archiveSupplier')} confirmText={t('pur.archiveConfirm', { name: supplier.name })} />
          </>
        )}
      </div>

      {/* What this supplier calls each item and charges for it (session 20): orders take the cost from here. */}
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('pur.catalog')}</h2>
          {products && <AddSupplierItemForm supplierId={supplier.id} variants={variantOptions(products.data).filter((v) => !listed.has(v.id))} />}
        </div>
        <Note denom="gold" className="pr-2">
          {catalog && catalog.data.length > 0 ? (
            <RecordTable
              rows={catalog.data}
              rowKey={(i) => i.id}
              columns={[
                { header: t('prod.sku'), cell: (i) => <Serial className="text-ink">{i.sku}</Serial> },
                { header: t('common.item'), cell: (i) => <span>{i.name}{i.preferred && <span className="tag ml-2">{t('pur.preferred')}</span>}</span> },
                { header: t('pur.supplierSku'), cell: (i) => <Serial className="text-ink">{i.supplierSku ?? '—'}</Serial> },
                { header: t('pur.catalogCostLabel'), num: true, cell: (i) => <span className="money">{i.unitCost ? peso(i.unitCost) : '—'}</span> },
                ...(canManage
                  ? [{ header: '', cell: (i: SupplierItem) => (
                      <span className="inline-flex flex-wrap gap-2">
                        <EditSupplierItemForm item={i} supplierId={supplier.id} />
                        <ActionButton url={`/api/v1/supplier-items/${i.id}/archive`} label={t('pur.removeCatalogItem')} />
                      </span>
                    ) }]
                  : []),
              ]}
              stacked={{
                title: (i) => i.name,
                meta: (i) => <Serial>{i.sku} · {t('pur.supplierSku')} {i.supplierSku ?? '—'}{i.preferred ? ` · ${t('pur.preferred')}` : ''}</Serial>,
                figure: (i) => <span className="money font-semibold">{i.unitCost ? peso(i.unitCost) : '—'}</span>,
              }}
            />
          ) : (
            <Empty>{catalog ? t('pur.catalogEmpty') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

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
