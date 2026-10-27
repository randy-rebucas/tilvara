import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton, ReasonAction } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type Branch, type CreditEntry, type Customer, type CustomerSale } from '@/lib/api';
import { formatDateTime, formatTin, peso, signOf } from '@/lib/format';
import { branchLabel, isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { ConsentForm, EditCustomerForm, ExportButton } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('customers.item');

/**
 * One customer (ADR-0018): contact details and corrections, marketing consent and how it was given,
 * store credit, purchases, the export for an access request, archiving and anonymising.
 */
export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ cursor?: string; credit?: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { cursor: rawCursor, credit: rawCredit } = await searchParams;
  // Older purchases and older store credit entries, 50 at a time (the API pages them by id).
  const cursor = rawCursor && isUuid(rawCursor) ? rawCursor : undefined;
  const creditCursor = rawCredit && isUuid(rawCredit) ? rawCredit : undefined;
  const { t, lang } = await getT();
  const [customer, sales, credit, branches] = await Promise.all([
    apiOrNull<Customer>(`/customers/${id}`),
    apiOrNull<{ data: CustomerSale[]; nextCursor: string | null }>(`/customers/${id}/sales?limit=50${cursor ? `&cursor=${cursor}` : ''}`),
    apiOrNull<{ data: CreditEntry[]; nextCursor: string | null }>(`/customers/${id}/store-credit?limit=50${creditCursor ? `&cursor=${creditCursor}` : ''}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  if (!customer) notFound();
  const manage = customer.canManage && !customer.anonymisedAt;
  const owed = customer.storeCredit.filter((c) => signOf(c.balance) !== 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/customers" className="text-[0.875rem] text-muted underline">{t('cust.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{customer.displayName}</h1>
        <Serial className="mt-1 block">
          {customer.code && <span className="font-semibold text-green">{customer.code} · </span>}
          {t('cust.since', { date: formatDateTime(customer.createdAt, lang) })}
        </Serial>
      </div>

      {customer.anonymisedAt ? (
        <Callout>{t('cust.anonymised', { date: formatDateTime(customer.anonymisedAt, lang) })}</Callout>
      ) : customer.archivedAt ? (
        <Callout>{t('cust.archived', { date: formatDateTime(customer.archivedAt, lang) })}</Callout>
      ) : null}

      <Note denom="green" className="grid grid-cols-1 gap-4 px-5 py-4 pr-8 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-[0.8125rem] text-muted">{t('cust.phone')}</div>
          <div className="mt-1">{customer.phone ?? '—'}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[0.8125rem] text-muted">{t('auth.email')}</div>
          <div className="mt-1 break-all">{customer.email ?? '—'}</div>
        </div>
        <div>
          <div className="text-[0.8125rem] text-muted">{t('loc.tin')}</div>
          <div className="mt-1">{customer.tin ? formatTin(customer.tin) : '—'}</div>
        </div>
        <div>
          <div className="text-[0.8125rem] text-muted">{t('cust.creditBalance')}</div>
          <div className="mt-1 font-semibold">
            {customer.storeCredit.length === 0 ? <span className="money">{peso('0')}</span> : customer.storeCredit.map((c) => (
              <span key={c.legalEntityId} className="block">
                <span className="money">{peso(c.balance)}</span>
                {customer.storeCredit.length > 1 && <span className="ml-1 text-[0.8125rem] font-normal text-muted">{c.legalEntityName}</span>}
              </span>
            ))}
          </div>
        </div>
        {(customer.address || customer.notes) && (
          <div className="sm:col-span-2 lg:col-span-4">
            {customer.address && <p><span className="text-[0.8125rem] text-muted">{t('cust.address')}: </span>{customer.address}</p>}
            {customer.notes && <p className="mt-1"><span className="text-[0.8125rem] text-muted">{t('cust.notes')}: </span>{customer.notes}</p>}
          </div>
        )}
      </Note>

      <section className="grid gap-3">
        <h2 className="section-title">{t('cust.consentTitle')}</h2>
        <p className="text-[0.9375rem]">
          {customer.marketingConsent
            ? t('cust.consentYes', { date: formatDateTime(customer.marketingConsentAt, lang) })
            : t('cust.consentNo')}
        </p>
        {/* Anyone who may open the customer can withdraw; giving consent needs customers.manage (the API checks both). */}
        {!customer.anonymisedAt && (customer.canManage || customer.marketingConsent) && <ConsentForm customer={customer} />}
      </section>

      {manage && (
        <div className="flex flex-wrap items-start gap-2">
          {!customer.archivedAt && <EditCustomerForm customer={customer} />}
          <ExportButton customer={customer} />
          {!customer.archivedAt && <ActionButton url={`/api/v1/customers/${customer.id}/archive`} label={t('cust.archive')} confirmText={t('cust.archiveConfirm', { name: customer.displayName })} />}
          {owed.length > 0 ? (
            <Callout tone="warn">{t('cust.anonymiseCredit')}</Callout>
          ) : (
            <ReasonAction url={`/api/v1/customers/${customer.id}/anonymise`} label={t('cust.anonymise')} reasonLabel={t('common.reason')} hint={t('cust.anonymiseHint')} danger />
          )}
        </div>
      )}

      <section>
        <h2 className="section-title mb-3">{t('cust.purchases')}</h2>
        <Note denom="none" className="pr-2">
          {sales && sales.data.length > 0 ? (
            <RecordTable
              rows={sales.data}
              rowKey={(s) => s.id}
              columns={[
                { header: t('cust.receipt'), cell: (s) => <Link href={`/sales/${s.id}`} className="serial font-semibold underline">{s.reference}</Link> },
                { header: t('common.branch'), cell: (s) => <Serial className="text-ink">{branchLabel(branches?.data, s.branchId)}</Serial> },
                { header: t('cust.when'), cell: (s) => <span className="text-muted">{formatDateTime(s.completedAt, lang)}</span> },
                { header: t('doc.amountDue'), num: true, cell: (s) => <span className="money font-semibold">{peso(s.amountDue)}</span> },
              ]}
              stacked={{
                title: (s) => <Link href={`/sales/${s.id}`} className="underline">{s.reference}</Link>,
                meta: (s) => <Serial>{branchLabel(branches?.data, s.branchId)} · {formatDateTime(s.completedAt, lang)}</Serial>,
                figure: (s) => <span className="money font-semibold">{peso(s.amountDue)}</span>,
              }}
            />
          ) : (
            <Empty>{sales ? t('cust.noPurchases') : t('common.noAccess')}</Empty>
          )}
        </Note>
        {(sales?.nextCursor || cursor) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {cursor && <Link href={`/customers/${customer.id}`} className="btn">{t('cust.latestPurchases')}</Link>}
            {sales?.nextCursor && <Link href={`/customers/${customer.id}?cursor=${sales.nextCursor}`} className="btn">{t('cust.morePurchases')}</Link>}
          </div>
        )}
      </section>

      <section>
        <h2 className="section-title mb-3">{t('cust.creditTitle')}</h2>
        <Note denom="none" className="pr-2">
          {credit && credit.data.length > 0 ? (
            <RecordTable
              rows={credit.data}
              rowKey={(e) => e.id}
              columns={[
                { header: t('cust.when'), cell: (e) => <span className="text-muted">{formatDateTime(e.createdAt, lang)}</span> },
                {
                  header: t('cust.creditWhat'),
                  // A link only when the person may open the sale or return behind it.
                  cell: (e) => (!e.canOpen
                    ? <span>{e.saleReturnId ? t('cust.creditReturn') : t('cust.creditRedeem')}</span>
                    : e.saleReturnId
                      ? <Link href={`/sales/returns/${e.saleReturnId}`} className="underline">{t('cust.creditReturn')}</Link>
                      : <Link href={`/sales/${e.saleId}`} className="underline">{t('cust.creditRedeem')}</Link>),
                },
                { header: t('common.branch'), cell: (e) => <Serial className="text-ink">{branchLabel(branches?.data, e.branchId)}</Serial> },
                { header: t('cust.creditAmount'), num: true, cell: (e) => <span className="money font-semibold">{peso(e.amount)}</span> },
              ]}
              stacked={{
                title: (e) => (e.saleReturnId ? t('cust.creditReturn') : t('cust.creditRedeem')),
                meta: (e) => <Serial>{formatDateTime(e.createdAt, lang)}</Serial>,
                figure: (e) => <span className="money font-semibold">{peso(e.amount)}</span>,
              }}
            />
          ) : (
            <Empty>{credit ? t('cust.noCredit') : t('common.noAccess')}</Empty>
          )}
        </Note>
        {(credit?.nextCursor || creditCursor) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {creditCursor && <Link href={`/customers/${customer.id}${cursor ? `?cursor=${cursor}` : ''}`} className="btn">{t('cust.latestCredit')}</Link>}
            {credit?.nextCursor && (
              <Link href={`/customers/${customer.id}?${new URLSearchParams({ ...(cursor && { cursor }), credit: credit.nextCursor })}`} className="btn">{t('cust.moreCredit')}</Link>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
