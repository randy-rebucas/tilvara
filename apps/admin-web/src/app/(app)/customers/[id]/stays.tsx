import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type Branch, type StayRow } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { branchLabel } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { nightsBetween, StayTag } from '../../lodging/chrome';

/** A guest's stays (ADR-0023): bookings, stays in house and past stays, each linking to its stay and folio. */
export async function CustomerStays({ customerId, branches }: { customerId: string; branches: Branch[] | undefined }) {
  const { t, lang } = await getT();
  const stays = await apiOrNull<{ data: StayRow[] }>(`/stays?${new URLSearchParams({ customerId, limit: '50' })}`);
  if (!stays) return null;
  const status = (s: StayRow['status']) => t(`lod.status.${s}` as MessageKey);
  return (
    <section aria-labelledby="customer-stays" className="grid gap-3">
      <h2 id="customer-stays" className="section-title">{t('lod.customerStays')}</h2>
      <Note denom="none" className="pr-2">
        {stays.data.length > 0 ? (
          <RecordTable
            rows={stays.data}
            rowKey={(s) => s.id}
            dimmed={(s) => s.status === 'CANCELLED' || s.status === 'NO_SHOW'}
            columns={[
              { header: t('lod.dates'), cell: (s) => <Link href={`/lodging/stays/${s.id}`} className="underline">{formatDate(s.arrivalDate, lang)} → {formatDate(s.departureDate, lang)}</Link> },
              { header: t('common.branch'), cell: (s) => <Serial className="text-ink">{branchLabel(branches, s.branchId)}</Serial> },
              { header: t('lod.room'), cell: (s) => <Serial className="text-ink">{s.room?.number ?? '—'} · {s.roomType?.name ?? ''}</Serial> },
              { header: t('lod.nights'), num: true, cell: (s) => <Serial className="text-ink">{nightsBetween(s.arrivalDate, s.departureDate)}</Serial> },
              { header: t('common.status'), cell: (s) => <StayTag status={s.status} label={status(s.status)} /> },
            ]}
            stacked={{
              title: (s) => <Link href={`/lodging/stays/${s.id}`} className="underline">{formatDate(s.arrivalDate, lang)} → {formatDate(s.departureDate, lang)}</Link>,
              meta: (s) => <Serial>{t('lod.roomN', { n: s.room?.number ?? '—' })} · {branchLabel(branches, s.branchId)}</Serial>,
              figure: (s) => <StayTag status={s.status} label={status(s.status)} />,
            }}
          />
        ) : (
          <Empty>{t('lod.customerNoStays')}</Empty>
        )}
      </Note>
    </section>
  );
}
