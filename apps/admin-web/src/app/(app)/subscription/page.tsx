import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Callout, Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type Bill, type Extension, type Me, type PlanOffer, type Subscription } from '@/lib/api';
import { formatDateTime, peso } from '@/lib/format';
import { planFacts } from '@/lib/subscription';
import { getT } from '@/i18n/server';
import { en, type MessageKey } from '@/i18n/messages';
import { SubscriptionTabs } from './tabs';
import { CancelToggle, ChoosePlanButton, PayBillButton } from './billing-actions';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('subscription');

const LIMITS: { key: string; label: MessageKey; fill: string }[] = [
  { key: 'maxLegalEntities', label: 'sub.maxLegalEntities', fill: 'border-violet bg-violet' },
  { key: 'maxBranches', label: 'sub.maxBranches', fill: 'border-violet bg-violet' },
  { key: 'maxRegisters', label: 'sub.maxRegisters', fill: 'border-orange-soft bg-orange-soft' },
  { key: 'maxUsers', label: 'sub.maxUsers', fill: 'border-green bg-green' },
];

/** As `PLAN_FEATURES` in @1pos/database, in the order an owner meets them. */
const FEATURES = ['multi_entity', 'advanced_reports', 'api_access'] as const;

export default async function SubscriptionPage({ searchParams }: { searchParams: Promise<{ paid?: string }> }) {
  const { paid } = await searchParams;
  const { t, lang } = await getT();
  // A member who may manage integrations but not the plan comes here from the band: their tab is Integrations.
  const permissions = (await apiOrNull<Me>('/me'))?.activeTenant?.permissions;
  if (permissions && !permissions.some((p) => p === 'subscription.manage' || p === 'tenant.manage') && permissions.includes('integrations.manage')) {
    redirect('/subscription/integrations');
  }
  const sub = await apiOrNull<Subscription>('/subscription');
  if (!sub) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('sub.title')} />
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      </div>
    );
  }
  // Names as the Extensions tab shows them; that list needs tenant.manage, so a code stands in without it.
  // An API from before ADR-0026 sends no `extensions`.
  const planExtensions = sub.plan.extensions ?? [];
  const catalog = planExtensions.length ? await apiOrNull<Extension[]>('/extensions') : null;
  const extensionName = (code: string) => {
    const key = `ext.${code}.name`;
    return key in en ? t(key as MessageKey) : (catalog?.find((e) => e.code === code)?.name ?? code);
  };
  const statusKey = `status.${sub.status}` as MessageKey;
  // Bills and plan choices (ADR-0027): reading them needs what /subscription needs; paying needs subscription.manage.
  const [offers, billList] = await Promise.all([apiOrNull<PlanOffer[]>('/subscription/plans'), apiOrNull<{ data: Bill[] }>('/subscription/bills')]);
  const bills = billList?.data ?? [];
  const canManage = permissions?.includes('subscription.manage') ?? false;
  const paidBill = paid ? bills.find((b) => b.number === paid) : undefined;
  const day = (iso: string | null) => formatDateTime(iso, lang);
  const limitName = (key: string) => t(LIMITS.find((l) => l.key === key)?.label ?? 'sub.limits');
  const billWhat = (b: Bill) => t(`sub.billKind.${b.kind}` as MessageKey, { plan: b.planName, from: day(b.periodStart), to: day(b.periodEnd) });
  const billStatus = (b: Bill) => (b.status === 'PAID' ? t('sub.billStatus.PAID', { date: day(b.paidAt) }) : t(`sub.billStatus.${b.status}` as MessageKey));
  const receiptLink = (b: Bill) =>
    b.receipt ? (
      <Link href={`/subscription/receipts/${b.receipt.id}`} className="font-semibold underline" data-receipt={b.receipt.number}>
        {t('sub.receipt', { number: b.receipt.number })}
      </Link>
    ) : null;
  const unapplied = (b: Bill) => b.payments.filter((p) => !p.applied).map((p) => p.amount);

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageHeader title={t('sub.title')} />
      <SubscriptionTabs active="plan" />
      {paid && (
        <Callout tone="info">{paidBill?.status === 'PAID' ? t('sub.paidDone', { number: paid }) : t('sub.paidReturn', { number: paid })}</Callout>
      )}

      <Note denom="blue" className="px-6 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-[1.75rem] font-bold">{sub.status === 'TRIALING' ? t('sub.trial', { plan: sub.plan.name }) : sub.plan.name}</span>
          <span className={`tag ${sub.access === 'FULL' ? 'text-ink!' : 'text-red!'}`}>{sub.access === 'FULL' ? t('sub.full') : t('common.readOnly')}</span>
        </div>
        <Serial className="mt-1 block">
          {/* The read-only notice itself is the layout's, above every page. */}
          {/* A trial's name already says trial: its line is the days left or the day it ended. */}
          {[
            ...(sub.status === 'TRIALING' ? [] : [t(statusKey)]),
            ...planFacts(sub).map((f) => t(f.key, { ...(f.n !== undefined && { n: f.n }), ...(f.date && { date: formatDateTime(f.date, lang) }) })),
            ...(sub.plan.monthlyPrice && sub.status !== 'TRIALING' ? [t('sub.perMonth', { amount: peso(sub.plan.monthlyPrice) })] : []),
            ...(sub.scheduledPlan && sub.currentPeriodEnd ? [t('sub.scheduled', { plan: sub.scheduledPlan.name, date: day(sub.currentPeriodEnd) })] : []),
            ...(sub.cancelAtPeriodEnd && sub.currentPeriodEnd ? [t('sub.cancelAt', { date: day(sub.currentPeriodEnd) })] : []),
          ].join(' · ')}
        </Serial>
      </Note>

      {bills.length > 0 || canManage ? (
        <section>
          <h2 className="section-title mb-3">{t('sub.bills')}</h2>
          <Note as="div">
            {bills.length === 0 ? (
              <Empty>{t('sub.noBills')}</Empty>
            ) : (
              <RecordTable
                rows={bills}
                rowKey={(b) => b.id}
                dimmed={(b) => b.status === 'VOID'}
                columns={[
                  { header: t('sub.bill.number'), cell: (b) => <span className="serial">{b.number}</span> },
                  { header: t('sub.bill.what'), cell: (b) => billWhat(b) },
                  { header: t('sub.bill.due'), cell: (b) => day(b.dueAt) },
                  {
                    header: t('sub.bill.status'),
                    cell: (b) => (
                      <span className="flex flex-col gap-1">
                        <span>{billStatus(b)}</span>
                        {receiptLink(b)}
                        {unapplied(b).map((a, i) => <span key={i} className="text-[0.8125rem] text-red">{t('sub.unapplied', { amount: peso(a) })}</span>)}
                      </span>
                    ),
                  },
                  {
                    header: t('sub.bill.amount'),
                    num: true,
                    cell: (b) => (
                      <span className="flex flex-col items-end">
                        <span>{peso(b.amount)}</span>
                        <span className="text-[0.75rem] text-muted">{t('sub.vatIncluded', { amount: peso(b.vatAmount) })}</span>
                      </span>
                    ),
                  },
                  { header: '', cell: (b) => (b.status === 'OPEN' && canManage ? <PayBillButton billId={b.id} /> : null) },
                ]}
                stacked={{
                  title: (b) => <><span className="serial">{b.number}</span> · {billStatus(b)}</>,
                  meta: (b) => (
                    <span className="flex flex-col items-start gap-2">
                      <span>{billWhat(b)} · {t('sub.bill.due')} {day(b.dueAt)} · {t('sub.vatIncluded', { amount: peso(b.vatAmount) })}</span>
                      {unapplied(b).map((a, i) => <span key={i} className="text-red">{t('sub.unapplied', { amount: peso(a) })}</span>)}
                      {receiptLink(b)}
                      {b.status === 'OPEN' && canManage && <PayBillButton billId={b.id} />}
                    </span>
                  ),
                  figure: (b) => peso(b.amount),
                }}
              />
            )}
          </Note>
          {canManage && <p className="mt-2 text-[0.875rem] text-muted">{t('sub.payHelp')}</p>}
        </section>
      ) : null}

      {offers && offers.length > 0 && (
        <section>
          <h2 className="section-title mb-3">{t('sub.choosePlan')}</h2>
          <ul className="grid gap-3 md:grid-cols-3" data-testid="plan-offers">
            {offers.map((o) => (
              <li key={o.code}>
                <Note className="flex h-full flex-col gap-3 px-5 py-4" as="div">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[1.125rem] font-bold">{o.name}</span>
                    {o.current && <span className="tag">{t('sub.currentPlan')}</span>}
                  </div>
                  <span className="serial">{o.priced ? t('sub.perMonth', { amount: peso(o.monthlyPrice) }) : t('sub.notPriced')}</span>
                  <ul className="flex flex-col gap-1 text-[0.875rem] text-muted">
                    {LIMITS.map(({ key, label }) => <li key={key}>{t(label)}: {o.limits[key] ?? 0}</li>)}
                  </ul>
                  {o.overLimits.length > 0 && <span className="text-[0.8125rem] text-red">{t('sub.overLimits', { what: o.overLimits.map(limitName).join(', ') })}</span>}
                  {canManage && (
                    <div className="mt-auto">
                      <ChoosePlanButton planCode={o.code} planName={o.name} disabled={!o.priced || o.overLimits.length > 0} />
                    </div>
                  )}
                </Note>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[0.875rem] text-muted">{t('sub.upgradeNote')}</p>
        </section>
      )}

      {canManage && sub.status === 'ACTIVE' && sub.currentPeriodEnd && (
        <section className="flex flex-col items-start gap-2">
          <CancelToggle canceling={sub.cancelAtPeriodEnd ?? false} />
          {!sub.cancelAtPeriodEnd && <p className="text-[0.875rem] text-muted">{t('sub.stopHelp', { date: day(sub.currentPeriodEnd) })}</p>}
        </section>
      )}
      <section>
        <h2 className="section-title mb-3">{t('sub.limits')}</h2>
        <Note className="px-6 py-5">
          <ul className="flex flex-col gap-5">
            {LIMITS.map(({ key, label, fill }) => {
              const max = sub.plan.limits[key] ?? 0;
              const used = sub.usage[key] ?? 0;
              const full = used >= max;
              // Quantity drawn as exact geometry: one cell per allowed unit (capped for readability).
              const cells = Math.min(max, 40);
              const filled = Math.min(cells, Math.round((used / Math.max(max, 1)) * cells));
              return (
                <li key={key}>
                  <div className="mb-1.5 flex justify-between gap-3 text-[0.9375rem]">
                    <span>{t(label)}</span>
                    <span className={`serial tabular-nums ${full ? 'font-semibold text-red' : 'text-ink'}`}>{used} / {max}</span>
                  </div>
                  <div className="flex gap-[3px]" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={used} aria-label={t(label)}>
                    {Array.from({ length: cells }, (_, i) => (
                      <span key={i} className={`h-2.5 flex-1 rounded-[2px] border ${i < filled ? (full ? 'border-red bg-red' : fill) : 'border-hair bg-white'}`} />
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </Note>
      </section>

      <section>
        <h2 className="section-title mb-3">{t('sub.included')}</h2>
        <Note className="px-6 py-5" as="div">
          <ul className="flex flex-col gap-2" data-testid="plan-features">
            {FEATURES.map((f) => {
              const on = sub.plan.features.includes(f);
              return (
                <li key={f} data-feature={f} className="flex items-baseline justify-between gap-3 text-[0.9375rem]">
                  <span className="min-w-0">{t(`sub.feature.${f}`)}</span>
                  <span className={`serial shrink-0 whitespace-nowrap ${on ? 'font-semibold text-green' : 'text-muted'}`}>{on ? t('sub.yes') : t('sub.no')}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-4 border-t border-dashed border-hair pt-3 text-[0.875rem] text-muted">
            {planExtensions.length ? t('sub.extensions', { names: planExtensions.map(extensionName).join(', ') }) : t('sub.noExtensions')}
          </p>
        </Note>
      </section>

    </div>
  );
}
