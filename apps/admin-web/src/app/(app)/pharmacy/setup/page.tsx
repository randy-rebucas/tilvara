import Link from 'next/link';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type Pharmacist, type PharmacySettings } from '@/lib/api';
import { formatDate, todayManila } from '@/lib/format';
import { getT } from '@/i18n/server';
import { PharmacyChrome, pharmacyAccess } from '../chrome';
import { PharmacistLicence, PharmacySettingsForm } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('pharmacy.setup');

/**
 * Pharmacy set-up (ADR-0025 §6, §8): whether an SC/PWD discount on medicine needs the purchase
 * booklet, and the members' pharmacist licences (a dangerous drug is dispensed only by a member with
 * the permission and a licence in force). Roles "Pharmacist" and "Pharmacy Assistant" are under Team.
 */
export default async function PharmacySetupPage() {
  const { t, lang } = await getT();
  const { canSetup } = await pharmacyAccess();
  const [settings, pharmacists] = canSetup
    ? await Promise.all([apiOrNull<PharmacySettings>('/pharmacy/settings'), apiOrNull<{ data: Pharmacist[] }>('/pharmacy/pharmacists')])
    : [null, null];
  const today = todayManila();
  const state = (p: Pharmacist) =>
    !p.licenseNo ? <span className="tag">{t('pha.noLicence')}</span>
      : p.validUntil && p.validUntil < today ? <span className="tag border-red/50! text-red!">{t('pha.licenceExpired')}</span>
        : <span className="tag border-blue! bg-blue! text-white!">{t('pha.licenceInForce')}</span>;

  return (
    <PharmacyChrome tab="setup">
      {!settings ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          <section aria-labelledby="pha-rules" className="flex max-w-[720px] flex-col gap-3">
            <h2 id="pha-rules" className="section-title">{t('pha.rules')}</h2>
            <Note className="px-5 py-4 pr-8">
              <PharmacySettingsForm settings={settings} canEdit={canSetup} />
            </Note>
            <p className="text-[0.8125rem] text-muted">{t('pha.expiredRuleWhere')} <Link href="/inventory/settings" className="underline">{t('invset.title')}</Link></p>
          </section>

          <section aria-labelledby="pha-pharmacists" className="flex flex-col gap-3">
            <h2 id="pha-pharmacists" className="section-title">{t('pha.pharmacists')}</h2>
            <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('pha.pharmacistsLede')}</p>
            <Note denom="green" className="pr-2">
              {pharmacists?.data.length ? (
                <RecordTable
                  rows={pharmacists.data}
                  rowKey={(p) => p.membershipId}
                  columns={[
                    { header: t('common.name'), cell: (p) => <b data-pharmacist={p.name}>{p.name}</b> },
                    { header: t('pha.licenceNo'), cell: (p) => <Serial className="text-ink">{p.licenseNo ?? '—'}</Serial> },
                    { header: t('pha.validUntil'), cell: (p) => (p.validUntil ? formatDate(p.validUntil, lang) : '—') },
                    { header: t('pha.ddPermission'), cell: (p) => (p.dispensesDangerousDrugs ? t('pha.yes') : t('pha.no')) },
                    { header: t('common.status'), cell: state },
                    { header: '', cell: (p) => <PharmacistLicence pharmacist={p} /> },
                  ]}
                  stacked={{
                    title: (p) => p.name,
                    meta: (p) => <><Serial>{p.licenseNo ?? t('pha.noLicence')}{p.validUntil && ` · ${formatDate(p.validUntil, lang)}`}</Serial><div className="mt-2"><PharmacistLicence pharmacist={p} /></div></>,
                    figure: state,
                  }}
                />
              ) : (
                <Empty>{t('pha.noPharmacists')}</Empty>
              )}
            </Note>
            <Callout tone="warn">{t('pha.unverified')}</Callout>
          </section>
        </>
      )}
    </PharmacyChrome>
  );
}
