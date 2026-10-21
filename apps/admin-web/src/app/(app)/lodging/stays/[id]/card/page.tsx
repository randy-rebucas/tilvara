import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Note, Serial } from '@/components/note';
import { PrintButton } from '@/components/print-button';
import { apiOrNull, type RegistrationCard } from '@/lib/api';
import { formatDate, formatDateTime, formatTin, peso } from '@/lib/format';
import { isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('lodging.stays.item.card');

/** The guest registration card (ADR-0023 §8), to print and sign at check-in. */
export default async function RegistrationCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const card = await apiOrNull<RegistrationCard>(`/stays/${id}/registration-card`);
  if (!card) notFound();
  const s = card.stay;
  const row = (label: string, value: string | number | null | undefined) => (
    <div className="min-w-0">
      <dt className="text-[0.8125rem] text-muted">{label}</dt>
      <dd className="font-semibold">{value === null || value === undefined || value === '' ? '—' : value}</dd>
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/lodging/stays/${id}`} className="text-[0.875rem] text-muted underline">{t('lod.backToStay')}</Link>
        <PrintButton />
      </div>
      <Note className="mx-auto w-full max-w-[820px] px-6 py-6 pr-8" as="article">
        <header className="border-b border-hair pb-3">
          <p className="text-[1.0625rem] font-semibold">{card.business.tradeName ?? card.business.registeredName}</p>
          <Serial className="block">{card.business.registeredName} · TIN {formatTin(card.business.tin)}</Serial>
          <Serial className="block">{card.branch.name}{card.branch.address && ` · ${card.branch.address}`}</Serial>
          <h1 className="mt-3 text-[1.5rem] font-bold" data-testid="card-title">{t('lod.registrationCard')}</h1>
        </header>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {row(t('lod.room'), `${s.roomNumber} · ${s.roomType}`)}
          {row(t('lod.arrival'), formatDate(s.arrivalDate, lang))}
          {row(t('lod.departure'), formatDate(s.departureDate, lang))}
          {row(t('lod.guests'), t('lod.guestsOf', { adults: s.adults, children: s.children }))}
          {row(t('lod.nightlyRate'), s.nightlyRate ? peso(s.nightlyRate) : t('lod.rackRate'))}
          {row(t('lod.source'), t(`lod.source.${s.source}` as MessageKey))}
          {row(t('lod.externalReference'), s.externalReference)}
          {row(t('lod.checkedIn'), s.checkedInAt ? formatDateTime(s.checkedInAt, lang) : null)}
        </dl>
        <h2 className="section-title mt-6 mb-2">{t('lod.registry')}</h2>
        <ol className="grid gap-3">
          {card.guests.map((g, i) => (
            <li key={g.id} className="rounded-[5px] border border-hair-soft px-4 py-3">
              <p className="font-semibold">{i + 1}. {g.fullName}{g.isPrimary && <span className="tag ml-2">{t('lod.g.primary')}</span>}</p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-[0.875rem] sm:grid-cols-3">
                {row(t('lod.g.nationality'), g.nationality)}
                {row(t('lod.g.idType'), g.idType)}
                {row(t('lod.g.idNumber'), g.idNumber)}
                {row(t('lod.g.birthDate'), g.birthDate ? formatDate(g.birthDate, lang) : null)}
                {row(t('lod.g.contact'), g.contact)}
                {row(t('lod.g.address'), g.address)}
              </dl>
            </li>
          ))}
          {card.guests.length === 0 && <li className="text-muted">{t('lod.noGuestsYet')}</li>}
        </ol>
        <p className="mt-6 text-[0.9375rem]">{t('lod.declaration')}</p>
        <div className="mt-10 grid gap-8 sm:grid-cols-2">
          <div className="border-t border-ink pt-1 text-[0.8125rem] text-muted">{t('lod.guestSignature')}</div>
          <div className="border-t border-ink pt-1 text-[0.8125rem] text-muted">{t('common.date')}</div>
        </div>
      </Note>
    </div>
  );
}
