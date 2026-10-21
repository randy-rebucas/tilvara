import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReasonAction } from '@/components/actions';
import { Callout, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Branch, type JournalEntry, type Me } from '@/lib/api';
import { formatDate, formatDateTime, peso, signOf, sumDecimal } from '@/lib/format';
import { branchLabel, docNo, isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { sourceHref } from '../../chrome';
import { pageTitle } from '@/i18n/page-title';

/** Undone through their document (cancel the invoice, void the payment, an opposite note), never by hand; the API refuses it too. */
const NOT_REVERSIBLE = ['REVERSAL', 'SUPPLIER_INVOICE', 'SUPPLIER_PAYMENT', 'SUPPLIER_NOTE', 'SALE_TIP_REFUND'];

export const generateMetadata = pageTitle('books.entries.item');

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [me, entry, branches] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<JournalEntry>(`/journal-entries/${id}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  if (!entry) notFound();
  const canPost = me.activeTenant?.permissions.includes('accounting.post') ?? false;
  const original = entry.reversesEntryId ? await apiOrNull<JournalEntry>(`/journal-entries/${entry.reversesEntryId}`) : null;
  const debits = sumDecimal(entry.lines.map((l) => l.debit));
  const credits = sumDecimal(entry.lines.map((l) => l.credit));
  const source = sourceHref(entry, entry.legalEntityId);
  const amount = (v: string) => (signOf(v) === 0 ? <span className="text-muted">·</span> : <span className="money font-semibold">{peso(v)}</span>);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/books?entity=${entry.legalEntityId}`} className="text-[0.875rem] text-muted underline">{t('books.tab.journal')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('books.entryTitle', { n: docNo(entry.entryNumber) })}</h1>
        <Serial className="mt-1 block">
          <span className="font-semibold text-ink">{t(`src.${entry.sourceType}` as MessageKey)}</span> · {formatDate(entry.entryDate, lang)} · {formatDateTime(entry.createdAt, lang)}
        </Serial>
        {entry.memo && <p className="mt-2 max-w-[68ch]">{entry.memo}</p>}
      </div>

      {original && <Callout>{t('books.reverses', { n: docNo(original.entryNumber) })}</Callout>}
      {entry.reversedBy && (
        <Callout>
          <Link href={`/books/entries/${entry.reversedBy}`} className="underline">{t('books.reversedBy')}</Link>
        </Callout>
      )}

      <div className="flex flex-wrap items-start gap-2">
        {source && <Link href={source} className="btn">{t('books.openSource')}</Link>}
        {canPost && !entry.reversedBy && !NOT_REVERSIBLE.includes(entry.sourceType) && (
          <ReasonAction url={`/api/v1/journal-entries/${entry.id}/reverse`} label={t('books.reverse')} reasonLabel={t('books.why')} hint={t('books.reverseHint')} field="memo" danger idempotent />
        )}
      </div>

      <Note denom="ink" className="pr-2">
        <RecordTable
          rows={entry.lines}
          rowKey={(l) => l.id}
          columns={[
            { header: t('books.code'), cell: (l) => <Serial className="text-ink">{l.accountCode}</Serial> },
            { header: t('books.account'), cell: (l) => l.accountName },
            { header: t('common.branch'), cell: (l) => <Serial>{l.branchId ? branchLabel(branches?.data, l.branchId) : '—'}</Serial> },
            { header: t('books.memo'), cell: (l) => <span className="text-muted">{l.memo ?? ''}</span> },
            { header: t('books.debit'), num: true, cell: (l) => amount(l.debit) },
            { header: t('books.credit'), num: true, cell: (l) => amount(l.credit) },
          ]}
          stacked={{
            title: (l) => l.accountName,
            meta: (l) => <Serial>{l.accountCode} · {signOf(l.debit) !== 0 ? t('books.debit') : t('books.credit')}</Serial>,
            figure: (l) => <span className="money font-semibold">{peso(signOf(l.debit) !== 0 ? l.debit : l.credit)}</span>,
          }}
          foot={{
            cells: ['', t('books.totals'), '', '', <span key="d" className="money">{peso(debits)}</span>, <span key="c" className="money">{peso(credits)}</span>],
            title: t('books.totals'),
            figure: <span className="money">{peso(debits)} / {peso(credits)}</span>,
          }}
        />
      </Note>
    </div>
  );
}
