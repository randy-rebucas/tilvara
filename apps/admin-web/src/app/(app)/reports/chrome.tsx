import { Download } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Callout, Empty, Note, PageHeader, ToLocations } from '@/components/note';
import { ScopePicker, SubNav } from '@/components/scope';
import { api, apiOrNull, ApiError, type Branch, type Me } from '@/lib/api';
import { PrintButton } from '@/components/print-button';
import { datePresets, formatDateTime, todayManila } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';

export type ReportTab =
  | 'sales' | 'products' | 'cashiers' | 'refunds' | 'tenders' | 'tax' | 'statutory' | 'z'
  | 'promotions' | 'attributes'
  | 'category' | 'branches' | 'discounts' | 'purchases' | 'payments';
const PATHS: Record<ReportTab, string> = {
  sales: '/reports/sales',
  products: '/reports/products',
  promotions: '/reports/promotions',
  attributes: '/reports/sizes-colours',
  cashiers: '/reports/cashiers',
  refunds: '/reports/refunds',
  tenders: '/reports/tenders',
  tax: '/reports/tax',
  statutory: '/reports/statutory',
  z: '/reports/z-readings',
  category: '/reports/categories',
  branches: '/reports/branches',
  discounts: '/reports/discounts',
  purchases: '/reports/purchases',
  payments: '/reports/payments',
};
/** All branches at once: no branch to pick. */
const CONSOLIDATED: readonly ReportTab[] = ['branches'];
/** As things stand now: no dates to pick. */
const UNDATED: readonly ReportTab[] = ['payments'];
const GROUPS = {
  // ADR-0021: promotions and sizes and colours sit with the everyday sales reports (every plan).
  sales: ['sales', 'products', 'promotions', 'attributes', 'cashiers', 'refunds', 'tenders', 'tax', 'statutory', 'z'],
  // Session 20 (SPEC §6.10): across categories and branches, discounts and price changes, purchasing, payments.
  analysis: ['category', 'branches', 'discounts', 'purchases', 'payments'],
} as const satisfies Record<string, readonly ReportTab[]>;

export interface ReportQuery {
  branch?: string;
  from?: string;
  to?: string;
}

const isDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Branch (?branch=, else the first) and local dates (?from=&to=), defaulting to today in Manila. */
export async function reportScope(q: ReportQuery) {
  const list = await apiOrNull<{ data: Branch[] }>('/branches');
  const branches = list?.data.filter((b) => !b.archivedAt) ?? [];
  const today = todayManila();
  return {
    branches,
    branch: branches.find((b) => b.id === q.branch) ?? branches[0],
    from: isDate(q.from) ? q.from! : today,
    to: isDate(q.to) ? q.to! : today,
  };
}

/** A report from the API, or the API's own message (bad range, no access) to show instead. */
export async function loadReport<T>(path: string): Promise<{ data: T; error?: undefined } | { data?: undefined; error: string }> {
  try {
    return { data: await api<T>(path) };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // Analysis reports on a plan without them (also caught up front in ReportsChrome when the plan is readable).
    if (e.code === 'ENTITLEMENT_REQUIRED') return { error: (await getT()).t('rep.notOnPlan') };
    // A refused range carries the specific rule in its issues ("from" after "to", over 366 days).
    const issues = (e.details?.issues as { message: string }[] | undefined)?.map((i) => i.message).join(' ');
    return { error: issues || e.message };
  }
}

/**
 * Header, report groups and tabs, branch picker, the date form with quick ranges, and the CSV download.
 * `extra`: the report's own choices (e.g. the attribute of "Sales by size and colour"), kept in the
 * URL across the date form, quick ranges, branch picker and CSV.
 */
export async function ReportsChrome({ tab, scope, error: reportError, extra = {}, children }: {
  tab: ReportTab;
  scope: Awaited<ReturnType<typeof reportScope>>;
  error?: string;
  extra?: Record<string, string>;
  children: ReactNode;
}) {
  const { t, lang } = await getT();
  const { branches, branch, from, to } = scope;
  const group = (Object.keys(GROUPS) as (keyof typeof GROUPS)[]).find((g) => (GROUPS[g] as readonly ReportTab[]).includes(tab))!;
  const tenant = (await api<Me>('/me')).activeTenant;
  // Analysis is the plan's `advanced_reports` (Growth and Enterprise): the group stays visible, with the
  // reason. From /me, so everyone sees it (not only those who may read the subscription).
  const notOnPlan = group === 'analysis' && tenant?.features !== undefined && !tenant.features.includes('advanced_reports');
  const error = notOnPlan ? t('rep.notOnPlan') : reportError;
  const params = (k: ReportTab, extra: Record<string, string> = {}) =>
    new URLSearchParams({ ...(branch && { branch: branch.id }), from, to, ...extra });
  const keep = (k: ReportTab) => `${PATHS[k]}?${params(k)}`;
  const today = todayManila();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('rep.title')} lede={t(group === 'sales' ? 'rep.salesLede' : 'rep.analysisLede')} />
      {/* On paper (or a saved PDF): which report, branch and range, and when it was printed. */}
      {branch && (
        <p className="hidden text-[0.9375rem] print:block" data-testid="print-heading">
          <b>{t(`rep.tab.${tab}` as MessageKey)}</b> · {CONSOLIDATED.includes(tab) ? t('rep.allBranches') : branch.name}
          {!UNDATED.includes(tab) && <> · {from === to ? from : `${from} – ${to}`}</>} · {t('rep.printedAt', { at: formatDateTime(new Date().toISOString(), lang) })}
        </p>
      )}
      <div className="contents print:hidden">
      <SubNav label={t('rep.groups')} active={group} items={(Object.keys(GROUPS) as (keyof typeof GROUPS)[]).map((g) => ({ key: g, href: keep(GROUPS[g][0]), label: t(`rep.group.${g}` as MessageKey) }))} />
      <SubNav level={2} label={t('common.sections')} active={tab} items={GROUPS[group].map((k) => ({ key: k, href: keep(k), label: t(`rep.tab.${k}` as MessageKey) }))} />
      {!CONSOLIDATED.includes(tab) && <ScopePicker label={t('common.branch')} items={branches} selected={branch?.id} href={(id) => `${PATHS[tab]}?${new URLSearchParams({ branch: id, from, to, ...extra })}`} />}
      {branch && (
        <div className="flex flex-col gap-2">
          {/* A plain GET form: the range lives in the URL, so a report can be bookmarked or shared. */}
          <form method="get" action={PATHS[tab]} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="branch" value={branch.id} />
            {Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            {UNDATED.includes(tab) ? null : (
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
            {!UNDATED.includes(tab) && <button className="btn">{t('common.show')}</button>}
            {!error && tab !== 'z' && (
              <a href={`/reports/export?${params(tab, { ...extra, report: tab })}`} className="btn" download>
                <Download aria-hidden className="size-4" /> {t('rep.csv')}
              </a>
            )}
            {!error && <PrintButton />}
          </form>
          {!UNDATED.includes(tab) && (
            <nav aria-label={t('rep.presets')} className="flex flex-wrap gap-1.5">
              {datePresets(today).map((p) => {
                const on = p.from === from && p.to === to;
                return (
                  <Link
                    key={p.key}
                    href={`${PATHS[tab]}?${new URLSearchParams({ branch: branch.id, from: p.from, to: p.to, ...extra })}`}
                    aria-current={on ? 'true' : undefined}
                    className={`tag h-8! px-3! text-[0.8125rem]! ${on ? 'border-blue! text-ink!' : 'hover:text-ink'}`}
                  >
                    {t(`rep.preset.${p.key}` as MessageKey)}
                  </Link>
                );
              })}
            </nav>
          )}
        </div>
      )}
      </div>
      {!branch ? <Note><Empty action={<ToLocations label={t('loc.goTo')} />}>{t('inv.noBranch')}</Empty></Note> : error ? <Callout tone={notOnPlan || error === t('rep.notOnPlan') ? 'warn' : 'error'}>{error}</Callout> : children}
    </div>
  );
}
