import { Callout, Empty, Note, PageHeader, Serial } from '@/components/note';
import { apiOrNull, type Subscription } from '@/lib/api';
import { daysUntil, formatDateTime } from '@/lib/format';
import { getT } from '@/i18n/server';
import type { MessageKey } from '@/i18n/messages';

export const metadata = { title: 'Subscription' };

const LIMITS: { key: string; label: MessageKey; fill: string }[] = [
  { key: 'maxLegalEntities', label: 'sub.maxLegalEntities', fill: 'border-violet bg-violet' },
  { key: 'maxBranches', label: 'sub.maxBranches', fill: 'border-violet bg-violet' },
  { key: 'maxRegisters', label: 'sub.maxRegisters', fill: 'border-orange-soft bg-orange-soft' },
  { key: 'maxUsers', label: 'sub.maxUsers', fill: 'border-green bg-green' },
];

export default async function SubscriptionPage() {
  const { t, lang } = await getT();
  const sub = await apiOrNull<Subscription>('/subscription');
  if (!sub) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('sub.title')} />
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      </div>
    );
  }
  const trialDays = sub.status === 'TRIALING' ? daysUntil(sub.trialEndsAt) : null;
  const statusKey = `status.${sub.status}` as MessageKey;

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageHeader title={t('sub.title')} />
      {sub.access === 'READ_ONLY' && <Callout tone="warn">{t('sub.readOnly')}</Callout>}

      <Note denom="blue" className="px-6 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-[1.75rem] font-bold">{sub.status === 'TRIALING' ? t('sub.trial', { plan: sub.plan.name }) : sub.plan.name}</span>
          <span className={`tag ${sub.access === 'FULL' ? 'text-ink!' : 'text-red!'}`}>{sub.access === 'FULL' ? t('sub.full') : t('common.readOnly')}</span>
        </div>
        <Serial className="mt-1 block">
          {t(statusKey)}
          {trialDays !== null && ` · ${t('sub.daysLeft', { n: trialDays })} · ${formatDateTime(sub.trialEndsAt, lang)}`}
          {sub.graceEndsAt && ` · ${t('sub.graceUntil', { date: formatDateTime(sub.graceEndsAt, lang) })}`}
        </Serial>
      </Note>

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

      <Callout tone="info">{t('sub.billingPlanned')}</Callout>
    </div>
  );
}
