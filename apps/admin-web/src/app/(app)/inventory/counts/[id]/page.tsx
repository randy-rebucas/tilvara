import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { apiOrNull, type Branch, type Count } from '@/lib/api';
import { formatDateTime, peso, qty, signOf } from '@/lib/format';
import { docNo, isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';

export const metadata = { title: 'Count' };

/** Signed figure: a gain shows "+", a loss "−" (never colour alone). */
const signed = (v: string, fmt: (s: string) => string) => (signOf(v) < 0 ? `−${fmt(v.slice(1))}` : signOf(v) > 0 ? `+${fmt(v)}` : fmt(v));

export default async function CountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [count, branches] = await Promise.all([apiOrNull<Count>(`/stock/counts/${id}`), apiOrNull<{ data: Branch[] }>('/branches')]);
  if (!count) notFound();
  const branch = branches?.data.find((b) => b.id === count.branchId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/inventory/counts?branch=${count.branchId}`} className="text-[0.875rem] text-muted underline">{t('inv.counts')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('inv.countTitle', { n: docNo(count.countNumber) })}</h1>
        <Serial className="mt-1 block">
          <span className="font-semibold text-gold">{branch?.code ?? '—'}</span> · {formatDateTime(count.createdAt, lang)}{count.notes ? ` · ${count.notes}` : ''}
        </Serial>
      </div>

      <Note denom="gold" className="flex flex-wrap items-end justify-between gap-4 px-5 py-4 pr-8">
        <Figure label={t('inv.varianceValue')}>{signed(count.varianceValue, peso)}</Figure>
        {branch && <Link href={`/books?entity=${branch.legalEntityId}&source=${count.id}`} className="btn">{t('common.journalEntry')}</Link>}
      </Note>

      <Note denom="gold" className="pr-2">
        <RecordTable
          rows={count.lines}
          rowKey={(l) => l.id}
          columns={[
            { header: t('prod.sku'), cell: (l) => <Serial className="text-ink">{l.sku}</Serial> },
            { header: t('common.item'), cell: (l) => l.name },
            { header: t('inv.before'), num: true, cell: (l) => qty(l.systemQuantity) },
            { header: t('inv.counted'), num: true, cell: (l) => <b>{qty(l.countedQuantity)}</b> },
            { header: t('inv.variance'), num: true, cell: (l) => signed(l.varianceQuantity, qty) },
            { header: t('inv.varianceValue'), num: true, cell: (l) => <span className="money font-semibold">{signed(l.varianceValue, peso)}</span> },
          ]}
          stacked={{
            title: (l) => l.name,
            meta: (l) => <Serial>{l.sku} · {qty(l.systemQuantity)} → {qty(l.countedQuantity)} ({signed(l.varianceQuantity, qty)})</Serial>,
            figure: (l) => <span className="money font-semibold">{signed(l.varianceValue, peso)}</span>,
          }}
          foot={{ cells: ['', t('common.total'), '', '', '', <span key="v" className="money">{signed(count.varianceValue, peso)}</span>], title: t('common.total'), figure: <span className="money">{signed(count.varianceValue, peso)}</span> }}
        />
      </Note>
    </div>
  );
}
