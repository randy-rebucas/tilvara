import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Note, Serial } from '@/components/note';
import { api, apiOrNull, type Branch, type CountSheet, type Me } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { SheetCounter } from '../../sheets';

export const metadata = { title: 'Count sheet' };

export default async function CountSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [sheet, branches, me] = await Promise.all([apiOrNull<CountSheet>(`/stock/count-sheets/${id}`), apiOrNull<{ data: Branch[] }>('/branches'), api<Me>('/me')]);
  if (!sheet) notFound();
  const branch = branches?.data.find((b) => b.id === sheet.branchId);
  const canPost = me.activeTenant?.permissions.includes('inventory.adjust') ?? false;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/inventory/counts?branch=${sheet.branchId}`} className="text-[0.875rem] text-muted underline">{t('inv.counts')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('sheet.heading')}</h1>
        <Serial className="mt-1 block">
          <span className="font-semibold text-violet">{branch?.code ?? '—'}</span> · {t('sheet.frozenAt', { at: formatDateTime(sheet.frozenAt, lang) })} · {t(`sheet.status.${sheet.status}`)}
          {sheet.blind ? ` · ${t('sheet.blindTag')}` : ''}
          {sheet.notes ? ` · ${sheet.notes}` : ''}
        </Serial>
        {sheet.status === 'CANCELLED' && sheet.cancelReason && <p className="mt-2 text-[0.875rem] text-muted">{t('sheet.cancelledBecause', { reason: sheet.cancelReason })}</p>}
        {sheet.status === 'POSTED' && sheet.stockCountId && (
          <Link href={`/inventory/counts/${sheet.stockCountId}`} className="btn mt-3">{t('sheet.openCount')}</Link>
        )}
      </div>
      <Note denom="gold" className="px-5 py-4 pr-8">
        <SheetCounter sheet={sheet} canPost={canPost} />
      </Note>
    </div>
  );
}
