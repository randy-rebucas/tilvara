import Link from 'next/link';
import { Callout, Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { ScopePicker } from '@/components/scope';
import { api, apiOrNull, type Branch, type LegalEntity, type Me, type PayablesAging, type Supplier, type SupplierInvoiceRow, type SupplierInvoiceStatus, type UninvoicedReceipt } from '@/lib/api';
import { formatDate, peso, signOf, subtractQty } from '@/lib/format';
import { branchLabel, docNo, isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { BatchPaymentForm, NewInvoiceForm } from './forms';

export const metadata = { title: 'Supplier invoices' };

const STATUSES: SupplierInvoiceStatus[] = ['OPEN', 'PAID', 'CANCELLED'];
const BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;

type Query = { entity?: string; status?: string; supplier?: string; branch?: string; pay?: string };

/**
 * Payables per legal entity (ADR-0013 amendment): the invoices, entering a new one against goods
 * receipts still waiting for an invoice (branch + supplier picked by a plain GET form, so the
 * receipts are read on the server), and what is owed by age.
 */
export default async function SupplierInvoicesPage({ searchParams }: { searchParams: Promise<Query> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const [me, entityList, suppliers, branches] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: LegalEntity[] }>('/legal-entities'),
    apiOrNull<{ data: Supplier[] }>('/suppliers?includeArchived=true'),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  const entities = entityList?.data.filter((e) => !e.archivedAt) ?? [];
  const entity = entities.find((e) => e.id === sp.entity) ?? entities[0];
  const status = STATUSES.find((s) => s === sp.status);
  const supplierFilter = sp.supplier && isUuid(sp.supplier) ? sp.supplier : undefined;
  const permissions = me.activeTenant?.permissions ?? [];
  const canEnter = permissions.includes('purchasing.manage') || permissions.includes('accounting.post');
  const canPay = permissions.includes('accounting.post');
  const paySupplier = canPay ? suppliers?.data.find((s) => s.id === sp.pay) : undefined;
  const entityBranches = branches?.data.filter((b) => !b.archivedAt && b.legalEntityId === entity?.id) ?? [];
  const pickBranch = entityBranches.find((b) => b.id === sp.branch);
  const pickSupplier = suppliers?.data.find((s) => s.id === sp.supplier);
  const query = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ entity: entity?.id, status, supplier: supplierFilter, ...extra })) if (v) p.set(k, v);
    return `/purchasing/invoices?${p.toString()}`;
  };

  const [invoices, aging, uninvoiced, payable] = await Promise.all([
    entity ? apiOrNull<{ data: SupplierInvoiceRow[] }>(`/supplier-invoices?legalEntityId=${entity.id}${status ? `&status=${status}` : ''}${supplierFilter ? `&supplierId=${supplierFilter}` : ''}`) : null,
    entity ? apiOrNull<PayablesAging>(`/reports/payables-aging?legalEntityId=${entity.id}`) : null,
    canEnter && pickBranch && pickSupplier ? apiOrNull<{ data: UninvoicedReceipt[] }>(`/uninvoiced-receipts?branchId=${pickBranch.id}&supplierId=${pickSupplier.id}`) : null,
    entity && paySupplier ? apiOrNull<{ data: SupplierInvoiceRow[] }>(`/supplier-invoices?legalEntityId=${entity.id}&supplierId=${paySupplier.id}&status=OPEN`) : null,
  ]);
  const today = aging?.asOf ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const ledgerDiffers = aging && signOf(subtractQty(aging.ledgerBalance, aging.totals.total)) !== 0;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link href="/purchasing" className="text-[0.875rem] text-muted underline">{t('pur.title')}</Link>
        <PageHeader title={t('ap.title')} lede={t('ap.lede')} />
      </div>
      <ScopePicker label={t('loc.entityOne')} items={entities.map((e) => ({ id: e.id, name: e.registeredName }))} selected={entity?.id} href={(id) => `/purchasing/invoices?entity=${id}`} />

      {!entity ? (
        <Note><Empty>{t('books.noEntity')}</Empty></Note>
      ) : (
        <>
          {canEnter && entityBranches.length > 0 && suppliers && (
            <section className="flex flex-col gap-3">
              <h2 className="section-title">{t('ap.new')}</h2>
              <p className="text-[0.875rem] text-muted">{t('ap.pickHint')}</p>
              <form method="get" action="/purchasing/invoices" className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="entity" value={entity.id} />
                <div className="field">
                  <label htmlFor="ap-branch">{t('common.branch')}</label>
                  <select id="ap-branch" name="branch" className="input" defaultValue={pickBranch?.id ?? entityBranches[0]!.id}>
                    {entityBranches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ap-supplier">{t('pur.supplierOne')}</label>
                  <select id="ap-supplier" name="supplier" className="input" defaultValue={pickSupplier?.id}>
                    {suppliers.data.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
                  </select>
                </div>
                <button className="btn">{t('ap.findReceipts')}</button>
              </form>
              {uninvoiced && pickSupplier && (
                uninvoiced.data.length > 0
                  ? <div><NewInvoiceForm key={`${pickBranch?.id}-${pickSupplier.id}`} supplierId={pickSupplier.id} receipts={uninvoiced.data} today={today} /></div>
                  : <Callout>{t('ap.noUninvoiced')}</Callout>
              )}
            </section>
          )}

          {canPay && suppliers && (
            <section className="flex flex-col gap-3">
              <h2 className="section-title">{t('ap.payMany')}</h2>
              <p className="text-[0.875rem] text-muted">{t('ap.payManyHint')}</p>
              <form method="get" action="/purchasing/invoices" className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="entity" value={entity.id} />
                <div className="field">
                  <label htmlFor="ap-pay-supplier">{t('ap.payManySupplier')}</label>
                  <select id="ap-pay-supplier" name="pay" className="input" defaultValue={paySupplier?.id}>
                    {suppliers.data.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
                  </select>
                </div>
                <button className="btn">{t('ap.payManyLoad')}</button>
              </form>
              {payable && paySupplier && (
                payable.data.length > 0
                  ? <BatchPaymentForm key={paySupplier.id} supplierId={paySupplier.id} today={today} invoices={payable.data.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, dueDate: i.dueDate, balance: i.balance }))} />
                  : <Callout>{t('ap.payManyNone')}</Callout>
              )}
            </section>
          )}

          <section>
            <h2 className="section-title mb-3">{t('ap.title')}</h2>
            <nav aria-label={t('common.status')} className="mb-3 flex flex-wrap gap-1.5">
              {[undefined, ...STATUSES].map((s) => (
                <Link
                  key={s ?? 'all'}
                  href={query({ status: s, branch: undefined })}
                  aria-current={s === status ? 'page' : undefined}
                  className={`tag h-8! px-3! text-[0.8125rem]! ${s === status ? 'border-blue! text-ink!' : 'hover:text-ink'}`}
                >
                  {s ? t(`ap.status.${s}`) : t('common.all')}
                </Link>
              ))}
            </nav>
            <Note denom="gold" className="pr-2">
              {invoices && invoices.data.length > 0 ? (
                <RecordTable
                  rows={invoices.data}
                  rowKey={(i) => i.id}
                  dimmed={(i) => i.status !== 'OPEN'}
                  columns={[
                    { header: t('ap.invoiceNo'), cell: (i) => <Link href={`/purchasing/invoices/${i.id}`} className="serial font-semibold text-gold underline">{i.invoiceNumber}</Link> },
                    { header: t('pur.supplierOne'), cell: (i) => i.supplier.name },
                    { header: t('common.branch'), cell: (i) => <Serial className="text-ink">{branchLabel(branches?.data, i.branchId)}</Serial> },
                    { header: t('ap.dueDate'), cell: (i) => <span className="text-muted">{formatDate(i.dueDate, lang)}</span> },
                    { header: t('common.status'), cell: (i) => <span className="tag">{t(`ap.status.${i.status}`)}</span> },
                    { header: t('ap.total'), num: true, cell: (i) => <span className="money">{peso(i.totalAmount)}</span> },
                    { header: t('ap.balance'), num: true, cell: (i) => <span className="money font-semibold">{peso(i.balance)}</span> },
                  ]}
                  stacked={{
                    title: (i) => <Link href={`/purchasing/invoices/${i.id}`} className="underline">{i.supplier.name}</Link>,
                    meta: (i) => <Serial>{i.invoiceNumber} · {t('ap.entryNo')} {docNo(i.entryNumber)} · {formatDate(i.dueDate, lang)} · {t(`ap.status.${i.status}`)}</Serial>,
                    figure: (i) => <span className="money font-semibold">{peso(i.balance)}</span>,
                  }}
                />
              ) : (
                <Empty>{invoices ? (status || supplierFilter ? t('ap.noneMatch') : t('ap.none')) : t('common.noAccess')}</Empty>
              )}
            </Note>
          </section>

          {aging && (
            <section>
              <h2 className="section-title mb-1">{t('ap.aging')}</h2>
              <p className="mb-3 text-[0.875rem] text-muted">{t('ap.agingAsOf', { date: formatDate(aging.asOf, lang) })}</p>
              <Note denom="ink" className="pr-2">
                {aging.suppliers.length > 0 ? (
                  <RecordTable
                    rows={aging.suppliers}
                    rowKey={(r) => r.supplier.id}
                    columns={[
                      { header: t('pur.supplierOne'), cell: (r) => <Link href={query({ supplier: r.supplier.id, status: 'OPEN', branch: undefined })} className="underline">{r.supplier.name}</Link> },
                      ...BUCKETS.map((b) => ({ header: t(`ap.bucket.${b}`), num: true, cell: (r: PayablesAging['suppliers'][number]) => <span className="money">{peso(r[b])}</span> })),
                      { header: t('common.total'), num: true, cell: (r) => <span className="money font-semibold">{peso(r.total)}</span> },
                    ]}
                    foot={{
                      cells: [t('common.total'), ...BUCKETS.map((b) => <span key={b} className="money">{peso(aging.totals[b])}</span>), <span key="t" className="money font-semibold">{peso(aging.totals.total)}</span>],
                      title: t('common.total'),
                      figure: <span className="money font-semibold">{peso(aging.totals.total)}</span>,
                    }}
                    stacked={{
                      title: (r) => r.supplier.name,
                      meta: (r) => <Serial>{BUCKETS.filter((b) => signOf(r[b]) !== 0).map((b) => `${t(`ap.bucket.${b}`)} ${peso(r[b])}`).join(' · ')}</Serial>,
                      figure: (r) => <span className="money font-semibold">{peso(r.total)}</span>,
                    }}
                  />
                ) : (
                  <Empty>{t('ap.agingNone')}</Empty>
                )}
              </Note>
              <p className="mt-2 text-[0.875rem] text-muted">
                {ledgerDiffers ? t('ap.ledgerDiffers', { amount: peso(aging.ledgerBalance) }) : t('ap.ledger', { amount: peso(aging.ledgerBalance) })}
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
