import { Check, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Callout, Empty, Note, PageHeader, Serial } from '@/components/note';
import {
  allProducts,
  apiOrNull,
  type Branch,
  type CurrentPrice,
  type Invitation,
  type LegalEntity,
  type Member,
  type PriceList,
  type Register,
  type Subscription,
  type Terminal,
} from '@/lib/api';
import { daysUntil, formatDateTime, peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import type { MessageKey } from '@/i18n/messages';

export const metadata = { title: 'Overview' };

type List<T> = { data: T[] };

export default async function OverviewPage() {
  const { t, lang } = await getT();
  const [entities, branches, registers, terminals, products, lists, members, invites, sub] = await Promise.all([
    apiOrNull<List<LegalEntity>>('/legal-entities'),
    apiOrNull<List<Branch>>('/branches'),
    apiOrNull<List<Register>>('/registers'),
    apiOrNull<List<Terminal>>('/terminals'),
    allProducts(),
    apiOrNull<List<PriceList>>('/price-lists'),
    apiOrNull<List<Member>>('/members'),
    apiOrNull<List<Invitation>>('/invitations'),
    apiOrNull<Subscription>('/subscription'),
  ]);

  const defaultList = lists?.data.find((l) => l.isDefault && !l.archivedAt);
  const prices = defaultList ? await apiOrNull<{ data: CurrentPrice[] }>(`/price-lists/${defaultList.id}/prices`) : null;

  const active = <T extends { archivedAt: string | null }>(x: List<T> | null) => x?.data.filter((r) => !r.archivedAt) ?? [];
  const activeProducts = products?.data.filter((p) => !p.archivedAt) ?? [];
  const pricedVariantIds = new Set(prices?.data.map((p) => p.variantId));
  const unpriced = activeProducts.flatMap((p) => p.variants.filter((v) => !v.archivedAt)).filter((v) => !pricedVariantIds.has(v.id)).length;
  const pairedTerminals = terminals?.data.filter((x) => x.status === 'ACTIVE').length ?? 0;
  const pendingInvites = invites?.data.filter((i) => i.status === 'PENDING').length ?? 0;
  const activeMembers = members?.data.filter((m) => m.status === 'ACTIVE').length ?? 0;

  const steps: { key: MessageKey; action: MessageKey; done: boolean; href: string }[] = [
    { key: 'overview.setup.entity', action: 'overview.do.entity', done: active(entities).length > 0, href: '/locations' },
    { key: 'overview.setup.branch', action: 'overview.do.branch', done: active(branches).length > 0, href: '/locations' },
    { key: 'overview.setup.register', action: 'overview.do.register', done: active(registers).length > 0 && pairedTerminals > 0, href: '/locations' },
    { key: 'overview.setup.products', action: 'overview.do.products', done: activeProducts.length > 0 && unpriced === 0, href: '/prices' },
    { key: 'overview.setup.team', action: 'overview.do.team', done: activeMembers + pendingInvites > 1, href: '/team' },
  ];
  const next = steps.find((s) => !s.done);

  const kpis = [
    { denom: 'blue' as const, label: t('overview.products'), value: products ? activeProducts.length : null, serial: t('overview.unpriced', { n: unpriced }), href: '/products' },
    { denom: 'violet' as const, label: t('overview.branches'), value: branches ? active(branches).length : null, serial: active(branches).map((b) => b.code).slice(0, 3).join(' · ') || '—', href: '/locations' },
    { denom: 'orange' as const, label: t('overview.registers'), value: registers ? active(registers).length : null, serial: t('overview.terminals', { n: pairedTerminals }), href: '/locations' },
    { denom: 'green' as const, label: t('overview.team'), value: members ? activeMembers : null, serial: t('overview.pending', { n: pendingInvites }), href: '/team' },
  ];

  const branchName = active(branches)[0]?.name;
  const trialDays = sub?.status === 'TRIALING' ? daysUntil(sub.trialEndsAt) : null;
  const statusKey = `status.${sub?.status}` as MessageKey;
  const shown = prices?.data.slice(0, 8) ?? [];
  const anyScheduled = shown.some((p) => p.scheduled);
  const itemName = (p: CurrentPrice) => (p.variantName ? `${p.productName} — ${p.variantName}` : p.productName);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('overview.title')} lede={[branchName, 'Asia/Manila'].filter(Boolean).join(' · ')} />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        {/* Below xl the next action comes first; on wide screens it sits in the right column. */}
        <aside className="flex flex-col gap-4 xl:order-last">
          {sub && (
            <Note className="px-5 py-4">
              <span className="block text-[1.375rem] font-semibold">
                {sub.status === 'TRIALING' ? t('sub.trial', { plan: sub.plan.name }) : sub.plan.name}
              </span>
              <Serial className="mt-1 block">
                {[trialDays !== null ? t('sub.daysLeft', { n: trialDays }) : t(statusKey), sub.access === 'FULL' ? t('sub.full') : t('common.readOnly')].join(' · ')}
              </Serial>
            </Note>
          )}
          <Note className="px-5 py-4">
            <h2 className="text-[1.0625rem] font-semibold">{t('overview.setup')}</h2>
            <ol className="mt-2">
              {steps.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-3 border-b border-dashed border-hair py-2.5 last:border-0">
                  <Link href={s.href} className="hover:underline">{t(s.key)}</Link>
                  {s.done ? (
                    <Check aria-label={t('common.done')} className="size-4.5 text-blue" />
                  ) : s === next ? (
                    <span className="serial text-[0.75rem] font-semibold text-blue">{t('overview.next')}</span>
                  ) : (
                    <span aria-hidden className="h-px w-3 bg-hair" />
                  )}
                </li>
              ))}
            </ol>
            {next && (
              <Link href={next.href} className="btn btn-primary mt-3 h-auto min-h-9 w-full py-2 text-center whitespace-normal">
                {t(next.action)} <ChevronRight aria-hidden className="size-4 shrink-0" />
              </Link>
            )}
          </Note>
          <Callout tone="info">{t('loc.invoicingOff')}</Callout>
        </aside>

        <section className="min-w-0">
          <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
            {kpis.map((k) => (
              <Link key={k.label} href={k.href} className="group">
                <Note denom={k.denom} className="h-full px-4 py-4 pr-6 transition-shadow group-hover:shadow-md" as="div">
                  <span className="text-[0.8125rem] text-muted">{k.label}</span>
                  <span className="mt-1 block text-[1.75rem] font-semibold leading-none tabular-nums">{k.value ?? '—'}</span>
                  <Serial className="mt-2 block leading-snug">{k.value === null ? t('common.noAccess') : k.serial}</Serial>
                </Note>
              </Link>
            ))}
          </div>

          <h2 className="section-title mt-8 mb-3">{t('overview.recentPrices')}{defaultList ? ` · ${defaultList.name}` : ''}</h2>
          <Note denom="blue" className="pr-2">
            {shown.length > 0 ? (
              <>
                {/* Phones: stacked rows so the price is always on screen. */}
                <ul className="md:hidden">
                  {shown.map((p) => (
                    <li key={p.priceId} className="flex items-start justify-between gap-3 border-b border-hair-soft px-4 py-3 last:border-0">
                      <span className="min-w-0">
                        <span className="block">{itemName(p)}</span>
                        <Serial className="block">{p.sku}</Serial>
                      </span>
                      <span className="money shrink-0 text-right font-semibold">
                        {peso(p.amount)}
                        {p.scheduled && <span className="block text-[0.8125rem] font-normal text-muted">{t('price.scheduled')}: {peso(p.scheduled.amount)}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="hidden overflow-x-auto md:block">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{t('prod.sku')}</th>
                        <th>{t('prod.name')}</th>
                        <th className="num">{t('price.current')}</th>
                        <th>{t('price.since')}</th>
                        {anyScheduled && <th className="num">{t('price.scheduled')}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((p) => (
                        <tr key={p.priceId}>
                          <td><Serial className="text-ink">{p.sku}</Serial></td>
                          <td>{itemName(p)}</td>
                          <td className="num money font-semibold">{peso(p.amount)}</td>
                          <td className="text-muted">{formatDateTime(p.effectiveFrom, lang)}</td>
                          {anyScheduled && (
                            <td className="num money text-muted">
                              {p.scheduled ? `${peso(p.scheduled.amount)} · ${formatDateTime(p.scheduled.effectiveFrom, lang)}` : '—'}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <Empty>{t('overview.noPrices')}</Empty>
            )}
          </Note>
        </section>
      </div>
    </div>
  );
}