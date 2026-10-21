import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { apiOrNull, type Adjustment, type Branch } from '@/lib/api';
import { formatDateTime, peso, signed } from '@/lib/format';
import { isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('inventory.adjustments.item');

export default async function AdjustmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [doc, branches] = await Promise.all([apiOrNull<Adjustment>(`/stock/adjustments/${id}`), apiOrNull<{ data: Branch[] }>('/branches')]);
  if (!doc) notFound();
  const branch = branches?.data.find((b) => b.id === doc.branchId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/inventory?branch=${doc.branchId}`} className="text-[0.875rem] text-muted underline">{t('inv.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t(doc.kind === 'WASTE' ? 'mv.WASTE' : 'mv.ADJUSTMENT')}: {doc.reason}</h1>
        <Serial className="mt-1 block">
          <span className="font-semibold text-violet">{branch?.code ?? '—'}</span> · {formatDateTime(doc.createdAt, lang)}
        </Serial>
      </div>
      <Note denom="gold" className="flex flex-wrap items-end justify-between gap-4 px-5 py-4 pr-8">
        <Figure label={t('common.value')}>{signed(doc.value, peso)}</Figure>
        {branch && <Link href={`/books?entity=${branch.legalEntityId}&source=${doc.id}`} className="btn">{t('common.journalEntry')}</Link>}
      </Note>
      <Note denom="gold" className="pr-2">
        <RecordTable
          rows={doc.lines}
          rowKey={(l) => l.movementId}
          columns={[
            { header: t('prod.sku'), cell: (l) => <Serial className="text-ink">{l.sku}</Serial> },
            { header: t('common.item'), cell: (l) => l.name },
            { header: t('common.quantity'), num: true, cell: (l) => <b>{signed(l.quantity)}</b> },
            { header: t('common.cost'), num: true, cell: (l) => <span className="money">{peso(l.unitCost)}</span> },
            { header: t('common.value'), num: true, cell: (l) => <span className="money font-semibold">{signed(l.value, peso)}</span> },
          ]}
          stacked={{
            title: (l) => l.name,
            meta: (l) => <Serial>{l.sku} · {signed(l.quantity)} × {peso(l.unitCost)}</Serial>,
            figure: (l) => <span className="money font-semibold">{signed(l.value, peso)}</span>,
          }}
        />
      </Note>
    </div>
  );
}
