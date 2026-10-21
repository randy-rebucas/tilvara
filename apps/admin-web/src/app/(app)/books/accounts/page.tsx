import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Account, type Me } from '@/lib/api';
import { getT } from '@/i18n/server';
import { BooksChrome, booksEntity } from '../chrome';
import { AddAccountForm } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('books.accounts');

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const { t } = await getT();
  const { entities, entity } = await booksEntity((await searchParams).entity);
  const [me, accounts] = await Promise.all([api<Me>('/me'), entity ? apiOrNull<{ data: Account[] }>(`/accounts?legalEntityId=${entity.id}`) : null]);
  const canPost = me.activeTenant?.permissions.includes('accounting.post') ?? false;

  return (
    <BooksChrome tab="accounts" entities={entities} entity={entity}>
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('books.tab.accounts')}</h2>
          {canPost && entity && <AddAccountForm legalEntityId={entity.id} />}
        </div>
        <Note denom="ink" className="pr-2">
          {accounts && accounts.data.length > 0 ? (
            <RecordTable
              rows={accounts.data}
              rowKey={(a) => a.id}
              dimmed={(a) => Boolean(a.archivedAt)}
              columns={[
                { header: t('books.code'), cell: (a) => <Serial className="font-semibold text-ink">{a.code}</Serial> },
                { header: t('books.accountName'), cell: (a) => <Link href={`/books?entity=${entity?.id}&account=${a.id}`} className="underline">{a.name}</Link> },
                { header: t('books.type'), cell: (a) => t(`acct.${a.type}`) },
                { header: '', cell: (a) => (a.systemKey ? <span className="tag" title={a.systemKey}>{t('books.system')}</span> : null) },
              ]}
              stacked={{
                title: (a) => a.name,
                meta: (a) => <Serial>{a.code} · {t(`acct.${a.type}`)}{a.systemKey ? ` · ${t('books.system')}` : ''}</Serial>,
              }}
            />
          ) : (
            <Empty>{accounts ? t('loc.empty') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </BooksChrome>
  );
}
