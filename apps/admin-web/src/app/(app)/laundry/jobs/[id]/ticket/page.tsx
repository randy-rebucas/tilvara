import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BarcodeSvg } from '@/components/barcode-svg';
import { Note, Serial } from '@/components/note';
import { PrintButton } from '@/components/print-button';
import { apiOrNull, type JobTicket } from '@/lib/api';
import { formatDateTime, peso, qty, signOf } from '@/lib/format';
import { isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('laundry.jobs.item.ticket');

/**
 * The two copies printed at drop-off (ADR-0024 §4): the customer's claim stub (number, claim code and
 * its barcode, lines and total, down payment and balance, items and condition, the claim policy) and
 * the bag tag (number, name, bags, service level and instructions; no prices).
 */
export default async function JobTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const ticket = await apiOrNull<JobTicket>(`/job-orders/${id}/ticket`);
  if (!ticket) notFound();
  const { stub, tag } = ticket;
  const unit = (u: string | null) => (u ? t(`lau.unit.${u}` as MessageKey) : '');
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/laundry/jobs/${id}`} className="text-[0.875rem] text-muted underline">{t('lau.backToJob')}</Link>
        <PrintButton />
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] print:grid-cols-[3fr_2fr]">
        <Note as="article" className="px-5 py-5 pr-8" id="claim-stub">
          <header className="border-b border-hair pb-3">
            <p className="text-[1.0625rem] font-semibold">{stub.business}</p>
            <Serial className="block">{stub.legalName}</Serial>
            <Serial className="block">{stub.branch}{stub.branchAddress && ` · ${stub.branchAddress}`}</Serial>
            <h1 className="mt-3 text-[1.375rem] font-bold">{t('lau.claimStub')}</h1>
          </header>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="serial text-[1.5rem] font-bold" data-testid="stub-reference">{stub.reference}</p>
              <p className="text-[0.9375rem]">{t('lau.claimCode')}: <b className="serial tracking-[0.12em]" data-testid="stub-code">{stub.claimCode}</b></p>
            </div>
            <BarcodeSvg code={stub.claimCode} widthMm={42} heightMm={12} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-[0.9375rem]">
            <div><dt className="text-[0.8125rem] text-muted">{t('lau.customer')}</dt><dd className="font-semibold">{stub.customer ?? '—'}</dd></div>
            <div><dt className="text-[0.8125rem] text-muted">{t('lau.received')}</dt><dd>{formatDateTime(stub.receivedAt, lang)}</dd></div>
            <div><dt className="text-[0.8125rem] text-muted">{t('lau.promised')}</dt><dd className="font-semibold">{formatDateTime(stub.promisedAt, lang)}{stub.serviceLevel === 'EXPRESS' && ` · ${t('lau.express')}`}</dd></div>
            <div><dt className="text-[0.8125rem] text-muted">{t('lau.bags')}</dt><dd>{stub.bagCount}{stub.weightKg && ` · ${qty(stub.weightKg)} kg`}</dd></div>
          </dl>
          <table className="tbl mt-3">
            <thead><tr><th>{t('lau.service')}</th><th className="num">{t('lau.quantity')}</th><th className="num">{t('lau.amount')}</th></tr></thead>
            <tbody>
              {stub.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.name}{l.packageSession && ` · ${t('lau.packageSession')}`}</td>
                  <td className="num">{qty(l.quantity)} {unit(l.unit)}</td>
                  <td className="num money">{peso(l.amountDue)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td>{t('lau.total')}</td><td /><td className="num money">{peso(stub.amountDue)}</td></tr>
              <tr><td>{t('lau.downPayment')}</td><td /><td className="num money">{peso(stub.depositHeld)}</td></tr>
              <tr><td><b>{t('lau.balance')}</b></td><td /><td className="num money"><b>{peso(signOf(stub.balance) > 0 ? stub.balance : '0')}</b></td></tr>
            </tfoot>
          </table>
          {(stub.items.length > 0 || stub.conditionNotes || stub.specialInstructions) && (
            <div className="mt-3 grid gap-1 text-[0.875rem]">
              {stub.items.length > 0 && <p>{t('lau.piecesN', { n: stub.pieces })}: {stub.items.map((i) => `${i.count} × ${i.label}`).join(', ')}</p>}
              {stub.conditionNotes && <p>{t('lau.conditionNotes')}: {stub.conditionNotes}</p>}
              {stub.specialInstructions && <p>{t('lau.instructions')}: {stub.specialInstructions}</p>}
            </div>
          )}
          {stub.claimPolicy && <p className="mt-3 border-t border-hair-soft pt-2 text-[0.8125rem]" data-testid="claim-policy">{stub.claimPolicy}</p>}
          <p className="mt-2 text-[0.8125rem] font-semibold">{t('lau.stubNotice')}</p>
        </Note>

        <Note as="article" denom="blue" className="px-5 py-5 pr-8" id="bag-tag">
          <h2 className="text-[1.0625rem] font-bold">{t('lau.bagTag')}</h2>
          <p className="serial mt-2 text-[2rem] font-bold leading-none">{tag.reference}</p>
          <p className="mt-2 text-[1.125rem] font-semibold">{tag.customer ?? '—'}</p>
          <dl className="mt-3 grid gap-1 text-[0.9375rem]">
            <div className="flex justify-between gap-2"><dt className="text-muted">{t('lau.bags')}</dt><dd className="font-semibold">{tag.bagCount}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">{t('lau.serviceLevel')}</dt><dd className="font-semibold">{t(`lau.level.${tag.serviceLevel}` as MessageKey)}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">{t('lau.promised')}</dt><dd>{formatDateTime(tag.promisedAt, lang)}</dd></div>
            {tag.pieces > 0 && <div className="flex justify-between gap-2"><dt className="text-muted">{t('lau.pieces')}</dt><dd>{tag.pieces}</dd></div>}
          </dl>
          {tag.specialInstructions && <p className="mt-3 rounded-[4px] border border-hair px-3 py-2 text-[0.9375rem] font-semibold">{tag.specialInstructions}</p>}
        </Note>
      </div>
    </div>
  );
}
