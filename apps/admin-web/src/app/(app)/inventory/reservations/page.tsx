import Link from 'next/link';
import { ReasonAction } from '@/components/actions';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { allProducts, api, apiOrNull, type Me, type Reservation } from '@/lib/api';
import { formatDateTime, qty } from '@/lib/format';
import { variantOptions } from '@/lib/options';
import { getT } from '@/i18n/server';
import { InventoryChrome, inventoryBranch } from '../chrome';
import { ReserveForm } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('inventory.reservations');

/** Stock set aside at the branch (session 20): available = on hand − reserved; released once collected, sold or cancelled. */
export default async function ReservationsPage({ searchParams }: { searchParams: Promise<{ branch?: string; all?: string }> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const { branches, branch } = await inventoryBranch(sp.branch);
  const all = sp.all === '1';
  const [me, list, products] = await Promise.all([
    api<Me>('/me'),
    branch ? apiOrNull<{ data: Reservation[] }>(`/stock/reservations?branchId=${branch.id}&status=${all ? 'ALL' : 'ACTIVE'}`) : null,
    allProducts(),
  ]);
  const perms = me.activeTenant?.permissions ?? [];
  const canReserve = perms.includes('sales.create') || perms.includes('inventory.adjust');
  const rows = list?.data ?? [];
  // On the table its own column; on a phone under the row (the stacked list has no action column).
  const release = (r: Reservation) =>
    canReserve && r.status === 'ACTIVE' ? <ReasonAction url={`/api/v1/stock/reservations/${r.id}/release`} label={t('inv.release')} reasonLabel={t('common.reason')} hint={t('inv.releaseHint')} /> : null;

  return (
    <InventoryChrome tab="reservations" branches={branches} branch={branch}>
      <section className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-[640px] text-[0.9375rem] text-muted">{t('inv.reservationsLede')}</p>
          {canReserve && branch && <ReserveForm branchId={branch.id} timeZone={branch.timezone} variants={variantOptions(products?.data, { stocked: true })} />}
        </div>
        {branch && (
          <Link href={`/inventory/reservations?branch=${branch.id}${all ? '' : '&all=1'}`} className="text-[0.875rem] text-blue underline">
            {all ? t('inv.showActive') : t('inv.showReleased')}
          </Link>
        )}
        <Note denom="gold" className="pr-2">
          {rows.length > 0 ? (
            <RecordTable
              rows={rows}
              rowKey={(r) => r.id}
              dimmed={(r) => r.status === 'RELEASED' || r.expired}
              columns={[
                { header: t('prod.sku'), cell: (r) => <Serial className="text-ink">{r.sku}</Serial> },
                { header: t('common.item'), cell: (r) => r.name },
                { header: t('common.quantity'), num: true, cell: (r) => <b>{qty(r.quantity)}</b> },
                { header: t('inv.reserveFor'), cell: (r) => <span>{r.note}{r.customerId && <> · <Link href={`/customers/${r.customerId}`} className="underline">{t('doc.customer')}</Link></>}</span> },
                {
                  header: t('common.status'),
                  cell: (r) => (r.status === 'RELEASED'
                    ? <span className="text-muted">{t('inv.released', { date: formatDateTime(r.releasedAt, lang) })} · {r.releaseReason}</span>
                    : r.expired
                      ? <span className="tag">{t('inv.expired')}</span>
                      : <span>{r.expiresAt ? t('inv.until', { date: formatDateTime(r.expiresAt, lang) }) : t('inv.untilReleased')}</span>),
                },
                ...(canReserve
                  ? [{ header: '', cell: release }]
                  : []),
              ]}
              stacked={{
                title: (r) => `${r.name} × ${qty(r.quantity)}`,
                meta: (r) => <><Serial>{r.sku} · {r.note}{r.createdByName ? ` · ${r.createdByName}` : ''}</Serial>{release(r) && <div className="mt-2">{release(r)}</div>}</>,
                figure: (r) => (r.status === 'RELEASED' ? <span className="text-muted">{t('inv.releasedShort')}</span> : null),
              }}
            />
          ) : (
            <Empty>{branch && !list ? t('common.noAccess') : all ? t('inv.noReservationsAll') : t('inv.noReservations')}</Empty>
          )}
        </Note>
      </section>
    </InventoryChrome>
  );
}
