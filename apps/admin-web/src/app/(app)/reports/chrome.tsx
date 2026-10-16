import type { ReactNode } from 'react';
import { Callout, Empty, Note, PageHeader } from '@/components/note';
import { ScopePicker, SubNav } from '@/components/scope';
import { api, apiOrNull, ApiError, type Branch } from '@/lib/api';
import { todayManila } from '@/lib/format';
import { getT } from '@/i18n/server';

export type ReportTab = 'items' | 'usage' | 'voids' | 'prep' | 'open' | 'charge';
const PATHS: Record<ReportTab, string> = {
  items: '/reports',
  usage: '/reports/ingredient-usage',
  voids: '/reports/kitchen-voids',
  prep: '/reports/prep-times',
  open: '/reports/open-orders',
  charge: '/reports/service-charge',
};

export interface ReportQuery {
  branch?: string;
  from?: string;
  to?: string;
  day?: string;
}

const isDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Branch (?branch=, else the first) and local dates (?from=&to= or ?day=), defaulting to today in Manila. */
export async function reportScope(q: ReportQuery) {
  const list = await apiOrNull<{ data: Branch[] }>('/branches');
  const branches = list?.data.filter((b) => !b.archivedAt) ?? [];
  const today = todayManila();
  return {
    branches,
    branch: branches.find((b) => b.id === q.branch) ?? branches[0],
    from: isDate(q.from) ? q.from! : today,
    to: isDate(q.to) ? q.to! : today,
    day: isDate(q.day) ? q.day! : today,
  };
}

/** A report from the API, or the API's own message (bad range, no access) to show instead. */
export async function loadReport<T>(path: string): Promise<{ data: T; error?: undefined } | { data?: undefined; error: string }> {
  try {
    return { data: await api<T>(path) };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // A refused range carries the specific rule in its issues ("from" after "to", over 366 days).
    const issues = (e.details?.issues as { message: string }[] | undefined)?.map((i) => i.message).join(' ');
    return { error: issues || e.message };
  }
}

/** Header, report tabs, branch picker and the date form shared by the report pages. */
export async function ReportsChrome({ tab, scope, error, children }: {
  tab: ReportTab;
  scope: Awaited<ReturnType<typeof reportScope>>;
  error?: string;
  children: ReactNode;
}) {
  const { t } = await getT();
  const { branches, branch, from, to, day } = scope;
  const keep = (k: ReportTab) => `${PATHS[k]}?${new URLSearchParams({ ...(branch && { branch: branch.id }), ...(k === 'open' ? { day } : { from, to }) })}`;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('rep.title')} lede={t('rep.lede')} />
      <SubNav label={t('common.sections')} active={tab} items={(Object.keys(PATHS) as ReportTab[]).map((k) => ({ key: k, href: keep(k), label: t(`rep.tab.${k}`) }))} />
      <ScopePicker label={t('common.branch')} items={branches} selected={branch?.id} href={(id) => `${PATHS[tab]}?${new URLSearchParams({ branch: id, ...(tab === 'open' ? { day } : { from, to }) })}`} />
      {branch && (
        // A plain GET form: the range lives in the URL, so a report can be bookmarked or shared.
        <form method="get" action={PATHS[tab]} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="branch" value={branch.id} />
          {tab === 'open' ? (
            <div className="field">
              <label htmlFor="day">{t('rep.closeOf')}</label>
              <input id="day" name="day" type="date" className="input" defaultValue={day} />
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="from">{t('common.from')}</label>
                <input id="from" name="from" type="date" className="input" defaultValue={from} />
              </div>
              <div className="field">
                <label htmlFor="to">{t('common.to')}</label>
                <input id="to" name="to" type="date" className="input" defaultValue={to} />
              </div>
            </>
          )}
          <button className="btn">{t('common.show')}</button>
        </form>
      )}
      {!branch ? <Note><Empty>{t('inv.noBranch')}</Empty></Note> : error ? <Callout tone="error">{error}</Callout> : children}
    </div>
  );
}
