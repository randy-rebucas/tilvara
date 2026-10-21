import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { apiOrNull, type MachineBoard } from '@/lib/api';
import { duration, formatDateTime } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { LaundryChrome, laundryAccess, laundryBranch } from '../chrome';
import { CancelQueuedRun, StopRun } from '../jobs/[id]/forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('laundry.machines');

/**
 * The machine board (ADR-0024 §7): every washer and dryer of the branch with what runs on it now (a
 * self-service cycle sold at the till, or a job's load) and the time left, when it is next free, and
 * whether it is out of order. Washers first.
 */
export default async function MachinesPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await laundryBranch(sp.branch);
  const { canManage, canSetup } = await laundryAccess();
  const board = branch ? await apiOrNull<MachineBoard>(`/laundry/machines/board?branchId=${branch.id}`) : null;
  const running = board?.data.filter((m) => m.status === 'RUNNING').length ?? 0;

  return (
    <LaundryChrome
      tab="machines"
      branches={branches}
      branch={branch}
      actions={branch ? <Link href={`/laundry/machines?branch=${branch.id}`} className="btn"><RefreshCw aria-hidden className="size-4" /> {t('lau.refresh')}</Link> : undefined}
    >
      {!board ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : board.data.length === 0 ? (
        <Note><Empty action={canSetup ? <Link href={`/laundry/setup?branch=${branch!.id}`} className="btn">{t('lau.tab.setup')}</Link> : undefined}>{t('lau.noMachines')}</Empty></Note>
      ) : (
        <>
          <p className="text-[0.875rem] text-muted" data-testid="board-as-of">{t('lau.boardAsOf', { at: formatDateTime(board.asOf, lang), running, total: board.data.length })}</p>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="machine-board">
            {board.data.map((m) => (
              <Note key={m.id} as="li" denom={m.kind === 'WASHER' ? 'blue' : 'orange'} className="flex flex-col gap-2 px-4 py-3 pr-6">
                <div className="flex items-start justify-between gap-2" data-machine={m.label}>
                  <div className="min-w-0">
                    <p className="text-[1.0625rem] font-semibold">{m.label}</p>
                    <Serial>{t(`lau.kind.${m.kind}` as MessageKey)}{m.capacityKg && ` · ${m.capacityKg} kg`} · {t('lau.minutesN', { n: m.cycleMinutes })}</Serial>
                  </div>
                  <span
                    className={m.status === 'RUNNING' ? 'tag border-blue! bg-blue! text-white!' : m.status === 'OUT_OF_ORDER' ? 'tag border-[#ead3a6]! bg-amber-bg! text-[#6b4a12]!' : 'tag'}
                    data-machine-status={m.status}
                  >
                    {t(`lau.machineStatus.${m.status}` as MessageKey)}
                  </span>
                </div>
                {m.current ? (
                  <div className="text-[0.9375rem]">
                    <p>
                      {m.current.source === 'JOB' && m.current.jobOrderId ? (
                        <Link href={`/laundry/jobs/${m.current.jobOrderId}`} className="font-semibold underline">{m.current.jobReference}</Link>
                      ) : (
                        <span className="font-semibold">{t('lau.selfService')}{m.current.saleNumber !== null && ` · #${m.current.saleNumber}`}</span>
                      )}
                      {' · '}{t('lau.timeLeft', { left: duration(m.current.secondsLeft) })}
                    </p>
                    <Serial>{t('lau.endsAt', { at: formatDateTime(m.current.endsAt, lang) })}</Serial>
                    {canManage && <div className="mt-2"><StopRun runId={m.current.runId} /></div>}
                  </div>
                ) : m.outOfOrderReason ? (
                  <p className="text-[0.875rem] text-muted">{m.outOfOrderReason}</p>
                ) : (
                  <p className="text-[0.875rem] text-muted">{t('lau.freeNow')}</p>
                )}
                {m.queued.length > 0 && (
                  <ul className="flex flex-col gap-1.5 border-t border-hair-soft pt-2 text-[0.875rem]" aria-label={t('lau.queuedLabel')} data-testid="machine-queued">
                    {m.queued.map((q) => (
                      <li key={q.runId} className="flex flex-wrap items-center justify-between gap-2">
                        <span>{t('lau.queuedRun', { sale: q.saleNumber !== null ? `#${q.saleNumber}` : '—', at: formatDateTime(q.startsAt, lang) })}</span>
                        {canManage && <CancelQueuedRun runId={q.runId} />}
                      </li>
                    ))}
                  </ul>
                )}
              </Note>
            ))}
          </ul>
          <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('lau.machinesHint')}</p>
        </>
      )}
    </LaundryChrome>
  );
}
