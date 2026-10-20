import Link from 'next/link';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type CustomerSummary, type Me } from '@/lib/api';
import { getT } from '@/i18n/server';
import { AddCustomerForm } from './forms';

export const metadata = { title: 'Customers' };

/** Customers (SPEC §6.9, ADR-0018): search by name, phone, email or number; add one. */
export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; archived?: string; cursor?: string }> }) {
  const sp = await searchParams;
  const { t } = await getT();
  const q = (sp.q ?? '').trim().slice(0, 100);
  const query = new URLSearchParams({ limit: '50' });
  if (q) query.set('q', q);
  if (sp.archived === '1') query.set('includeArchived', 'true');
  if (sp.cursor && /^[0-9a-f-]{36}$/.test(sp.cursor)) query.set('cursor', sp.cursor);
  const [me, list] = await Promise.all([api<Me>('/me'), apiOrNull<{ data: CustomerSummary[]; nextCursor: string | null }>(`/customers?${query}`)]);
  const perms = me.activeTenant?.permissions ?? [];
  const canManage = perms.includes('customers.manage');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('cust.title')} lede={t('cust.lede')} />
      <form method="get" action="/customers" className="flex flex-wrap items-end gap-3">
        <div className="field min-w-[240px] flex-1">
          <label htmlFor="q">{t('cust.search')}</label>
          <input id="q" name="q" className="input" defaultValue={q} placeholder={t('cust.searchHint')} />
        </div>
        <label className="mb-2 flex items-center gap-2 text-[0.875rem]">
          <input type="checkbox" name="archived" value="1" defaultChecked={sp.archived === '1'} /> {t('cust.showArchived')}
        </label>
        <button className="btn mb-[2px]">{t('cust.find')}</button>
      </form>
      {canManage && <AddCustomerForm />}
      <Note denom="green" className="pr-2">
        {list && list.data.length > 0 ? (
          <RecordTable
            rows={list.data}
            rowKey={(c) => c.id}
            dimmed={(c) => Boolean(c.archivedAt)}
            columns={[
              { header: t('cust.name'), cell: (c) => <Link href={`/customers/${c.id}`} className="font-semibold underline">{c.displayName}</Link> },
              { header: t('cust.code'), cell: (c) => <Serial className="text-ink">{c.code ?? '—'}</Serial> },
              { header: t('cust.phone'), cell: (c) => <span>{c.phone ?? '—'}</span> },
              { header: t('auth.email'), cell: (c) => <span className="break-all">{c.email ?? '—'}</span> },
              { header: t('cust.offers'), cell: (c) => (c.marketingConsent ? <span className="tag">{t('cust.offersYes')}</span> : <span className="text-muted">{t('cust.offersNo')}</span>) },
            ]}
            stacked={{
              title: (c) => <Link href={`/customers/${c.id}`} className="underline">{c.displayName}</Link>,
              meta: (c) => <Serial>{[c.code, c.phone, c.email].filter(Boolean).join(' · ') || '—'}</Serial>,
              figure: (c) => (c.marketingConsent ? <span className="tag">{t('cust.offersYes')}</span> : null),
            }}
          />
        ) : (
          <Empty>{list ? (q ? t('cust.noMatch', { q }) : t('cust.empty')) : t('common.noAccess')}</Empty>
        )}
      </Note>
      {list?.nextCursor && (
        <Link className="btn self-start" href={`/customers?${new URLSearchParams({ ...(q && { q }), ...(sp.archived === '1' && { archived: '1' }), cursor: list.nextCursor })}`}>
          {t('cust.more')}
        </Link>
      )}
    </div>
  );
}
