import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { ApiError, apiOrNull, type TrialBalance } from '@/lib/api';
import { peso, todayManila } from '@/lib/format';
import { getT } from '@/i18n/server';
import { BooksChrome, booksEntity } from '../chrome';

export const metadata = { title: 'Trial balance' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<{ entity?: string; from?: string; to?: string }> }) {
  const { t } = await getT();
  const sp = await searchParams;
  const { entities, entity } = await booksEntity(sp.entity);
  const to = sp.to && DATE.test(sp.to) ? sp.to : todayManila();
  const from = sp.from && DATE.test(sp.from) ? sp.from : `${to.slice(0, 7)}-01`;
  let tb: TrialBalance | null = null;
  let problem: string | null = null;
  if (entity) {
    try {
      tb = await apiOrNull<TrialBalance>(`/reports/trial-balance?legalEntityId=${entity.id}&from=${from}&to=${to}`);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 400) throw e;
      problem = e.message;
    }
  }

  return (
    <BooksChrome tab="trial" entities={entities} entity={entity}>
      <form method="get" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="entity" value={entity?.id ?? ''} />
        <div className="field">
          <label htmlFor="tb-from">{t('common.from')}</label>
          <input id="tb-from" className="input" type="date" name="from" defaultValue={from} />
        </div>
        <div className="field">
          <label htmlFor="tb-to">{t('common.to')}</label>
          <input id="tb-to" className="input" type="date" name="to" defaultValue={to} />
        </div>
        <button className="btn">{t('common.show')}</button>
      </form>
      {problem && <Callout tone="error">{problem}</Callout>}
      {tb && (tb.totals.debit === tb.totals.credit && tb.totals.closing === '0.00'
        ? <p className="text-[0.875rem] text-muted">{t('books.balanced')}</p>
        : <Callout tone="error">{t('books.unbalanced')}</Callout>)}
      <Note denom="ink" className="pr-2">
        {tb && tb.data.length > 0 ? (
          <RecordTable
            rows={tb.data}
            rowKey={(r) => r.accountId}
            columns={[
              { header: t('books.code'), cell: (r) => <Serial className="text-ink">{r.code}</Serial> },
              { header: t('books.account'), cell: (r) => r.name },
              { header: t('books.type'), cell: (r) => <span className="text-muted">{t(`acct.${r.type}`)}</span> },
              { header: t('books.opening'), num: true, cell: (r) => <span className="money">{peso(r.opening)}</span> },
              { header: t('books.debit'), num: true, cell: (r) => <span className="money">{peso(r.debit)}</span> },
              { header: t('books.credit'), num: true, cell: (r) => <span className="money">{peso(r.credit)}</span> },
              { header: t('books.closing'), num: true, cell: (r) => <span className="money font-semibold">{peso(r.closing)}</span> },
            ]}
            stacked={{
              title: (r) => r.name,
              meta: (r) => <Serial>{r.code} · Dr {peso(r.debit)} · Cr {peso(r.credit)}</Serial>,
              figure: (r) => <span className="money font-semibold">{peso(r.closing)}</span>,
            }}
            foot={{
              cells: ['', t('books.totals'), '', '', <span key="d" className="money">{peso(tb.totals.debit)}</span>, <span key="c" className="money">{peso(tb.totals.credit)}</span>, <span key="b" className="money">{peso(tb.totals.closing)}</span>],
              title: t('books.totals'),
              figure: <span className="money">Dr {peso(tb.totals.debit)} · Cr {peso(tb.totals.credit)}</span>,
            }}
          />
        ) : (
          <Empty>{tb ? t('books.noActivity') : problem ? '—' : t('common.noAccess')}</Empty>
        )}
      </Note>
    </BooksChrome>
  );
}
