import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { allProducts, apiOrNull, type GarmentType, type LaundryMachine, type LaundrySettings } from '@/lib/api';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { LaundryChrome, laundryAccess, laundryBranch } from '../chrome';
import { AddGarmentType, AddMachine, EditMachine, GarmentTypeChip, LaundrySettingsForm } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('laundry.setup');

/**
 * Set-up (ADR-0024 §3, §6, §7, §9): the branch's washers and dryers, the garment types counted at
 * drop-off, and the branch's laundry settings. Services themselves are products (Products → a service
 * with a laundry unit), priced like any item.
 */
export default async function LaundrySetupPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const sp = await searchParams;
  const { t } = await getT();
  const { branches, branch } = await laundryBranch(sp.branch);
  const { canSetup } = await laundryAccess();
  const [machines, garments, settings, products] = branch
    ? await Promise.all([
        apiOrNull<{ data: LaundryMachine[] }>(`/laundry/machines?branchId=${branch.id}`),
        apiOrNull<{ data: GarmentType[] }>('/laundry/garment-types'),
        apiOrNull<LaundrySettings>(`/branches/${branch.id}/laundry-settings`),
        allProducts(),
      ])
    : [null, null, null, null];
  const services = (products?.data ?? [])
    .filter((p) => p.productType === 'SERVICE' && !p.archivedAt)
    .flatMap((p) => p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, label: `${v.sku} · ${p.name}${v.name ? ` — ${v.name}` : ''}` })));
  const list = machines?.data ?? [];

  return (
    <LaundryChrome tab="setup" branches={branches} branch={branch}>
      {!machines ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          <section aria-labelledby="machines" className="flex flex-col gap-3">
            <h2 id="machines" className="section-title">{t('lau.machinesOf', { branch: branch!.name })}</h2>
            <Note denom="blue" className="pr-2">
              {list.length ? (
                <RecordTable
                  rows={list}
                  rowKey={(m) => m.id}
                  columns={[
                    { header: t('lau.machineLabel'), cell: (m) => <b data-machine-row={m.label}>{m.label}</b> },
                    { header: t('lau.machineKind'), cell: (m) => t(`lau.kind.${m.kind}` as MessageKey) },
                    { header: t('lau.capacityKg'), num: true, cell: (m) => <Serial className="text-ink">{m.capacityKg ?? '—'}</Serial> },
                    { header: t('lau.cycleMinutes'), num: true, cell: (m) => <Serial className="text-ink">{m.cycleMinutes}</Serial> },
                    { header: t('common.status'), cell: (m) => (m.outOfOrderReason ? <span className="tag border-[#ead3a6]! bg-amber-bg! text-[#6b4a12]!">{t('lau.machineStatus.OUT_OF_ORDER')}</span> : <span className="tag">{t('lau.inService')}</span>) },
                    { header: '', cell: (m) => (canSetup ? <EditMachine machine={m} /> : null) },
                  ]}
                  stacked={{
                    title: (m) => <>{m.label} · {t(`lau.kind.${m.kind}` as MessageKey)}</>,
                    meta: (m) => (
                      <>
                        <Serial>{m.capacityKg ? `${m.capacityKg} kg · ` : ''}{t('lau.minutesN', { n: m.cycleMinutes })}{m.outOfOrderReason && ` · ${m.outOfOrderReason}`}</Serial>
                        {canSetup && <div className="mt-2"><EditMachine machine={m} /></div>}
                      </>
                    ),
                  }}
                />
              ) : (
                <Empty>{t('lau.noMachines')}</Empty>
              )}
            </Note>
            {canSetup && <div><AddMachine branchId={branch!.id} /></div>}
            <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('lau.cyclesHint')}</p>
          </section>

          <section aria-labelledby="garments" className="flex flex-col gap-3">
            <h2 id="garments" className="section-title">{t('lau.garmentTypes')}</h2>
            <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('lau.garmentTypesLede')}</p>
            <Note className="px-5 py-4 pr-8">
              {garments?.data.filter((g) => !g.archivedAt).length ? (
                <div className="flex flex-wrap gap-2">
                  {garments.data.filter((g) => !g.archivedAt).map((g) => (canSetup ? <GarmentTypeChip key={g.id} type={g} /> : <span key={g.id} className="tag">{g.name}</span>))}
                </div>
              ) : (
                <p className="text-[0.875rem] text-muted">{t('lau.noGarmentTypes')}</p>
              )}
            </Note>
            {canSetup && <AddGarmentType />}
          </section>

          {settings && (
            <section aria-labelledby="branch-settings" className="flex flex-col gap-3">
              <h2 id="branch-settings" className="section-title">{t('lau.settingsOf', { branch: branch!.name })}</h2>
              <Callout tone="warn">{t('lau.policyUnverified')}</Callout>
              <Note className="px-5 py-4 pr-8">
                {canSetup ? (
                  <LaundrySettingsForm settings={settings} services={services} />
                ) : (
                  <dl className="grid gap-2 text-[0.9375rem] sm:grid-cols-3">
                    <div><dt className="text-[0.8125rem] text-muted">{t('lau.regularHours')}</dt><dd>{settings.regularHours}</dd></div>
                    <div><dt className="text-[0.8125rem] text-muted">{t('lau.expressHours')}</dt><dd>{settings.expressHours}</dd></div>
                    <div><dt className="text-[0.8125rem] text-muted">{t('lau.unclaimedDays')}</dt><dd>{settings.unclaimedDays}</dd></div>
                  </dl>
                )}
              </Note>
            </section>
          )}
        </>
      )}
    </LaundryChrome>
  );
}
