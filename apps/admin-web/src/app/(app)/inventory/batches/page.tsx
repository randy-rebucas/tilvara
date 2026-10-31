import { Search } from 'lucide-react';
import Link from 'next/link';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { allProducts, ApiError, api, type LotTrace, type Me } from '@/lib/api';
import { formatDate, formatDateTime, qty, signed } from '@/lib/format';
import { isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { InventoryChrome, inventoryBranch } from '../chrome';
import { PlaceHold } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('inventory.batches');

type Move = LotTrace['movements'][number];

/**
 * Batch trace (ADR-0025 §5): pick an item and a lot code to see, per branch, where the batch came
 * from, where it went (sales with their receipt and customer, returns, write-offs, transfers, packs
 * opened into pieces) and what is left. For a recall: place a hold from here.
 */
export default async function BatchTracePage({ searchParams }: { searchParams: Promise<{ variant?: string; lot?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const [{ branches }, me] = await Promise.all([inventoryBranch(undefined), api<Me>('/me')]);
  const permissions = me.activeTenant?.permissions ?? [];
  const canStock = permissions.includes('inventory.read');
  /** Place and release holds on a lot. */
  const canHold = permissions.includes('inventory.adjust');
  const products = canStock ? await allProducts() : null;
  const options = (products?.data ?? [])
    .filter((p) => !p.archivedAt && p.tracksExpiry)
    .flatMap((p) => p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, label: `${v.sku} · ${p.name}${v.name ? ` — ${v.name}` : ''}` })));
  const variantId = sp.variant && isUuid(sp.variant) ? sp.variant : '';
  const lot = sp.lot?.trim().slice(0, 64) ?? '';
  let trace: LotTrace | null = null;
  let error: string | null = null;
  if (variantId && lot) {
    try {
      trace = await api<LotTrace>(`/stock/lots/trace?${new URLSearchParams({ variantId, lotCode: lot })}`);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      error = e.message;
    }
  }
  const source = (m: Move) => {
    if (m.sale) {
      return (
        <>
          <Link href={`/sales/${m.sale.id}`} className="serial underline" data-trace-sale>{m.sale.reference}</Link>
          {m.customer && <> · <Link href={`/customers/${m.customer.id}`} className="underline">{m.customer.name ?? t('doc.customer')}</Link></>}
        </>
      );
    }
    if (m.goodsReceiptId) return <><Link href={`/purchasing/receipts/${m.goodsReceiptId}`} className="underline">{t('src.GOODS_RECEIPT')}</Link>{m.supplier && ` · ${m.supplier}`}</>;
    if (m.stockAdjustmentId) return <><Link href={`/inventory/adjustments/${m.stockAdjustmentId}`} className="underline">{t('lot.adjustmentDoc')}</Link>{m.reason && ` · ${m.reason}`}</>;
    if (m.stockTransferId) return <Link href={`/inventory/transfers/${m.stockTransferId}`} className="underline">{t('lot.transferDoc')}</Link>;
    if (m.packOpeningId) return <Link href={`/inventory/packs?branch=${m.branchId}`} className="underline">{t('lot.packOpeningDoc')}</Link>;
    return m.reason ?? '—';
  };

  return (
    <InventoryChrome tab="batches" branches={branches} branch={undefined}>
      {!canStock ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('lot.traceLede')}</p>
          <form method="get" action="/inventory/batches" className="flex flex-wrap items-end gap-2" role="search">
            <div className="field min-w-0 flex-1 sm:max-w-[28rem]">
              <label htmlFor="trace-variant">{t('common.item')}</label>
              <select id="trace-variant" name="variant" className="input" defaultValue={variantId}>
                <option value="" disabled>—</option>
                {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="trace-lot">{t('exp.lot')}</label>
              <input id="trace-lot" name="lot" className="input" defaultValue={lot} maxLength={64} required />
            </div>
            <button className="btn btn-primary"><Search aria-hidden className="size-4" /> {t('lot.trace')}</button>
          </form>
          {options.length === 0 && <p className="text-[0.875rem] text-muted">{t('lot.traceNoItems')}</p>}

          {error && <Callout tone="error">{error}</Callout>}
          {trace && (
            <>
              {canHold && (
                <div><PlaceHold variants={options} branches={branches} initial={{ variantId: trace.variantId, lotCode: trace.lotCode }} everywhere={trace.canHoldEverywhere ?? true} /></div>
              )}
              <section aria-labelledby="trace-left" className="flex flex-col gap-3">
                <h2 id="trace-left" className="section-title">{t('lot.traceLeft', { lot: trace.lotCode })}</h2>
                <Note denom="gold" className="pr-2">
                  {trace.onHand.length ? (
                    <RecordTable
                      rows={trace.onHand}
                      rowKey={(h) => `${h.branchId}:${h.variantId}:${h.expiresOn}`}
                      columns={[
                        { header: t('common.branch'), cell: (h) => h.branch },
                        { header: t('common.item'), cell: (h) => <>{h.name} <Serial>{h.sku}</Serial></> },
                        { header: t('exp.expiresOn'), cell: (h) => formatDate(h.expiresOn, lang) },
                        { header: t('common.quantity'), num: true, cell: (h) => <b data-trace-onhand>{qty(h.quantity)}</b> },
                      ]}
                      stacked={{ title: (h) => h.name, meta: (h) => <Serial>{h.branch} · {h.sku} · {formatDate(h.expiresOn, lang)}</Serial>, figure: (h) => <b>{qty(h.quantity)}</b> }}
                    />
                  ) : (
                    <Empty>{t('lot.traceNoneLeft')}</Empty>
                  )}
                </Note>
              </section>
              <section aria-labelledby="trace-moves" className="flex flex-col gap-3">
                <h2 id="trace-moves" className="section-title">{t('lot.traceMoves')}</h2>
                <Note denom="gold" className="pr-2">
                  {trace.movements.length ? (
                    <RecordTable
                      rows={trace.movements}
                      rowKey={(m) => `${m.at}:${m.variantId}:${m.type}:${m.quantity}:${m.sale?.id ?? ''}`}
                      columns={[
                        { header: t('common.date'), cell: (m) => <Serial className="text-ink">{formatDateTime(m.at, lang)}</Serial> },
                        { header: t('common.branch'), cell: (m) => m.branch },
                        { header: t('common.item'), cell: (m) => <>{m.name} <Serial>{m.sku}</Serial></> },
                        { header: t('lot.moveType'), cell: (m) => <span data-trace-type={m.type}>{t(`mv.${m.type}` as MessageKey)}</span> },
                        { header: t('common.quantity'), num: true, cell: (m) => <b>{signed(m.quantity)}</b> },
                        { header: t('lot.moveSource'), cell: source },
                      ]}
                      stacked={{
                        title: (m) => `${t(`mv.${m.type}` as MessageKey)} · ${m.name}`,
                        meta: (m) => <><Serial>{formatDateTime(m.at, lang)} · {m.branch}</Serial><span className="block text-[0.8125rem]">{source(m)}</span></>,
                        figure: (m) => <b>{signed(m.quantity)}</b>,
                      }}
                    />
                  ) : (
                    <Empty>{t('lot.traceNoMoves')}</Empty>
                  )}
                  {trace.truncated && <p className="text-[0.875rem] text-muted">{t('lot.traceTruncated')}</p>}
                </Note>
              </section>
            </>
          )}
        </>
      )}
    </InventoryChrome>
  );
}
