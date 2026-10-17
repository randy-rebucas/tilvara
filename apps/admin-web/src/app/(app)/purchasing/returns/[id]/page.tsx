import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { apiOrNull, variantNamesById, type Branch, type Supplier, type SupplierReturn } from '@/lib/api';
import { formatDateTime, peso, qty } from '@/lib/format';
import { docNo, isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';

export const metadata = { title: 'Supplier return' };

/** A return to the supplier: what left stock, the credit due, and its journal entry. */
export default async function SupplierReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [doc, branches] = await Promise.all([apiOrNull<SupplierReturn>(`/supplier-returns/${id}`), apiOrNull<{ data: Branch[] }>('/branches')]);
  if (!doc) notFound();
  const [supplier, names] = await Promise.all([apiOrNull<Supplier>(`/suppliers/${doc.supplierId}`), variantNamesById(doc.lines.map((l) => l.variantId))]);
  const branch = branches?.data.find((b) => b.id === doc.branchId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={doc.goodsReceiptId ? `/purchasing/receipts/${doc.goodsReceiptId}` : '/purchasing'} className="text-[0.875rem] text-muted underline">
          {doc.goodsReceiptId ? t('pur.fromReceipt') : t('pur.title')}
        </Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('pur.returnTitle', { n: docNo(doc.returnNumber) })}</h1>
        <Serial className="mt-1 block">
          <span className="font-semibold text-gold">{supplier?.code ?? '—'}</span> · {supplier?.name ?? ''} · {branch?.code ?? '—'} · {formatDateTime(doc.createdAt, lang)}
        </Serial>
      </div>

      <Note denom="gold" className="grid grid-cols-1 gap-4 px-5 py-4 pr-8 sm:grid-cols-3">
        <div className="min-w-0">
          <div className="text-[0.8125rem] text-muted">{t('common.reason')}</div>
          <div className="mt-1">{doc.reason}</div>
        </div>
        <Figure label={t('pur.creditValue')}>{peso(doc.creditValue)}</Figure>
        {branch && (
          <div className="self-end">
            <Link href={`/books?entity=${branch.legalEntityId}&source=${doc.id}`} className="btn">{t('common.journalEntry')}</Link>
          </div>
        )}
      </Note>

      <Note denom="gold" className="pr-2">
        <RecordTable
          rows={doc.lines}
          rowKey={(l) => l.id}
          columns={[
            { header: t('prod.sku'), cell: (l) => <Serial className="text-ink">{names.get(l.variantId)?.sku ?? '—'}</Serial> },
            { header: t('common.item'), cell: (l) => names.get(l.variantId)?.name ?? '—' },
            { header: t('pur.returned'), num: true, cell: (l) => <b>{qty(l.quantity)}</b> },
            { header: t('pur.creditCost'), num: true, cell: (l) => <span className="money">{peso(l.creditUnitCost)}</span> },
            { header: t('common.value'), num: true, cell: (l) => <span className="money font-semibold">{peso(l.creditValue)}</span> },
          ]}
          stacked={{
            title: (l) => names.get(l.variantId)?.name ?? '—',
            meta: (l) => <Serial>{names.get(l.variantId)?.sku} · {qty(l.quantity)} × {peso(l.creditUnitCost)}</Serial>,
            figure: (l) => <span className="money font-semibold">{peso(l.creditValue)}</span>,
          }}
          foot={{ cells: ['', t('common.total'), '', '', <span key="v" className="money">{peso(doc.creditValue)}</span>], title: t('common.total'), figure: <span className="money">{peso(doc.creditValue)}</span> }}
        />
      </Note>
    </div>
  );
}
