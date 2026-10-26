import Link from 'next/link';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { allProducts, api, apiOrNull, type Branch, type GoodsReceiptRow, type Me, type PurchaseOrderRow, type Supplier, type SupplierReturn } from '@/lib/api';
import { formatDate, formatDateTime, formatTin, peso } from '@/lib/format';
import { branchLabel, docNo, variantOptions } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { AddSupplierForm, NewOrderForm, UnorderedReceiptForm } from './forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('purchasing');

type List<T> = { data: T[] };
const STATUSES = ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const;

export default async function PurchasingPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { t, lang } = await getT();
  const { status } = await searchParams;
  const filter = STATUSES.find((s) => s === status);
  const [me, suppliers, orders, branches, products] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<List<Supplier>>('/suppliers?includeArchived=true'),
    apiOrNull<List<PurchaseOrderRow>>(`/purchase-orders${filter ? `?status=${filter}` : ''}`),
    apiOrNull<List<Branch>>('/branches'),
    allProducts(),
  ]);
  const permissions = me.activeTenant?.permissions ?? [];
  const canManage = permissions.includes('purchasing.manage');
  // Receiving is open to purchasing or to whoever adjusts stock (the API checks the branch).
  const canReceive = canManage || permissions.includes('inventory.adjust');
  const activeSuppliers = suppliers?.data.filter((s) => !s.archivedAt) ?? [];
  const activeBranches = branches?.data.filter((b) => !b.archivedAt) ?? [];
  // Goods receipts and returns to suppliers, newest first, across the branches this person can see (listed per branch by the API),
  // archived ones included: their documents stay part of the record.
  const allBranches = branches?.data ?? [];
  const [receiptLists, returnLists] = await Promise.all([
    Promise.all(allBranches.map((b) => apiOrNull<List<GoodsReceiptRow>>(`/goods-receipts?branchId=${b.id}`))),
    Promise.all(allBranches.map((b) => apiOrNull<List<Omit<SupplierReturn, 'lines' | 'creditValue'>>>(`/supplier-returns?branchId=${b.id}`))),
  ]);
  const receipts = receiptLists.flatMap((l) => l?.data ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  const returns = returnLists.flatMap((l) => l?.data ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  const dated = products?.data.some((p) => p.tracksExpiry && !p.archivedAt) ?? false;
  const supplierName = new Map(suppliers?.data.map((s) => [s.id, s.name]));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t('pur.title')} lede={t('pur.lede')} actions={<Link href="/purchasing/invoices" className="btn">{t('ap.open')}</Link>} />

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('pur.orders')}</h2>
          {canManage && activeSuppliers.length > 0 && activeBranches.length > 0 && (
            <NewOrderForm branches={activeBranches} suppliers={activeSuppliers} variants={variantOptions(products?.data)} />
          )}
        </div>
        <nav aria-label={t('common.status')} className="mb-3 flex flex-wrap gap-1.5">
          {[undefined, ...STATUSES].map((s) => (
            <Link
              key={s ?? 'all'}
              href={s ? `/purchasing?status=${s}` : '/purchasing'}
              aria-current={s === filter ? 'page' : undefined}
              className={`tag h-8! px-3! text-[0.8125rem]! ${s === filter ? 'border-blue! text-ink!' : 'hover:text-ink'}`}
            >
              {s ? t(`status.${s}` as MessageKey) : t('common.all')}
            </Link>
          ))}
        </nav>
        <Note denom="gold" className="pr-2">
          {orders && orders.data.length > 0 ? (
            <RecordTable
              rows={orders.data}
              rowKey={(o) => o.id}
              dimmed={(o) => o.status === 'CANCELLED' || o.status === 'CLOSED'}
              columns={[
                { header: t('pur.poNo'), cell: (o) => <Link href={`/purchasing/orders/${o.id}`} className="serial font-semibold text-gold underline">{docNo(o.poNumber)}</Link> },
                { header: t('pur.supplierOne'), cell: (o) => o.supplierName },
                { header: t('common.branch'), cell: (o) => <Serial className="text-ink">{branchLabel(branches?.data, o.branchId)}</Serial> },
                { header: t('common.status'), cell: (o) => <span className="tag">{t(`status.${o.status}` as MessageKey)}</span> },
                { header: t('pur.expectedOn'), cell: (o) => <span className="text-muted">{formatDate(o.expectedOn, lang)}</span> },
                { header: t('pur.orderValue'), num: true, cell: (o) => <span className="money font-semibold">{peso(o.orderedValue)}</span> },
              ]}
              stacked={{
                title: (o) => <Link href={`/purchasing/orders/${o.id}`} className="underline">{o.supplierName}</Link>,
                meta: (o) => <Serial>{t('pur.poNo')} {docNo(o.poNumber)} · {branchLabel(branches?.data, o.branchId)} · {t(`status.${o.status}` as MessageKey)}</Serial>,
                figure: (o) => <span className="money font-semibold">{peso(o.orderedValue)}</span>,
              }}
            />
          ) : (
            <Empty>{orders ? (activeSuppliers.length === 0 ? t('pur.needSupplier') : t('pur.noOrders')) : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('pur.receipts')}</h2>
          {canReceive && activeSuppliers.length > 0 && activeBranches.length > 0 && (
            <UnorderedReceiptForm branches={activeBranches} suppliers={activeSuppliers} variants={variantOptions(products?.data)} dated={dated} />
          )}
        </div>
        <Note denom="gold" className="pr-2">
          {receipts.length > 0 ? (
            <RecordTable
              rows={receipts}
              rowKey={(r) => r.id}
              columns={[
                { header: t('common.number'), cell: (r) => <Link href={`/purchasing/receipts/${r.id}`} className="serial font-semibold text-gold underline">{docNo(r.receiptNumber)}</Link> },
                { header: t('pur.supplierOne'), cell: (r) => r.supplierName },
                { header: t('common.branch'), cell: (r) => <Serial className="text-ink">{branchLabel(branches?.data, r.branchId)}</Serial> },
                { header: t('pur.orderOne'), cell: (r) => (r.purchaseOrderId ? <Link href={`/purchasing/orders/${r.purchaseOrderId}`} className="underline">{t('pur.viewOrder')}</Link> : <span className="text-muted">{t('pur.noOrder')}</span>) },
                { header: t('pur.invoiceRef'), cell: (r) => <Serial className="text-ink">{r.supplierInvoiceRef ?? '—'}</Serial> },
                { header: t('common.date'), cell: (r) => <span className="text-muted">{formatDateTime(r.createdAt, lang)}</span> },
              ]}
              stacked={{
                title: (r) => <Link href={`/purchasing/receipts/${r.id}`} className="underline">{r.supplierName}</Link>,
                meta: (r) => <Serial>{docNo(r.receiptNumber)} · {branchLabel(branches?.data, r.branchId)} · {r.purchaseOrderId ? t('pur.fromOrder') : t('pur.noOrder')} · {formatDateTime(r.createdAt, lang)}</Serial>,
              }}
            />
          ) : (
            <Empty>{t('pur.noReceipts')}</Empty>
          )}
        </Note>
      </section>

      <section>
        <h2 className="section-title mb-3">{t('pur.returns')}</h2>
        <Note denom="gold" className="pr-2">
          {returns.length > 0 ? (
            <RecordTable
              rows={returns}
              rowKey={(r) => r.id}
              columns={[
                { header: t('common.number'), cell: (r) => <Link href={`/purchasing/returns/${r.id}`} className="serial font-semibold text-gold underline">{docNo(r.returnNumber)}</Link> },
                { header: t('pur.supplierOne'), cell: (r) => supplierName.get(r.supplierId) ?? '—' },
                { header: t('common.branch'), cell: (r) => <Serial className="text-ink">{branchLabel(branches?.data, r.branchId)}</Serial> },
                { header: t('common.reason'), cell: (r) => <span className="text-muted">{r.reason}</span> },
                { header: t('common.date'), cell: (r) => <span className="text-muted">{formatDateTime(r.createdAt, lang)}</span> },
              ]}
              stacked={{
                title: (r) => <Link href={`/purchasing/returns/${r.id}`} className="underline">{supplierName.get(r.supplierId) ?? '—'}</Link>,
                meta: (r) => <Serial>{docNo(r.returnNumber)} · {branchLabel(branches?.data, r.branchId)} · {r.reason}</Serial>,
              }}
            />
          ) : (
            <Empty>{t('pur.noReturnsYet')}</Empty>
          )}
        </Note>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('pur.suppliers')}</h2>
          {canManage && <AddSupplierForm />}
        </div>
        <Note denom="gold" className="pr-2">
          {suppliers && suppliers.data.length > 0 ? (
            <RecordTable
              rows={suppliers.data}
              rowKey={(s) => s.id}
              dimmed={(s) => Boolean(s.archivedAt)}
              columns={[
                { header: t('pur.supplierCode'), cell: (s) => <Link href={`/purchasing/suppliers/${s.id}`} className="serial font-semibold text-gold underline">{s.code}</Link> },
                { header: t('pur.supplierName'), cell: (s) => <span className="font-semibold">{s.name}{s.archivedAt && <span className="tag ml-2">{t('common.archived')}</span>}</span> },
                { header: t('loc.tin'), cell: (s) => <Serial className="text-ink">{formatTin(s.tin)}</Serial> },
                { header: t('pur.phone'), cell: (s) => s.phone ?? '—' },
                { header: t('pur.terms'), num: true, cell: (s) => <Serial className="text-ink">{t('pur.termsDays', { n: s.paymentTermsDays })}</Serial> },
              ]}
              stacked={{
                title: (s) => <Link href={`/purchasing/suppliers/${s.id}`} className="underline">{s.name}</Link>,
                meta: (s) => <Serial><span className="text-gold">{s.code}</span> · TIN {formatTin(s.tin)} · {t('pur.termsDays', { n: s.paymentTermsDays })}</Serial>,
              }}
            />
          ) : (
            <Empty>{suppliers ? t('pur.noSuppliers') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </div>
  );
}
