import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { api, apiOrNull, type LegalEntity, type Me, type TaxProfile } from '@/lib/api';
import { formatDateTime, formatTin, percentFromRate } from '@/lib/format';
import { isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { ChangeTaxForm } from './tax-form';

export const metadata = { title: 'Legal entity' };

const STATE_TONE = { IN_FORCE: 'chip bg-violet', SCHEDULED: 'tag tag-warn', SUPERSEDED: 'tag' } as const;

/** A legal entity and its tax registration over time (ADR-0008: versioned, effective-dated, never backdated). */
export default async function EntityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [me, entities, profiles] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: LegalEntity[] }>('/legal-entities'),
    apiOrNull<{ data: TaxProfile[] }>(`/legal-entities/${id}/tax-profiles`),
  ]);
  const entity = entities?.data.find((e) => e.id === id);
  if (!entity) notFound();
  const canChange = (me.activeTenant?.permissions.includes('tax.manage') ?? false) && !entity.archivedAt;
  const inForce = profiles?.data.find((p) => p.state === 'IN_FORCE');
  const rateLine = (p: TaxProfile) =>
    p.vatStatus === 'VAT' ? t('tax.vatAt', { rate: percentFromRate(p.vatRate) }) : t('tax.ptAt', { rate: percentFromRate(p.percentageTaxRate) });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/locations" className="text-[0.875rem] text-muted underline">{t('nav.locations')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{entity.registeredName}</h1>
        <Serial className="mt-1 block">TIN {formatTin(entity.tin)}{entity.tradeName && ` · ${entity.tradeName}`}</Serial>
      </div>

      <Callout>{t('tax.review')}</Callout>

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('tax.title')}</h2>
          {canChange && <ChangeTaxForm legalEntityId={entity.id} current={inForce?.vatStatus ?? null} />}
        </div>
        {profiles && profiles.data.length > 0 ? (
          <div className="flex flex-col gap-3">
            {profiles.data.map((p) => (
              <Note key={p.id} denom={p.state === 'IN_FORCE' ? 'violet' : 'none'} className="px-4 py-3 pr-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">
                    {p.vatStatus === 'VAT' ? t('loc.vatReg') : t('loc.nonVat')} <span className={`ml-2 ${STATE_TONE[p.state]}`}>{t(`tax.state.${p.state}` as MessageKey)}</span>
                  </p>
                  <Serial>{t('tax.from', { date: formatDateTime(p.effectiveFrom, lang) })}</Serial>
                </div>
                <p className="mt-1 text-[0.875rem] text-muted">{rateLine(p)} · {t(`tax.${p.roundingMode}` as MessageKey)}</p>
                {p.note && <p className="mt-1 text-[0.875rem]">{p.note}</p>}
              </Note>
            ))}
          </div>
        ) : (
          <Note><Empty>{profiles ? t('tax.none') : t('common.noAccess')}</Empty></Note>
        )}
      </section>
    </div>
  );
}
