import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Account, type JournalRow, type Me } from '@/lib/api';
import { formatDate, peso } from '@/lib/format';
import { docNo, isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { BooksChrome, booksEntity, sourceHref } from './chrome';
import { ManualEntryForm } from './forms';

export const metadata = { title: 'Journal' };

export default async function JournalPage({ searchParams }: { searchParams: Promise<{ entity?: string; source?: string; account?: string }> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const { entities, entity } = await booksEntity(sp.entity);
  const source = sp.source && isUuid(sp.source) ? sp.source : undefined;
  const account = sp.account && isUuid(sp.account) ? sp.account : undefined;
  const filter = `${source ? `&sourceId=${source}` : ''}${account ? `&accountId=${account}` : ''}`;
  const [me, entries, accounts] = await Promise.all([
    api<Me>('/me'),
    entity ? apiOrNull<{ data: JournalRow[] }>(`/journal-entries?legalEntityId=${entity.id}${filter}`) : null,
    entity ? apiOrNull<{ data: Account[] }>(`/accounts?legalEntityId=${entity.id}`) : null,
  ]);
  const canPost = me.activeTenant?.permissions.includes('accounting.post') ?? false;
  const entryHref = (e: JournalRow) => `/books/entries/${e.id}?entity=${entity?.id}`;
  const sourceLabel = (e: JournalRow) => t(`src.${e.sourceType}` as MessageKey);

  return (
    <BooksChrome tab="journal" entities={entities} entity={entity}>
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('books.tab.journal')}</h2>
          {canPost && entity && accounts && !filter && (
            <ManualEntryForm legalEntityId={entity.id} accounts={accounts.data.filter((a) => !a.archivedAt).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))} />
          )}
        </div>
        {filter && (
          <p className="mb-3 text-[0.875rem] text-muted">
            {source ? t('books.oneDocument') : t('books.oneAccount', { account: accounts?.data.find((a) => a.id === account)?.name ?? '' })} <Link href={`/books?entity=${entity?.id}`} className="text-ink underline">{t('books.showAll')}</Link>
          </p>
        )}
        <Note denom="ink" className="pr-2">
          {entries && entries.data.length > 0 ? (
            <RecordTable
              rows={entries.data}
              rowKey={(e) => e.id}
              columns={[
                { header: t('books.entry'), cell: (e) => <Link href={entryHref(e)} className="serial font-semibold underline">{docNo(e.entryNumber)}</Link> },
                { header: t('common.date'), cell: (e) => formatDate(e.entryDate, lang) },
                {
                  header: t('books.source'),
                  cell: (e) => {
                    const href = entity && sourceHref(e, entity.id);
                    return href ? <Link href={href} className="underline">{sourceLabel(e)}</Link> : sourceLabel(e);
                  },
                },
                { header: t('books.memo'), cell: (e) => <span className="text-muted">{e.memo ?? ''}</span> },
                { header: t('books.amount'), num: true, cell: (e) => <span className="money font-semibold">{peso(e.total)}</span> },
              ]}
              stacked={{
                title: (e) => <Link href={entryHref(e)} className="underline">{sourceLabel(e)}</Link>,
                meta: (e) => <Serial>{docNo(e.entryNumber)} · {formatDate(e.entryDate, lang)}{e.memo ? ` · ${e.memo}` : ''}</Serial>,
                figure: (e) => <span className="money font-semibold">{peso(e.total)}</span>,
              }}
            />
          ) : (
            <Empty>{entries ? t('books.noEntries') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </BooksChrome>
  );
}
