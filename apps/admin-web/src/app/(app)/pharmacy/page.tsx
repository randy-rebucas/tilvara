import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { SubNav } from '@/components/scope';
import { apiOrNull, type PrescriptionRow, type PrescriptionStatus } from '@/lib/api';
import { formatDate, qty } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { PharmacyChrome, PrescriptionTag, pharmacyAccess, pharmacyBranch } from './chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('pharmacy');

const FILTERS = ['open', 'all', 'OPEN', 'PARTLY_FILLED', 'FILLED', 'VOIDED'] as const;
type Filter = (typeof FILTERS)[number];

/**
 * The branch's prescriptions (ADR-0025 §6): those with something left to dispense by default, or by
 * status; search by patient, prescriber or yellow-form number. Each links to its record.
 */
export default async function PrescriptionsPage({ searchParams }: { searchParams: Promise<{ branch?: string; filter?: string; q?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await pharmacyBranch(sp.branch);
  const { canDispense, canRead } = await pharmacyAccess();
  const filter: Filter = (FILTERS as readonly string[]).includes(sp.filter ?? '') ? (sp.filter as Filter) : 'open';
  const q = sp.q?.trim().slice(0, 100) ?? '';
  const list = branch && canRead
    ? await apiOrNull<{ data: PrescriptionRow[] }>(`/prescriptions?${new URLSearchParams({ branchId: branch.id, limit: '200', ...(filter === 'open' && { open: 'true' }), ...(q && { q }) })}`)
    : null;
  const rows = (list?.data ?? []).filter((r) => filter === 'open' || filter === 'all' || r.status === filter);
  const status = (s: PrescriptionStatus) => <PrescriptionTag status={s} label={t(`pha.status.${s}` as MessageKey)} />;
  const href = (f: Filter) => `/pharmacy?${new URLSearchParams({ branch: branch?.id ?? '', ...(f !== 'open' && { filter: f }), ...(q && { q }) })}`;
  const label = (f: Filter) => (f === 'open' ? t('pha.filter.open') : f === 'all' ? t('common.all') : t(`pha.status.${f}` as MessageKey));
  const newHref = branch ? `/pharmacy/prescriptions/new?branch=${branch.id}` : '/pharmacy/prescriptions/new';

  return (
    <PharmacyChrome
      tab="prescriptions"
      branches={branches}
      branch={branch}
      extra={{ ...(filter !== 'open' && { filter }), ...(q && { q }) }}
      actions={canDispense && branch ? <Link href={newHref} className="btn btn-primary"><Plus aria-hidden className="size-4" /> {t('pha.newRx')}</Link> : undefined}
    >
      {!list ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          <form method="get" action="/pharmacy" className="flex flex-wrap items-end gap-2" role="search">
            <input type="hidden" name="branch" value={branch!.id} />
            {filter !== 'open' && <input type="hidden" name="filter" value={filter} />}
            <div className="field min-w-[16rem] flex-1 sm:max-w-[24rem]">
              <label htmlFor="rx-q">{t('pha.search')}</label>
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                <input id="rx-q" name="q" className="input pl-9" defaultValue={q} placeholder={t('pha.searchHint')} maxLength={100} />
              </div>
            </div>
            <button className="btn">{t('common.show')}</button>
          </form>

          <SubNav level={2} label={t('pha.filterLabel')} active={filter} items={FILTERS.map((f) => ({ key: f, href: href(f), label: label(f) }))} />

          <Note denom="none" className="pr-2">
            {rows.length ? (
              <RecordTable
                rows={rows}
                rowKey={(r) => r.id}
                dimmed={(r) => r.status === 'VOIDED'}
                columns={[
                  { header: t('pha.patient'), cell: (r) => <Link href={`/pharmacy/prescriptions/${r.id}`} className="font-semibold underline" data-rx-row>{r.patientName}</Link> },
                  { header: t('pha.prescriber'), cell: (r) => r.prescriberName },
                  { header: t('pha.issuedOn'), cell: (r) => <Serial className="text-ink">{formatDate(r.issuedOn, lang)}</Serial> },
                  { header: t('pha.yellowForm'), cell: (r) => <Serial>{r.yellowFormNo ?? '—'}</Serial> },
                  { header: t('pha.dispensedOf'), num: true, cell: (r) => <Serial className="text-ink">{qty(r.dispensed)} / {qty(r.prescribed)}</Serial> },
                  { header: t('common.status'), cell: (r) => status(r.status) },
                ]}
                stacked={{
                  title: (r) => <Link href={`/pharmacy/prescriptions/${r.id}`} className="underline">{r.patientName}</Link>,
                  meta: (r) => <Serial>{r.prescriberName} · {formatDate(r.issuedOn, lang)} · {qty(r.dispensed)} / {qty(r.prescribed)}</Serial>,
                  figure: (r) => status(r.status),
                }}
              />
            ) : (
              <Empty action={canDispense ? <Link href={newHref} className="btn">{t('pha.newRx')}</Link> : undefined}>{q ? t('pha.noMatch') : t('pha.noRx')}</Empty>
            )}
          </Note>
          <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('pha.listNote')}</p>
        </>
      )}
    </PharmacyChrome>
  );
}
