import { Printer } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { allProducts, apiOrNull, type GarmentType, type JobDeposit, type JobNotice, type JobOrder, type LaundryMachine } from '@/lib/api';
import { formatDateTime, peso, qty, signed, signOf, sumDecimal } from '@/lib/format';
import { jobIsOpen } from '@/lib/laundry';
import { isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { JobTag, laundryAccess } from '../../chrome';
import type { LaundryOption } from '../../new/job-form';
import { AddTrip, CancelJob, CopyMessage, DisposeJob, EditItems, EditJob, EditLines, EditTrip, ReceiveDownPayment, RefundDownPayment, RunLoad, StatusButtons, TripActions } from './forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('laundry.jobs.item');

/**
 * One job order (ADR-0024 §3–§9): its frozen lines and total, items and condition, the status and its
 * history, machine loads, down payments, pickups and deliveries, the notices sent, the printable stub
 * and bag tag, and cancelling or disposing of it. The claim is a sale, rung up at the till.
 */
export default async function JobOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const job = await apiOrNull<JobOrder>(`/job-orders/${id}`);
  if (!job) notFound();
  const { canManage, canDispose } = await laundryAccess();
  const open = jobIsOpen(job.status);
  const manage = canManage && open;
  const [deposits, notices, machines, garments, products] = await Promise.all([
    apiOrNull<{ data: JobDeposit[]; held: string }>(`/job-orders/${id}/deposits`),
    apiOrNull<{ data: JobNotice[] }>(`/job-orders/${id}/notices`),
    manage ? apiOrNull<{ data: LaundryMachine[] }>(`/laundry/machines?branchId=${job.branchId}`) : null,
    manage ? apiOrNull<{ data: GarmentType[] }>('/laundry/garment-types') : null,
    manage ? allProducts() : null,
  ]);
  const services: LaundryOption[] = (products?.data ?? []).filter((p) => !p.archivedAt).flatMap((p) =>
    p.variants.filter((v) => !v.archivedAt && (v.laundryUnit || v.laundryAddon)).map((v) => ({
      variantId: v.id, label: `${p.name}${v.name ? ` — ${v.name}` : ''}`, unit: v.laundryUnit ?? null, min: v.laundryMinQuantity ?? null, kgPerLoad: v.laundryKgPerLoad ?? null, addon: v.laundryAddon ?? false,
    })),
  );
  const held = deposits?.held ?? job.depositHeld;
  // Once claimed (or ended) nothing is held any more: show what was paid down, not what is held.
  const paidDown = sumDecimal((deposits?.data ?? []).filter((d) => d.kind === 'RECEIVED').map((d) => d.amount));
  const status = t(`lau.status.${job.status}` as MessageKey);
  const warn = job.overdue || job.unclaimed;
  const liveTrips = job.trips.filter((x) => x.status === 'SCHEDULED');
  const tripKinds = (['PICKUP', 'DELIVERY'] as const).filter((k) => !liveTrips.some((x) => x.kind === k) && (k === 'PICKUP' ? job.status === 'RECEIVED' : true));
  const unit = (u: string | null) => (u ? t(`lau.unit.${u}` as MessageKey) : '');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/laundry?branch=${job.branchId}`} className="text-[0.875rem] text-muted underline">{t('lau.tab.board')}</Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-3 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">
          <span className="serial" data-testid="job-reference">{job.reference}</span> · {job.customerDisplayName ?? '—'}
          <JobTag status={job.status} label={job.overdue ? `${status} · ${t('lau.overdue')}` : job.unclaimed ? `${status} · ${t('lau.unclaimed')}` : status} warn={warn} />
        </h1>
        <Serial className="mt-1 block">
          {job.branchName} · {t('lau.receivedAt', { at: formatDateTime(job.createdAt, lang) })} · {t('lau.promised')} {formatDateTime(job.promisedAt, lang)}
          {job.serviceLevel === 'EXPRESS' && <> · <b>{t('lau.express')}</b></>}
          {job.customerPhone && <> · {job.customerPhone}</>}
          {job.customerId && <> · <Link href={`/customers/${job.customerId}`} className="underline">{t('lau.customerRecord')}</Link></>}
        </Serial>
      </div>

      {job.status === 'CLAIMED' && (
        <Callout>
          {t('lau.claimedAt', { at: formatDateTime(job.claimedAt, lang) })}
          {job.saleId && <> <Link href={`/sales/${job.saleId}`} className="font-semibold underline">{t('lau.openSale')}</Link></>}
        </Callout>
      )}
      {job.status === 'CANCELLED' && <Callout>{t('lau.cancelledBecause', { reason: job.cancelReason ?? '—' })}</Callout>}
      {job.status === 'DISPOSED' && <Callout>{t('lau.disposedBecause', { reason: job.disposedReason ? t(`lau.disposal.${job.disposedReason}` as MessageKey) : '—' })}{job.disposedNote && ` · ${job.disposedNote}`}</Callout>}
      {job.overdue && <Callout tone="warn">{t('lau.overdueNote')}</Callout>}
      {job.unclaimed && <Callout tone="warn">{t('lau.unclaimedNote')}</Callout>}

      <Note denom="blue" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 lg:grid-cols-5">
        <Figure label={t('lau.total')}>{peso(job.amountDue)}</Figure>
        <Figure label={t('lau.downPayment')}>{peso(open ? held : paidDown)}</Figure>
        <Figure label={t('lau.balance')}><span data-testid="job-balance">{open ? peso(signOf(job.balance) > 0 ? job.balance : '0') : '—'}</span></Figure>
        <Figure label={t('lau.weight')}>{job.weightKg ? `${qty(job.weightKg)} kg` : '—'}</Figure>
        <Figure label={t('lau.bags')}>{job.bagCount}{job.storageDays > 0 && <span className="block text-[0.8125rem] font-normal text-muted">{t('lau.storageDaysN', { n: job.storageDays })}</span>}</Figure>
      </Note>

      {open && (
        <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('lau.claimAtTill')} <span className="serial text-ink">{t('lau.claimCodeIs', { code: job.claimCode })}</span></p>
      )}

      <div className="flex flex-wrap items-start gap-2" data-testid="job-actions">
        <Link href={`/laundry/jobs/${job.id}/ticket`} className="btn"><Printer aria-hidden className="size-4" /> {t('lau.printTicket')}</Link>
        {job.status === 'READY' && <CopyMessage jobId={job.id} />}
        {manage && <EditJob job={job} />}
        {manage && job.status !== 'OUT_FOR_DELIVERY' && <CancelJob jobId={job.id} held={signOf(held) > 0} canForfeit={canDispose} />}
        {canDispose && job.unclaimed && job.status === 'READY' && <DisposeJob jobId={job.id} held={peso(held)} />}
      </div>

      {manage && job.status !== 'OUT_FOR_DELIVERY' && (
        <section aria-labelledby="progress" className="flex flex-col gap-2">
          <h2 id="progress" className="section-title">{t('lau.progress')}</h2>
          <StatusButtons jobId={job.id} status={job.status} />
        </section>
      )}

      <section aria-labelledby="lines" className="flex flex-col gap-3">
        <h2 id="lines" className="section-title">{t('lau.services')}</h2>
        <Note className="pr-2">
          {job.lines.length ? (
            <RecordTable
              rows={job.lines}
              rowKey={(l) => l.id}
              columns={[
                { header: t('lau.service'), cell: (l) => <span data-line-sku={l.sku}>{l.name}{l.customerPackageId && <span className="tag ml-2">{t('lau.packageSession')}</span>}{l.auto && <span className="tag ml-2">{t('lau.added')}</span>}</span> },
                {
                  header: t('lau.quantity'),
                  num: true,
                  cell: (l) => (
                    <Serial className="text-ink">
                      {qty(l.quantity)} {unit(l.laundryUnit)}
                      {l.measuredQuantity !== l.quantity && <span className="block text-[0.75rem] text-muted" data-testid="measured">{t('lau.measured', { q: qty(l.measuredQuantity) })}</span>}
                    </Serial>
                  ),
                },
                { header: t('lau.unitPrice'), num: true, cell: (l) => <span className="money">{peso(l.unitPrice)}</span> },
                { header: t('lau.amount'), num: true, cell: (l) => <span className="money">{peso(l.amountDue)}</span> },
              ]}
              stacked={{
                title: (l) => l.name,
                meta: (l) => <Serial>{qty(l.quantity)} {unit(l.laundryUnit)} × {peso(l.unitPrice)}</Serial>,
                figure: (l) => <span className="money font-semibold">{peso(l.amountDue)}</span>,
              }}
              foot={{ cells: [t('lau.total'), '', '', <span key="t" className="money" data-testid="job-total">{peso(job.amountDue)}</span>], title: t('lau.total'), figure: <span className="money">{peso(job.amountDue)}</span> }}
            />
          ) : (
            <Empty>{t('lau.notPricedYet')}</Empty>
          )}
        </Note>
        {manage && job.status !== 'OUT_FOR_DELIVERY' && <div><EditLines job={job} services={services} /></div>}
      </section>

      <section aria-labelledby="items" className="flex flex-col gap-3">
        <h2 id="items" className="section-title">{t('lau.itemsAndCondition')}</h2>
        <Note className="px-5 py-4 pr-8">
          {job.items.length ? (
            <ul className="flex flex-wrap gap-2" data-testid="job-items">
              {job.items.map((i) => <li key={i.id} className="tag">{i.count} × {i.label}{i.note && ` · ${i.note}`}</li>)}
            </ul>
          ) : (
            <p className="text-[0.875rem] text-muted">{t('lau.noItems')}</p>
          )}
          <dl className="mt-3 grid gap-2 text-[0.9375rem] sm:grid-cols-2">
            <div><dt className="text-[0.8125rem] text-muted">{t('lau.conditionNotes')}</dt><dd data-testid="condition">{job.conditionNotes ?? '—'}</dd></div>
            <div><dt className="text-[0.8125rem] text-muted">{t('lau.instructions')}</dt><dd>{job.specialInstructions ?? '—'}</dd></div>
          </dl>
        </Note>
        {manage && garments && <div><EditItems job={job} garmentTypes={garments.data.filter((g) => !g.archivedAt)} /></div>}
      </section>

      {manage && ['RECEIVED', 'WASHING', 'DRYING'].includes(job.status) && machines && (
        <section aria-labelledby="loads" className="flex flex-col gap-2">
          <h2 id="loads" className="section-title">{t('lau.machineLoads')}</h2>
          <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('lau.machineLoadsLede')} <Link href={`/laundry/machines?branch=${job.branchId}`} className="underline">{t('lau.tab.machines')}</Link></p>
          <div><RunLoad jobId={job.id} machines={machines.data} /></div>
        </section>
      )}

      <section aria-labelledby="deposits" className="flex flex-col gap-3">
        <h2 id="deposits" className="section-title">{t('lau.downPayments')}</h2>
        <Note className="pr-2">
          {deposits?.data.length ? (
            <RecordTable
              rows={deposits.data}
              rowKey={(d) => d.id}
              columns={[
                { header: t('cust.when'), cell: (d) => <Serial className="text-ink">{formatDateTime(d.createdAt, lang)}</Serial> },
                { header: t('lau.depositKind'), cell: (d) => <span className="tag">{t(`lau.dep.${d.kind}` as MessageKey)}</span> },
                { header: t('lau.methodCol'), cell: (d) => <span className="text-[0.875rem]">{[d.method && t(`lau.method.${d.method}` as MessageKey), d.reference].filter(Boolean).join(' · ') || d.reason || '—'}</span> },
                { header: t('lau.amount'), num: true, cell: (d) => <span className="money">{signed(d.amount, peso)}</span> },
              ]}
              stacked={{
                title: (d) => t(`lau.dep.${d.kind}` as MessageKey),
                meta: (d) => <Serial>{formatDateTime(d.createdAt, lang)}{d.reference && ` · ${d.reference}`}</Serial>,
                figure: (d) => <span className="money font-semibold">{signed(d.amount, peso)}</span>,
              }}
              foot={{ cells: [t('lau.held'), '', '', <span key="h" className="money">{peso(held)}</span>], title: t('lau.held'), figure: <span className="money">{peso(held)}</span> }}
            />
          ) : (
            <Empty>{t('lau.noDeposits')}</Empty>
          )}
        </Note>
        {manage && (
          <div className="flex flex-wrap items-start gap-2">
            {signOf(job.balance) > 0 && <ReceiveDownPayment jobId={job.id} />}
            {signOf(held) > 0 && <RefundDownPayment jobId={job.id} />}
          </div>
        )}
        <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('lau.depositsHint')}</p>
      </section>

      <section aria-labelledby="trips" className="flex flex-col gap-3">
        <h2 id="trips" className="section-title">{t('lau.trips')}</h2>
        <Note className="pr-2">
          {job.trips.length ? (
            <ul data-testid="job-trips">
              {job.trips.map((x) => (
                <li key={x.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-hair-soft px-4 py-3 last:border-b-0">
                  <div className="min-w-0">
                    <p className="font-semibold">{t(`lau.trip.${x.kind}` as MessageKey)} <span className="tag ml-1" data-trip-status={x.status}>{t(`lau.tripStatus.${x.status}` as MessageKey)}</span></p>
                    <Serial>{[x.address, x.contactPhone, x.windowStart && formatDateTime(x.windowStart, lang), x.riderName].filter(Boolean).join(' · ')}</Serial>
                    {x.notes && <p className="text-[0.8125rem] text-muted">{x.notes}</p>}
                    {x.failReason && <p className="text-[0.8125rem] text-muted">{x.failReason}</p>}
                  </div>
                  {(canManage || canDispose) && <TripActions trip={{ id: x.id, kind: x.kind, status: x.status, jobStatus: job.status }} />}
                  {canManage && <EditTrip trip={x} />}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('lau.noTrips')}</Empty>
          )}
        </Note>
        {manage && <div><AddTrip jobId={job.id} kinds={tripKinds} /></div>}
        <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('lau.tripsHint')}</p>
      </section>

      <section aria-labelledby="notices" className="flex flex-col gap-3">
        <h2 id="notices" className="section-title">{t('lau.notices')}</h2>
        <Note className="pr-2">
          {notices?.data.length ? (
            <RecordTable
              rows={notices.data}
              rowKey={(n) => n.id}
              columns={[
                { header: t('cust.when'), cell: (n) => <Serial className="text-ink">{formatDateTime(n.settledAt ?? n.createdAt, lang)}</Serial> },
                { header: t('lau.noticeKind'), cell: (n) => <span className="tag">{t(`lau.notice.${n.kind}` as MessageKey)}</span> },
                { header: t('lau.email'), cell: (n) => <span className="text-[0.875rem]">{n.emailStatus ? `${t(`lau.sendStatus.${n.emailStatus}` as MessageKey)}${n.emailTo ? ` · ${n.emailTo}` : ''}` : '—'}</span> },
                { header: t('lau.sms'), cell: (n) => <span className="text-[0.875rem]">{n.smsStatus ? `${t(`lau.sendStatus.${n.smsStatus}` as MessageKey)}${n.smsTo ? ` · ${n.smsTo}` : ''}` : '—'}</span> },
              ]}
              stacked={{
                title: (n) => t(`lau.notice.${n.kind}` as MessageKey),
                meta: (n) => <Serial>{formatDateTime(n.settledAt ?? n.createdAt, lang)} · {n.emailStatus ?? '—'} / {n.smsStatus ?? '—'}</Serial>,
                figure: () => null,
              }}
            />
          ) : (
            <Empty>{job.notify ? t('lau.noNotices') : t('lau.noticesOff')}</Empty>
          )}
        </Note>
      </section>

      <section aria-labelledby="history" className="flex flex-col gap-3">
        <h2 id="history" className="section-title">{t('lau.history')}</h2>
        <Note className="px-5 py-4 pr-8">
          <ol className="grid gap-1 text-[0.9375rem]" data-testid="job-history">
            {job.history.map((h) => (
              <li key={h.id} className="flex flex-wrap justify-between gap-2">
                <span>{t(`lau.status.${h.toStatus}` as MessageKey)}{h.note && <span className="text-muted"> · {h.note}</span>}</span>
                <Serial>{formatDateTime(h.changedAt, lang)}</Serial>
              </li>
            ))}
          </ol>
        </Note>
      </section>
    </div>
  );
}
