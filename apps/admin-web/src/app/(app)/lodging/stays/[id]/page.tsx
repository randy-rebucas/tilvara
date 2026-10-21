import { Printer } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReasonAction } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { apiOrNull, type Branch, type Folio, type LodgingSettings, type Room, type Stay, type StayDeposit, type StayGuest } from '@/lib/api';
import { formatDate, formatDateTime, peso, signed, signOf } from '@/lib/format';
import { isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { branchToday, lodgingAccess, nightsBetween, StayTag } from '../../chrome';
import { RemoveButton } from '../../forms';
import { BeneficiaryForm, CheckIn, CheckOut, EditStay, EndStay, FolioAdjustment, GuestForm, ReceiveDeposit, RefundDeposit } from './forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('lodging.stays.item');

/**
 * One stay (ADR-0023 §3–§8): the booking and its changes, check-in with the guest registry and the
 * printable registration card, SC/PWD guests, deposits, the folio with its entries, adjustments and
 * night reversals and the printable statement, and check-out once the folio is at zero.
 */
export default async function StayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [stay, branches] = await Promise.all([apiOrNull<Stay>(`/stays/${id}`), apiOrNull<{ data: Branch[] }>('/branches')]);
  if (!stay) notFound();
  const { canManage, canRates } = await lodgingAccess();
  const branch = branches?.data.find((b) => b.id === stay.branchId);
  const today = branchToday(branch);
  const active = stay.status === 'BOOKED' || stay.status === 'IN_HOUSE';
  const [folio, deposits, guests, rooms, settings] = await Promise.all([
    stay.folio ? apiOrNull<Folio>(`/folios/${stay.folio.id}`) : null,
    apiOrNull<{ data: StayDeposit[]; held: string }>(`/stays/${id}/deposits`),
    canManage ? apiOrNull<{ data: StayGuest[] }>(`/stays/${id}/guests`) : null,
    apiOrNull<{ data: Room[] }>(`/rooms?branchId=${stay.branchId}`),
    apiOrNull<LodgingSettings>(`/branches/${stay.branchId}/lodging-settings`),
  ]);
  const room = rooms?.data.find((r) => r.id === stay.roomId);
  const nights = nightsBetween(stay.arrivalDate, stay.departureDate);
  const held = deposits?.held ?? stay.depositsHeld;
  const manage = canManage && active;
  const status = t(`lod.status.${stay.status}` as MessageKey);
  const reversed = new Set((folio?.entries ?? []).filter((e) => e.kind === 'NIGHT_REVERSAL' && e.relatedEntryId).map((e) => e.relatedEntryId!));
  const beneficiaries = stay.beneficiaries.filter((b) => !b.removedAt);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/lodging?branch=${stay.branchId}`} className="text-[0.875rem] text-muted underline">{t('lod.tab.desk')}</Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-3 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">
          {stay.guestDisplayName ?? '—'} <StayTag status={stay.status} label={status} />
        </h1>
        <Serial className="mt-1 block">
          {t('lod.roomN', { n: stay.room?.number ?? '—' })} · {stay.roomType?.name ?? ''} · {formatDate(stay.arrivalDate, lang)} → {formatDate(stay.departureDate, lang)} · {t('lod.nightsN', { n: nights })}
          {' · '}{t(`lod.source.${stay.source}` as MessageKey)}{stay.externalReference && <> · {stay.externalReference}</>}
          {stay.customer && <> · <Link href={`/customers/${stay.customer.id}`} className="underline">{t('lod.customerRecord')}</Link></>}
        </Serial>
      </div>

      {(stay.status === 'CANCELLED' || stay.status === 'NO_SHOW') && <Callout>{t(stay.status === 'CANCELLED' ? 'lod.cancelledBecause' : 'lod.noShowBecause', { reason: stay.cancelReason ?? '—' })}</Callout>}
      {stay.status === 'CHECKED_OUT' && <Callout>{t('lod.checkedOutAt', { at: formatDateTime(stay.checkedOutAt, lang) })}</Callout>}
      {stay.status === 'BOOKED' && stay.arrivalDate < today && <Callout tone="warn">{t('lod.lateArrival')}</Callout>}
      {stay.overstay && <Callout tone="warn"><span className="font-semibold">{t('lod.overstay')}.</span> {t('lod.overstayHint', { date: formatDate(stay.departureDate, lang) })}</Callout>}

      <Note denom="violet" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 lg:grid-cols-5">
        <Figure label={t('lod.nightlyRate')}>{stay.nightlyRate ? peso(stay.nightlyRate) : <span className="text-[1rem]">{t('lod.rackRate')}</span>}</Figure>
        <Figure label={t('lod.guests')}>{t('lod.guestsOf', { adults: stay.adults, children: stay.children })}</Figure>
        <Figure label={t('lod.folioBalance')}>{folio ? peso(folio.balance) : '—'}</Figure>
        <Figure label={t('lod.depositsHeld')}>{peso(held)}</Figure>
        <Figure label={t('lod.chargedToRoom')}>
          {stay.allowCharges ? <>{peso(stay.folio?.charged ?? '0')}{stay.chargeLimit && <span className="block text-[0.8125rem] font-normal text-muted">{t('lod.limitOf', { amount: peso(stay.chargeLimit) })}</span>}</> : <span className="text-[1rem]">{t('lod.noCharges')}</span>}
        </Figure>
      </Note>
      {stay.notes && <p className="max-w-[68ch] text-[0.9375rem]"><span className="text-muted">{t('common.notes')}:</span> {stay.notes}</p>}

      {manage && (
        <div className="flex flex-wrap items-start gap-2" data-testid="stay-actions">
          {stay.status === 'BOOKED' && <CheckIn stayId={stay.id} roomStatus={room?.housekeepingStatus} hasPrimary={(guests?.data ?? []).some((g) => g.isPrimary)} depositsHeld={held} />}
          <EditStay stay={stay} rooms={(rooms?.data ?? []).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))} canRates={canRates} />
          {stay.status === 'BOOKED' && <EndStay stayId={stay.id} kind="cancel" depositsHeld={held} forfeitDefault={settings?.forfeitOnCancel ?? true} canRates={canRates} />}
          {stay.status === 'BOOKED' && stay.arrivalDate < today && <EndStay stayId={stay.id} kind="no-show" depositsHeld={held} forfeitDefault={settings?.forfeitOnCancel ?? true} canRates={canRates} />}
          {stay.status === 'IN_HOUSE' && folio && <CheckOut stayId={stay.id} balance={folio.balance} />}
        </div>
      )}

      {guests && (
        <section aria-labelledby="registry" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="registry" className="section-title">{t('lod.registry')}</h2>
            <Link href={`/lodging/stays/${stay.id}/card`} className="btn"><Printer aria-hidden className="size-4" /> {t('lod.registrationCard')}</Link>
          </div>
          <Note className="pr-2">
            {guests.data.length ? (
              <ul data-testid="registry">
                {guests.data.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-hair-soft px-4 py-3 last:border-b-0">
                    <div className="min-w-0">
                      <p className="font-semibold">{g.fullName} {g.isPrimary && <span className="tag ml-1">{t('lod.g.primary')}</span>}</p>
                      <Serial>{[g.nationality, g.idType && `${g.idType} ${g.idNumber ?? ''}`.trim(), g.contact].filter(Boolean).join(' · ') || t('lod.g.noDetails')}</Serial>
                    </div>
                    {active && (
                      <div className="flex flex-wrap items-start gap-2">
                        <GuestForm stayId={stay.id} guest={g} />
                        {!(g.isPrimary && stay.status === 'IN_HOUSE') && <RemoveButton url={`/api/v1/stays/${stay.id}/guests/${g.id}`} label={t('lod.removeGuest')} confirmText={t('lod.removeGuestConfirm')} />}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{t('lod.noGuestsYet')}</Empty>
            )}
          </Note>
          {active && <div><GuestForm stayId={stay.id} first={guests.data.length === 0} /></div>}
        </section>
      )}

      <section aria-labelledby="beneficiaries" className="flex flex-col gap-3">
        <h2 id="beneficiaries" className="section-title">{t('lod.beneficiaries')}</h2>
        <Note className="pr-2">
          {beneficiaries.length ? (
            <ul>
              {beneficiaries.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-hair-soft px-4 py-3 last:border-b-0">
                  <div>
                    <p className="font-semibold">{b.name}</p>
                    <Serial>{t(`lod.scheme.${b.schemeCode}` as MessageKey)} · {b.idNumber}{b.share && ` · ${t('lod.share', { share: b.share })}`}</Serial>
                  </div>
                  {manage && <RemoveButton url={`/api/v1/stays/${stay.id}/beneficiaries/${b.id}`} label={t('lod.removeGuest')} />}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('lod.noBeneficiaries')}</Empty>
          )}
        </Note>
        {manage && <div><BeneficiaryForm stayId={stay.id} /></div>}
      </section>

      <section aria-labelledby="deposits" className="flex flex-col gap-3">
        <h2 id="deposits" className="section-title">{t('lod.deposits')}</h2>
        <Note className="pr-2">
          {deposits?.data.length ? (
            <RecordTable
              rows={deposits.data}
              rowKey={(d) => d.id}
              columns={[
                { header: t('cust.when'), cell: (d) => <Serial className="text-ink">{formatDateTime(d.createdAt, lang)}</Serial> },
                { header: t('lod.depositKind'), cell: (d) => <span className="tag">{t(`lod.dep.${d.kind}` as MessageKey)}</span> },
                { header: t('lod.method'), cell: (d) => <span className="text-[0.875rem]">{[d.method && t(`lod.method.${d.method}` as MessageKey), d.reference].filter(Boolean).join(' · ') || d.reason || '—'}</span> },
                { header: t('lod.amount'), num: true, cell: (d) => <span className="money">{signed(d.amount, peso)}</span> },
              ]}
              stacked={{
                title: (d) => t(`lod.dep.${d.kind}` as MessageKey),
                meta: (d) => <Serial>{formatDateTime(d.createdAt, lang)}{d.reference && ` · ${d.reference}`}</Serial>,
                figure: (d) => <span className="money font-semibold">{signed(d.amount, peso)}</span>,
              }}
              foot={{ cells: [t('lod.depositsHeld'), '', '', <span key="h" className="money">{peso(held)}</span>], title: t('lod.depositsHeld'), figure: <span className="money">{peso(held)}</span> }}
            />
          ) : (
            <Empty>{t('lod.noDeposits')}</Empty>
          )}
        </Note>
        {manage && canRates && (
          <div className="flex flex-wrap items-start gap-2">
            <ReceiveDeposit stayId={stay.id} />
            {signOf(held) > 0 && <RefundDeposit stayId={stay.id} held={held} />}
          </div>
        )}
        {manage && <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('lod.depositsAtTill')}</p>}
      </section>

      <section aria-labelledby="folio" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="folio" className="section-title">{t('lod.folio')}</h2>
          {folio && <Link href={`/lodging/folios/${folio.id}/statement`} className="btn"><Printer aria-hidden className="size-4" /> {t('lod.statement')}</Link>}
        </div>
        {!folio ? (
          <Note><Empty>{t('lod.noFolioYet')}</Empty></Note>
        ) : (
          <>
            <Note className="pr-2">
              {folio.entries.length ? (
                <RecordTable
                  rows={folio.entries}
                  rowKey={(e) => e.id}
                  dimmed={(e) => reversed.has(e.id)}
                  columns={[
                    { header: t('common.date'), cell: (e) => <Serial className="text-ink">{formatDate(e.nightDate ?? e.createdAt.slice(0, 10), lang)}</Serial> },
                    {
                      header: t('lod.entry'),
                      cell: (e) => (
                        <span data-entry={e.kind}>
                          {e.description ?? t(`lod.kind.${e.kind}` as MessageKey)}
                          {e.saleId && <> · <Link href={`/sales/${e.saleId}`} className="underline">{t('lod.openSale')}</Link></>}
                          {e.reason && <span className="block text-[0.8125rem] text-muted">{e.reason}</span>}
                        </span>
                      ),
                    },
                    { header: t('lod.kindCol'), cell: (e) => <span className="tag">{t(`lod.kind.${e.kind}` as MessageKey)}</span> },
                    { header: t('lod.amount'), num: true, cell: (e) => <span className="money">{signed(e.amount, peso)}</span> },
                    {
                      header: '',
                      cell: (e) =>
                        canRates && folio.status === 'OPEN' && e.kind === 'ROOM_NIGHT' && !reversed.has(e.id) ? (
                          <ReasonAction url={`/api/v1/folios/${folio.id}/night-reversals`} body={{ entryId: e.id }} label={t('lod.reverseNight')} reasonLabel={t('common.reason')} hint={t('lod.reverseNightHint')} idempotent />
                        ) : reversed.has(e.id) ? (
                          <span className="tag">{t('lod.reversed')}</span>
                        ) : null,
                    },
                  ]}
                  stacked={{
                    title: (e) => e.description ?? t(`lod.kind.${e.kind}` as MessageKey),
                    meta: (e) => (
                      <>
                        <Serial>{formatDate(e.nightDate ?? e.createdAt.slice(0, 10), lang)} · {t(`lod.kind.${e.kind}` as MessageKey)}{reversed.has(e.id) && ` · ${t('lod.reversed')}`}</Serial>
                        {canRates && folio.status === 'OPEN' && e.kind === 'ROOM_NIGHT' && !reversed.has(e.id) && (
                          <div className="mt-2"><ReasonAction url={`/api/v1/folios/${folio.id}/night-reversals`} body={{ entryId: e.id }} label={t('lod.reverseNight')} reasonLabel={t('common.reason')} idempotent /></div>
                        )}
                      </>
                    ),
                    figure: (e) => <span className="money font-semibold">{signed(e.amount, peso)}</span>,
                  }}
                  foot={{ cells: [t('lod.folioBalance'), '', '', <span key="b" className="money" data-testid="folio-balance">{peso(folio.balance)}</span>, ''], title: t('lod.folioBalance'), figure: <span className="money">{peso(folio.balance)}</span> }}
                />
              ) : (
                <Empty>{t('lod.noEntries')}</Empty>
              )}
            </Note>
            {folio.payments.length > 0 && (
              <p className="text-[0.875rem] text-muted">
                {t('lod.paymentsTaken', { n: folio.payments.length })}
              </p>
            )}
            {canRates && folio.status === 'OPEN' && <div><FolioAdjustment folioId={folio.id} /></div>}
            <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('lod.folioHint')}</p>
          </>
        )}
      </section>
    </div>
  );
}
