import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure, SubNav } from '@/components/scope';
import { apiOrNull, type JobOrderRow, type JobOrderStatus } from '@/lib/api';
import { formatDateTime, peso, signOf } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { JobTag, LaundryChrome, laundryAccess, laundryBranch } from './chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('laundry');

const FILTERS = ['open', 'RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY', 'OUT_FOR_DELIVERY', 'overdue', 'unclaimed', 'CLAIMED', 'CANCELLED', 'DISPOSED'] as const;
type Filter = (typeof FILTERS)[number];

/**
 * The job board (ADR-0024 §3): the branch's job orders by status, with the overdue ones (past their
 * promised time and not ready) and the unclaimed ones (ready beyond the branch's days) apart. Each
 * links to its job. New jobs are taken in here; the claim is a sale at the till.
 */
export default async function JobBoardPage({ searchParams }: { searchParams: Promise<{ branch?: string; filter?: string; q?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await laundryBranch(sp.branch);
  const { canManage } = await laundryAccess();
  const filter: Filter = (FILTERS as readonly string[]).includes(sp.filter ?? '') ? (sp.filter as Filter) : 'open';
  const q = sp.q?.trim().slice(0, 60) ?? '';
  const query = (f: Filter) => {
    const p = new URLSearchParams({ branchId: branch!.id, limit: '200' });
    if (f === 'open') p.set('open', 'true');
    else if (f === 'overdue') p.set('overdue', 'true');
    else if (f === 'unclaimed') p.set('unclaimed', 'true');
    else p.set('status', f);
    if (q) p.set('q', q);
    return `/job-orders?${p}`;
  };
  const [list, open, overdue, unclaimed] = branch
    ? await Promise.all([
        apiOrNull<{ data: JobOrderRow[] }>(query(filter)),
        apiOrNull<{ data: JobOrderRow[] }>(`/job-orders?${new URLSearchParams({ branchId: branch.id, open: 'true', limit: '200' })}`),
        apiOrNull<{ data: JobOrderRow[] }>(`/job-orders?${new URLSearchParams({ branchId: branch.id, overdue: 'true', limit: '200' })}`),
        apiOrNull<{ data: JobOrderRow[] }>(`/job-orders?${new URLSearchParams({ branchId: branch.id, unclaimed: 'true', limit: '200' })}`),
      ])
    : [null, null, null, null];
  const count = (s: JobOrderStatus) => (open?.data ?? []).filter((j) => j.status === s).length;
  const unclaimedIds = new Set((unclaimed?.data ?? []).map((j) => j.id));
  const label = (f: Filter) =>
    f === 'open' ? `${t('lau.filter.open')} · ${open?.data.length ?? 0}`
      : f === 'overdue' ? `${t('lau.filter.overdue')} · ${overdue?.data.length ?? 0}`
        : f === 'unclaimed' ? `${t('lau.filter.unclaimed')} · ${unclaimed?.data.length ?? 0}`
          : ['CLAIMED', 'CANCELLED', 'DISPOSED'].includes(f) ? t(`lau.status.${f}` as MessageKey)
            : `${t(`lau.status.${f}` as MessageKey)} · ${count(f as JobOrderStatus)}`;
  const href = (f: Filter) => `/laundry?${new URLSearchParams({ branch: branch?.id ?? '', ...(f !== 'open' && { filter: f }), ...(q && { q }) })}`;
  const who = (j: JobOrderRow) => j.customerDisplayName ?? '—';
  const tag = (j: JobOrderRow) => {
    const warn = j.overdue || unclaimedIds.has(j.id);
    const text = j.overdue ? t('lau.overdue') : unclaimedIds.has(j.id) ? t('lau.unclaimed') : t(`lau.status.${j.status}` as MessageKey);
    return <JobTag status={j.status} label={text} warn={warn} />;
  };

  return (
    <LaundryChrome
      tab="board"
      branches={branches}
      branch={branch}
      extra={{ ...(filter !== 'open' && { filter }), ...(q && { q }) }}
      actions={canManage && branch ? (
        <Link href={`/laundry/new?branch=${branch.id}`} className="btn btn-primary"><Plus aria-hidden className="size-4" /> {t('lau.newJob')}</Link>
      ) : undefined}
    >
      {!list || !open ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : (
        <>
          <Note className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4" denom="blue">
            <Figure label={t('lau.inProcess')}>{count('RECEIVED') + count('WASHING') + count('DRYING') + count('FOLDING')}</Figure>
            <Figure label={t('lau.readyForPickup')}>{count('READY')}</Figure>
            <Figure label={t('lau.filter.overdue')} tone={(overdue?.data.length ?? 0) > 0 ? 'red' : undefined}>{overdue?.data.length ?? 0}</Figure>
            <Figure label={t('lau.filter.unclaimed')}>{unclaimed?.data.length ?? 0}</Figure>
          </Note>

          <form method="get" action="/laundry" className="flex flex-wrap items-end gap-2" role="search">
            <input type="hidden" name="branch" value={branch!.id} />
            {filter !== 'open' && <input type="hidden" name="filter" value={filter} />}
            <div className="field min-w-[16rem] flex-1 sm:max-w-[24rem]">
              <label htmlFor="job-q">{t('lau.search')}</label>
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                <input id="job-q" name="q" className="input pl-9" defaultValue={q} placeholder={t('lau.searchHint')} maxLength={60} />
              </div>
            </div>
            <button className="btn">{t('common.show')}</button>
          </form>

          <SubNav level={2} label={t('lau.filterLabel')} active={filter} items={FILTERS.map((f) => ({ key: f, href: href(f), label: label(f) }))} />

          <Note className="pr-2">
            {list.data.length ? (
              <RecordTable
                rows={list.data}
                rowKey={(j) => j.id}
                columns={[
                  { header: t('lau.job'), cell: (j) => <Link href={`/laundry/jobs/${j.id}`} className="serial font-semibold underline" data-job={j.reference}>{j.reference}</Link> },
                  { header: t('lau.customer'), cell: (j) => <span className="font-semibold">{who(j)}</span> },
                  { header: t('lau.promised'), cell: (j) => <Serial className="text-ink">{formatDateTime(j.promisedAt, lang)}{j.serviceLevel === 'EXPRESS' && ` · ${t('lau.express')}`}</Serial> },
                  { header: t('lau.bags'), num: true, cell: (j) => <Serial className="text-ink">{j.bagCount}{j.weightKg && ` · ${j.weightKg} kg`}</Serial> },
                  { header: t('lau.balance'), num: true, cell: (j) => <span className="money">{peso(signOf(j.balance) > 0 ? j.balance : '0')}</span> },
                  { header: t('common.status'), cell: (j) => tag(j) },
                ]}
                stacked={{
                  title: (j) => <Link href={`/laundry/jobs/${j.id}`} className="underline">{j.reference} · {who(j)}</Link>,
                  meta: (j) => <Serial>{t('lau.promised')} {formatDateTime(j.promisedAt, lang)} · {t('lau.bagsN', { n: j.bagCount })}</Serial>,
                  figure: (j) => tag(j),
                }}
              />
            ) : (
              <Empty action={canManage ? <Link href={`/laundry/new?branch=${branch!.id}`} className="btn">{t('lau.newJob')}</Link> : undefined}>{q ? t('lau.noMatch') : t('lau.noJobs')}</Empty>
            )}
          </Note>
        </>
      )}
    </LaundryChrome>
  );
}
