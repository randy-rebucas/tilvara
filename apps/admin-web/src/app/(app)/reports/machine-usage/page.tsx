import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { MachineUsageReport } from '@/lib/api';
import { peso } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.machine-usage');

/**
 * Machine usage (ADR-0024 §13): per washer and dryer, cycles and minutes run (self-service and
 * drop-off loads apart), the share of the range it ran, and what its self-service cycles sold.
 */
export default async function MachineUsagePage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<MachineUsageReport>(`/reports/machine-usage?${new URLSearchParams({ branchId: scope.branch.id, from: scope.from, to: scope.to })}`) : null;
  const d = r?.data;
  return (
    <ReportsChrome tab="machineUsage" scope={scope} error={r?.error}>
      {d && (
        <>
          <Note denom="blue" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-3">
            <Figure label={t('rep.selfServiceCycles')}>{d.totals.selfServiceCycles}</Figure>
            <Figure label={t('rep.dropOffCycles')}>{d.totals.dropOffCycles}</Figure>
            <Figure label={t('rep.selfServiceSales')}>{peso(d.totals.selfServiceSales)}</Figure>
          </Note>
          <Note className="pr-2">
            {d.machines.length ? (
              <RecordTable
                rows={d.machines}
                rowKey={(x) => x.machineId}
                columns={[
                  { header: t('lau.machine'), cell: (x) => <span className="font-semibold">{x.label}{x.archived && <span className="tag ml-2">{t('prod.archived')}</span>}</span> },
                  { header: t('lau.machineKind'), cell: (x) => t(`lau.kind.${x.kind}` as MessageKey) },
                  { header: t('rep.selfServiceCycles'), num: true, cell: (x) => x.selfServiceCycles },
                  { header: t('rep.dropOffCycles'), num: true, cell: (x) => x.dropOffCycles },
                  { header: t('rep.minutesRun'), num: true, cell: (x) => x.selfServiceMinutes + x.dropOffMinutes },
                  { header: t('rep.utilisation'), num: true, cell: (x) => (x.utilisationPercent === null ? '—' : `${x.utilisationPercent}%`) },
                  { header: t('rep.selfServiceSales'), num: true, cell: (x) => <span className="money">{peso(x.selfServiceSales)}</span> },
                ]}
                stacked={{
                  title: (x) => <>{x.label} · {t(`lau.kind.${x.kind}` as MessageKey)}</>,
                  meta: (x) => <Serial>{t('rep.cyclesOf', { self: x.selfServiceCycles, drop: x.dropOffCycles })} · {x.utilisationPercent ?? '—'}%</Serial>,
                  figure: (x) => <span className="money font-semibold">{peso(x.selfServiceSales)}</span>,
                }}
              />
            ) : (
              <Empty>{t('lau.noMachines')}</Empty>
            )}
          </Note>
          <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('rep.machineUsageHint')}</p>
        </>
      )}
    </ReportsChrome>
  );
}
