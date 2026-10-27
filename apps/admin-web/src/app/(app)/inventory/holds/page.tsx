import Link from 'next/link';
import { ReasonAction } from '@/components/actions';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { allProducts, api, apiOrNull, type LotHold, type Me } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { getT } from '@/i18n/server';
import { InventoryChrome, inventoryBranch } from '../chrome';
import { PlaceHold } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('inventory.holds');

/**
 * Holds on lots (ADR-0025 §5, kept for every shop): a recall or a supplier advisory stops a lot from being sold at one
 * branch or at all of them, until it is released with a reason. Holds are never deleted. A held lot
 * shows "On hold" on the expiry list and can still be written off or returned to the supplier.
 */
export default async function LotHoldsPage({ searchParams }: { searchParams: Promise<{ released?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const [{ branches }, me] = await Promise.all([inventoryBranch(undefined), api<Me>('/me')]);
  const permissions = me.activeTenant?.permissions ?? [];
  const canStock = permissions.includes('inventory.read');
  /** Place and release holds on a lot. */
  const canHold = permissions.includes('inventory.adjust');
  const withReleased = sp.released === '1';
  const [holds, products] = canStock
    ? await Promise.all([
        apiOrNull<{ data: LotHold[]; canHoldEverywhere?: boolean }>(`/stock/lot-holds${withReleased ? '?includeReleased=true' : ''}`),
        canHold ? allProducts() : null,
      ])
    : [null, null];
  // Who placed it, by the name the API gives (any reader of the holds sees it).
  const person = (h: LotHold) => h.placedByName ?? null;
  const options = (products?.data ?? [])
    .filter((p) => !p.archivedAt && p.tracksExpiry)
    .flatMap((p) => p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, label: `${v.sku} · ${p.name}${v.name ? ` — ${v.name}` : ''}` })));
  const where = (h: LotHold) => h.branchName ?? t('rep.allBranches');
  const state = (h: LotHold) =>
    h.releasedAt ? <span className="tag" title={h.releaseReason ?? undefined}>{t('lot.released')}</span> : <span className="tag border-[#ead3a6]! bg-amber-bg! text-[#6b4a12]!" data-hold-open>{t('exp.onHold')}</span>;
  const trace = (h: LotHold) => <Link href={`/inventory/batches?${new URLSearchParams({ variant: h.variantId, lot: h.lotCode })}`} className="serial underline" data-hold-lot={h.lotCode}>{h.lotCode}</Link>;
  const release = (h: LotHold) =>
    canHold && !h.releasedAt ? <ReasonAction url={`/api/v1/stock/lot-holds/${h.id}/release`} label={t('lot.release')} reasonLabel={t('common.reason')} hint={t('lot.releaseHint')} /> : null;

  return (
    <InventoryChrome tab="holds" branches={branches} branch={undefined}>
      {!holds ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('lot.holdsLede')}</p>
          {canHold && <div><PlaceHold variants={options} branches={branches} everywhere={holds?.canHoldEverywhere ?? true} /></div>}
          <nav aria-label={t('lot.holdsShow')} className="flex flex-wrap gap-1.5 text-[0.875rem]">
            <Link href="/inventory/holds" aria-current={!withReleased ? 'page' : undefined} className={`tag ${!withReleased ? 'font-semibold text-ink' : 'underline'}`}>{t('lot.holdsOpen')}</Link>
            <Link href="/inventory/holds?released=1" aria-current={withReleased ? 'page' : undefined} className={`tag ${withReleased ? 'font-semibold text-ink' : 'underline'}`}>{t('lot.holdsAll')}</Link>
          </nav>
          <Note denom="gold" className="pr-2">
            {holds.data.length ? (
              <RecordTable
                rows={holds.data}
                rowKey={(h) => h.id}
                dimmed={(h) => !!h.releasedAt}
                columns={[
                  { header: t('common.item'), cell: (h) => <><b>{h.name}</b> <Serial>{h.sku}</Serial></> },
                  { header: t('exp.lot'), cell: trace },
                  { header: t('lot.holdWhere'), cell: where },
                  { header: t('common.reason'), cell: (h) => <>{h.reason}{h.reference && <Serial className="block">{h.reference}</Serial>}</> },
                  { header: t('lot.placed'), cell: (h) => <Serial className="text-ink">{formatDateTime(h.placedAt, lang)}{person(h) && ` · ${person(h)}`}</Serial> },
                  { header: t('common.status'), cell: (h) => <>{state(h)}{h.releasedAt && <Serial className="block">{formatDateTime(h.releasedAt, lang)} · {h.releaseReason}</Serial>}</> },
                  { header: '', cell: release },
                ]}
                stacked={{
                  title: (h) => <>{h.name} · {trace(h)}</>,
                  meta: (h) => <><Serial>{where(h)} · {h.reason} · {formatDateTime(h.placedAt, lang)}</Serial>{release(h) && <div className="mt-2">{release(h)}</div>}</>,
                  figure: state,
                }}
              />
            ) : (
              <Empty>{t('lot.noHolds')}</Empty>
            )}
          </Note>
        </>
      )}
    </InventoryChrome>
  );
}
