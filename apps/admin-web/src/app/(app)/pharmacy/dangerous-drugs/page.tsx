import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { DangerousDrugsBook } from '@/lib/api';
import { formatDate, qty } from '@/lib/format';
import { genericLabel } from '@/lib/pharmacy';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { loadReport } from '../../reports/chrome';
import { BookRangeForm, PharmacyChrome, bookRange, pharmacyBranch } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('pharmacy.dangerous-drugs');

const FIGURES = ['opening', 'received', 'dispensed', 'returned', 'writtenOff', 'adjusted', 'otherOut', 'closing'] as const;

/**
 * The dangerous drugs register (ADR-0025 §10): for each item classed as a dangerous drug, the branch's
 * stock at the start of the range, what came in and went out, and the closing stock, with every
 * dispensing and its yellow prescription form. The layout is to be checked against the DDB form.
 */
export default async function DangerousDrugsPage({ searchParams }: { searchParams: Promise<{ branch?: string; from?: string; to?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await pharmacyBranch(sp.branch);
  const { from, to } = bookRange(sp);
  const r = branch ? await loadReport<DangerousDrugsBook>(`/reports/dangerous-drugs?branchId=${branch.id}&from=${from}&to=${to}`) : null;
  const drugs = r?.data?.data ?? [];
  return (
    <PharmacyChrome tab="dangerous" branches={branches} branch={branch} extra={{ from, to }}>
      {branch && <BookRangeForm tab="dangerous" branch={branch} from={from} to={to} report="dangerousDrugs" />}
      <p className="max-w-[68ch] text-[0.875rem] text-muted print:hidden">{t('pha.ddLede')}</p>
      {r?.error ? (
        <Callout tone="error">{r.error}</Callout>
      ) : drugs.length === 0 ? (
        <Note denom="ink"><Empty>{t('pha.ddEmpty')}</Empty></Note>
      ) : (
        drugs.map((d) => (
          <Note key={d.variantId} denom="ink" className="flex flex-col gap-3 py-4 pr-2" as="article">
            <div className="px-5">
              <p className="font-semibold" data-dd-drug={d.sku}>{d.name}</p>
              <Serial>{d.sku} · {genericLabel(t, d)}</Serial>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-5 pr-8 text-[0.9375rem] sm:grid-cols-4 lg:grid-cols-8">
              {FIGURES.map((k) => (
                <div key={k}>
                  <dt className="text-[0.75rem] text-muted">{t(`pha.dd.${k}` as MessageKey)}</dt>
                  <dd className={k === 'closing' || k === 'opening' ? 'font-semibold' : ''} data-dd-figure={k}>{qty(d[k])}</dd>
                </div>
              ))}
            </dl>
            {d.dispensings.length > 0 ? (
              <RecordTable
                rows={d.dispensings}
                rowKey={(x) => `${x.saleReference}:${x.yellowFormNo}:${x.quantity}`}
                columns={[
                  { header: t('common.date'), cell: (x) => <Serial className="text-ink">{formatDate(x.day, lang)}</Serial> },
                  { header: t('pha.sale'), cell: (x) => <Serial className="text-ink">{x.saleReference}</Serial> },
                  { header: t('pha.yellowForm'), cell: (x) => <Serial className="text-ink">{x.yellowFormNo ?? '—'}</Serial> },
                  { header: t('pha.patient'), cell: (x) => <>{x.patientName}{x.patientAddress && <span className="block text-[0.8125rem] text-muted">{x.patientAddress}</span>}</> },
                  { header: t('pha.prescriber'), cell: (x) => <>{x.prescriberName}<Serial className="block">{t('pha.prcShort', { no: x.prescriberLicenseNo })}{x.prescriberS2No && ` · S2 ${x.prescriberS2No}`}</Serial></> },
                  { header: t('common.quantity'), num: true, cell: (x) => <b>{qty(x.quantity)}</b> },
                  { header: t('pha.pharmacist'), cell: (x) => x.pharmacist ?? '—' },
                ]}
                stacked={{
                  title: (x) => x.patientName,
                  meta: (x) => <Serial>{formatDate(x.day, lang)} · {x.saleReference} · {t('pha.yellowShort', { no: x.yellowFormNo ?? '—' })}</Serial>,
                  figure: (x) => <b>{qty(x.quantity)}</b>,
                }}
              />
            ) : (
              <p className="px-5 text-[0.875rem] text-muted">{t('pha.ddNoDispensing')}</p>
            )}
          </Note>
        ))
      )}
      <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('pha.ddCheck')}</p>
    </PharmacyChrome>
  );
}
