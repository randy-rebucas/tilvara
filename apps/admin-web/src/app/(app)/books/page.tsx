import Link from 'next/link';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, ApiError, type Account, type JournalRow, type Me } from '@/lib/api';
import { Download } from 'lucide-react';
import { formatDate, peso, todayManila } from '@/lib/format';
import { docNo, isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { BooksChrome, booksEntity, sourceHref } from './chrome';
import { ManualEntryForm } from './forms';
import { pageTitle } from '@/i18n/page-title';
import { exportErrorMessage } from '@/lib/report-csv';

export const generateMetadata = pageTitle('books');

/** The journal, null without access, or the API's own rule for a refused filter (e.g. "from" after "to"). */
async function loadJournal(path: string): Promise<{ data: JournalRow[] } | { error: string } | null> {
  try {
    return await api<{ data: JournalRow[] }>(path);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status === 403 || e.status === 404) return null;
    const issues = (e.details?.issues as { message: string }[] | undefined)?.map((i) => i.message).join(' ');
    return { error: issues || e.message };
  }
}

const SOURCE_TYPES = ['SALE', 'SALE_RETURN', 'GOODS_RECEIPT', 'SUPPLIER_RETURN', 'SUPPLIER_INVOICE', 'SUPPLIER_PAYMENT', 'SUPPLIER_NOTE', 'STOCK_ADJUSTMENT', 'STOCK_COUNT', 'PACK_OPENING', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT', 'CASH_MOVEMENT', 'CASH_VARIANCE', 'MANUAL', 'REVERSAL'] as const;
const isDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** As `LIMIT 500` in the API's journal list. */
const JOURNAL_LIMIT = 500;

// exportError: a journal CSV that failed comes back with the API's code (books/export/route.ts).
type Query = { entity?: string; source?: string; account?: string; from?: string; to?: string; type?: string; exportError?: string };

export default async function JournalPage({ searchParams }: { searchParams: Promise<Query> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const { entities, entity } = await booksEntity(sp.entity);
  const source = sp.source && isUuid(sp.source) ? sp.source : undefined;
  const account = sp.account && isUuid(sp.account) ? sp.account : undefined;
  const from = isDate(sp.from) ? sp.from : undefined;
  const to = isDate(sp.to) ? sp.to : undefined;
  const type = SOURCE_TYPES.find((s) => s === sp.type);
  const filter = `${source ? `&sourceId=${source}` : ''}${account ? `&accountId=${account}` : ''}`;
  const narrowed = `${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}${type ? `&sourceType=${type}` : ''}`;
  const today = todayManila();
  const exportTo = to ?? today;
  const exportFrom = from ?? `${exportTo.slice(0, 8)}01`;
  const [me, entries, accounts] = await Promise.all([
    api<Me>('/me'),
    entity ? loadJournal(`/journal-entries?legalEntityId=${entity.id}${filter}${narrowed}`) : null,
    entity ? apiOrNull<{ data: Account[] }>(`/accounts?legalEntityId=${entity.id}`) : null,
  ]);
  // An archived entity's books are read only here.
  const canPost = (me.activeTenant?.permissions.includes('accounting.post') ?? false) && !entity?.archivedAt;
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
        {entity && (
          // A plain GET form: the filter lives in the URL, so a view of the journal can be bookmarked.
          <form method="get" action="/books" className="mb-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="entity" value={entity.id} />
            {source && <input type="hidden" name="source" value={source} />}
            {account && <input type="hidden" name="account" value={account} />}
            <div className="field">
              <label htmlFor="from">{t('common.from')}</label>
              <input id="from" name="from" type="date" className="input" defaultValue={from} />
            </div>
            <div className="field">
              <label htmlFor="to">{t('common.to')}</label>
              <input id="to" name="to" type="date" className="input" defaultValue={to} />
            </div>
            <div className="field">
              <label htmlFor="type">{t('books.source')}</label>
              <select id="type" name="type" className="input" defaultValue={type ?? ''}>
                <option value="">{t('common.all')}</option>
                {SOURCE_TYPES.map((s) => <option key={s} value={s}>{t(`src.${s}` as MessageKey)}</option>)}
              </select>
            </div>
            <button className="btn">{t('common.show')}</button>
            {narrowed && <Link href={`/books?entity=${entity.id}${source ? `&source=${source}` : ''}${account ? `&account=${account}` : ''}`} className="self-center text-[0.875rem] underline">{t('books.clearFilter')}</Link>}
          </form>
        )}
        {entity && (
          // The accountant's export: the dates above, else this month so far.
          <p className="mb-3 flex flex-wrap items-center gap-2 text-[0.875rem] text-muted">
            <a href={`/books/export?entity=${entity.id}&from=${exportFrom}&to=${exportTo}`} className="btn">
              <Download aria-hidden className="size-4" /> {t('books.exportCsv')}
            </a>
            {t('books.exportHint', { from: formatDate(exportFrom, lang), to: formatDate(exportTo, lang) })}
          </p>
        )}
        {exportErrorMessage(t, sp.exportError) && <Callout tone="error">{exportErrorMessage(t, sp.exportError)}</Callout>}
        {entries && 'error' in entries && <Callout tone="error">{entries.error}</Callout>}
        <Note denom="ink" className="pr-2">
          {entries && 'data' in entries && entries.data.length > 0 ? (
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
                title: (e) => <Link href={entryHref(e)} className="serial text-ink underline">{docNo(e.entryNumber)}</Link>,
                meta: (e) => (
                  <>
                    <Serial>{formatDate(e.entryDate, lang)} · {sourceLabel(e)}</Serial>
                    {e.memo && <span className="block">{e.memo}</span>}
                  </>
                ),
                figure: (e) => <span className="money font-semibold">{peso(e.total)}</span>,
              }}
            />
          ) : (
            <Empty>{entries ? (narrowed ? t('books.noMatches') : t('books.noEntries')) : t('common.noAccess')}</Empty>
          )}
        </Note>
        {/* The API answers the newest JOURNAL_LIMIT entries of a view (accounting.service.ts listEntries). */}
        {entries && 'data' in entries && entries.data.length >= JOURNAL_LIMIT && (
          <p className="mt-2 text-[0.8125rem] text-muted">{t('books.capped', { n: JOURNAL_LIMIT })}</p>
        )}
      </section>
    </BooksChrome>
  );
}
