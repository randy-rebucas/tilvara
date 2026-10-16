import Link from 'next/link';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Branch, type Me, type Product, type PurchaseOrderRow, type Supplier } from '@/lib/api';
import { formatDate, formatTin, peso } from '@/lib/format';
import { branchLabel, docNo, variantOptions } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { AddSupplierForm, NewOrderForm } from './forms';

export const metadata = { title: 'Purchasing' };

type List<T> = { data: T[] };
const STATUSES = ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const;

export default async function PurchasingPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { t, lang } = await getT();
  const { status } = await searchParams;
  const filter = STATUSES.find((s) => s === status);
  const [me, suppliers, orders, branches, products] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<List<Supplier>>('/suppliers'),
    apiOrNull<List<PurchaseOrderRow>>(`/purchase-orders${filter ? `?status=${filter}` : ''}`),
    apiOrNull<List<Branch>>('/branches'),
    apiOrNull<List<Product>>('/products?limit=200'),
  ]);
  const canManage = me.activeTenant?.permissions.includes('purchasing.manage') ?? false;
  const activeSuppliers = suppliers?.data.filter((s) => !s.archivedAt) ?? [];
  const activeBranches = branches?.data.filter((b) => !b.archivedAt) ?? [];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t('pur.title')} lede={t('pur.lede')} />

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
                { header: 'PO', cell: (o) => <Link href={`/purchasing/orders/${o.id}`} className="serial font-semibold text-gold underline">{docNo(o.poNumber)}</Link> },
                { header: t('pur.supplierOne'), cell: (o) => o.supplierName },
                { header: t('common.branch'), cell: (o) => <Serial className="text-ink">{branchLabel(branches?.data, o.branchId)}</Serial> },
                { header: t('common.status'), cell: (o) => <span className="tag">{t(`status.${o.status}` as MessageKey)}</span> },
                { header: t('pur.expectedOn'), cell: (o) => <span className="text-muted">{formatDate(o.expectedOn, lang)}</span> },
                { header: t('pur.orderValue'), num: true, cell: (o) => <span className="money font-semibold">{peso(o.orderedValue)}</span> },
              ]}
              stacked={{
                title: (o) => <Link href={`/purchasing/orders/${o.id}`} className="underline">{o.supplierName}</Link>,
                meta: (o) => <Serial>PO {docNo(o.poNumber)} · {branchLabel(branches?.data, o.branchId)} · {t(`status.${o.status}` as MessageKey)}</Serial>,
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
          <h2 className="section-title pt-2">{t('pur.suppliers')}</h2>
          {canManage && <AddSupplierForm />}
        </div>
        <Note denom="gold" className="pr-2">
          {suppliers && suppliers.data.length > 0 ? (
            <RecordTable
              rows={suppliers.data}
              rowKey={(s) => s.id}
              columns={[
                { header: t('pur.supplierCode'), cell: (s) => <Serial className="font-semibold text-gold">{s.code}</Serial> },
                { header: t('pur.supplierName'), cell: (s) => <span className="font-semibold">{s.name}</span> },
                { header: t('loc.tin'), cell: (s) => <Serial className="text-ink">{formatTin(s.tin)}</Serial> },
                { header: t('pur.phone'), cell: (s) => s.phone ?? '—' },
                { header: t('pur.terms'), num: true, cell: (s) => <Serial className="text-ink">{t('pur.termsDays', { n: s.paymentTermsDays })}</Serial> },
              ]}
              stacked={{
                title: (s) => s.name,
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
