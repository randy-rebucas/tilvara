import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Note, Serial } from '@/components/note';
import { PrintButton } from '@/components/print-button';
import { apiOrNull, type FolioStatement } from '@/lib/api';
import { formatDate, formatTin, peso, signed } from '@/lib/format';
import { isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('lodging.folios.item.statement');

/**
 * The folio statement the guest is shown and signs at check-out (ADR-0023 §5.2). While invoicing is
 * disabled it says plainly that it is not an invoice.
 */
export default async function FolioStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const st = await apiOrNull<FolioStatement>(`/folios/${id}/statement`);
  if (!st) notFound();
  const totals: [MessageKey, string][] = [
    ['lod.st.roomNights', st.totals.roomNights],
    ['lod.st.accommodationTax', st.totals.accommodationTax],
    ['lod.st.charges', st.totals.charges],
    ['lod.st.adjustments', st.totals.adjustments],
    ['lod.st.deposits', st.totals.deposits],
    ['lod.st.payments', st.totals.payments],
  ];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/lodging/stays/${st.stay.id}`} className="text-[0.875rem] text-muted underline">{t('lod.backToStay')}</Link>
        <PrintButton />
      </div>
      <Note className="mx-auto w-full max-w-[820px] px-6 py-6 pr-8" as="article">
        <header className="border-b border-hair pb-3">
          <p className="text-[1.0625rem] font-semibold">{st.seller.tradeName ?? st.seller.registeredName}</p>
          <Serial className="block">{st.seller.registeredName} · TIN {formatTin(st.seller.tin)}</Serial>
          <Serial className="block">{st.branch.name}{st.branch.address && ` · ${st.branch.address}`}</Serial>
          <h1 className="mt-3 text-[1.5rem] font-bold" data-testid="statement-title">{st.invoicingMode === 'DISABLED' ? t('lod.statementNotInvoice') : t('lod.statementTitle')}</h1>
          <Serial className="block">
            {st.stay.guestName ?? '—'} · {t('lod.roomN', { n: st.stay.roomNumber })} · {st.stay.roomType} · {formatDate(st.stay.arrivalDate, lang)} → {formatDate(st.stay.departureDate, lang)}
          </Serial>
        </header>
        <div className="mt-4 overflow-x-auto">
        <table className="tbl min-w-0!">
          <thead>
            <tr><th>{t('common.date')}</th><th>{t('lod.entry')}</th><th className="num">{t('lod.vat')}</th><th className="num">{t('lod.amount')}</th></tr>
          </thead>
          <tbody>
            {st.lines.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap"><Serial className="text-ink">{l.date.slice(5)}</Serial></td>
                <td>{l.description}</td>
                <td className="num"><span className="money">{l.vatAmount ? peso(l.vatAmount) : ''}</span></td>
                <td className="num"><span className="money">{signed(l.amount, peso)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <dl className="mt-4 ml-auto grid max-w-[360px] gap-1 text-[0.9375rem]">
          {totals.filter(([, v]) => !/^-?0(\.0+)?$/.test(v)).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3"><dt>{t(k)}</dt><dd className="money">{signed(v, peso)}</dd></div>
          ))}
          <div className="flex justify-between gap-3 border-t border-hair pt-1 font-semibold"><dt>{t('lod.folioBalance')}</dt><dd className="money" data-testid="statement-balance">{peso(st.totals.balance)}</dd></div>
        </dl>
        <div className="mt-10 grid gap-8 sm:grid-cols-2">
          <div className="border-t border-ink pt-1 text-[0.8125rem] text-muted">{t('lod.guestSignature')}</div>
          <div className="border-t border-ink pt-1 text-[0.8125rem] text-muted">{t('common.date')}</div>
        </div>
      </Note>
    </div>
  );
}
