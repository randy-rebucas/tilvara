import { ReasonAction } from '@/components/actions';
import { Empty, Note, Serial } from '@/components/note';
import { api, apiOrNull, type Me, type Period } from '@/lib/api';
import { formatDateTime, todayManila } from '@/lib/format';
import { getT } from '@/i18n/server';
import { BooksChrome, booksEntity } from '../chrome';
import { ClosePeriodForm } from '../forms';

export const metadata = { title: 'Periods' };

function previousMonth(today: string) {
  const [y, m] = today.split('-').map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
}

function monthName(month: string, lang: 'en' | 'fil') {
  const [y, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'fil' ? 'fil-PH' : 'en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, 1)));
}

export default async function PeriodsPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const { t, lang } = await getT();
  const { entities, entity } = await booksEntity((await searchParams).entity);
  const [me, periods] = await Promise.all([api<Me>('/me'), entity ? apiOrNull<{ data: Period[] }>(`/accounting/periods?legalEntityId=${entity.id}`) : null]);
  const canPost = me.activeTenant?.permissions.includes('accounting.post') ?? false;

  return (
    <BooksChrome tab="periods" entities={entities} entity={entity}>
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title pt-2">{t('books.tab.periods')}</h2>
            <p className="mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('books.periodsHint')}</p>
          </div>
          {canPost && entity && <ClosePeriodForm legalEntityId={entity.id} defaultMonth={previousMonth(todayManila())} />}
        </div>
        <Note denom="ink" className="pr-2">
          {periods && periods.data.length > 0 ? (
            <ul>
              {periods.data.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-hair-soft px-4 py-3 last:border-b-0">
                  <div>
                    <div className="font-semibold capitalize">{monthName(p.month, lang)}</div>
                    <Serial>{p.month}{p.closedAt ? ` · ${t('books.closedOn', { date: formatDateTime(p.closedAt, lang) })}` : ''}</Serial>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tag">{t(p.status === 'CLOSED' ? 'status.CLOSED' : 'status.OPEN')}</span>
                    {canPost && entity && p.status === 'CLOSED' && (
                      <ReasonAction url="/api/v1/accounting/periods/reopen" label={t('books.reopen')} reasonLabel={t('books.reopenReason')} body={{ legalEntityId: entity.id, month: p.month }} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{periods ? t('books.noPeriods') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </BooksChrome>
  );
}
