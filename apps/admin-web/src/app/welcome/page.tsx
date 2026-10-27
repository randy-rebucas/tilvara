import {
  ArrowRight,
  BookCheck,
  BookOpen,
  Building2,
  Check,
  Coins,
  Download,
  IdCard,
  Languages,
  Package,
  PackageMinus,
  PackageOpen,
  Plus,
  Receipt,
  RefreshCw,
  ScanBarcode,
  ShieldCheck,
  Tags,
  Truck,
  UsersRound,
  Wallet,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { LangSwitch } from '@/components/lang-switch';
import { Callout, Note, Serial, type Denomination } from '@/components/note';
import { pageTitle } from '@/i18n/page-title';
import { getT } from '@/i18n/server';
import type { MessageKey } from '@/i18n/messages';
import { CounterScene, Guilloche } from './illustration';
import { OfflineDemo } from './offline-demo';

export const generateMetadata = pageTitle('welcome', {
  description: 'Tilvara is a point of sale and back office for Philippine retail shops: a till that keeps selling offline, stock you can explain, and books that add up.',
  robots: { index: true, follow: true },
});

/**
 * The public landing page (served at `/` to signed-out visitors, see proxy.ts). Every figure on it is a
 * labelled sample: Tilvara has no customers, testimonials or prices to show yet (PRODUCT.md), and it
 * never claims BIR accreditation.
 */

/** Text colour of each record kind (the soft stripe colours are too light for text and icons). */
const KIND: Record<Denomination, string> = {
  blue: 'var(--color-blue)',
  violet: 'var(--color-violet)',
  orange: 'var(--color-orange)',
  green: 'var(--color-green)',
  gold: 'var(--color-gold)',
  ink: 'var(--color-ink)',
  none: 'var(--color-muted)',
};

const FEATURES: [Denomination, string, LucideIcon][] = [
  ['blue', 'c', Tags],
  ['orange', 'r', ScanBarcode],
  ['gold', 'g', PackageOpen],
  ['violet', 'l', Building2],
  ['green', 't', UsersRound],
  ['ink', 'b', BookOpen],
];

const FLOW: [Denomination, LucideIcon][] = [
  ['gold', Truck],
  ['gold', Package],
  ['orange', ScanBarcode],
  ['orange', Wallet],
  ['ink', BookCheck],
];

const KEYS: LucideIcon[] = [WifiOff, Languages, ShieldCheck, Receipt, Download];
const PH: LucideIcon[] = [Receipt, IdCard, Coins, Languages];
const NAV = ['features', 'offline', 'books', 'start', 'faq'] as const;

function k(key: string) {
  return key as MessageKey;
}

/** Inline custom properties: `--k` a kind's colour, `--i` a stagger index, `--d` a delay. */
function vars(v: Record<string, string | number>) {
  return v as CSSProperties;
}

function Icon({ icon: I, denom, className = '' }: { icon: LucideIcon; denom: Denomination; className?: string }) {
  return (
    <span className={`land-icon ${className}`} style={vars({ '--k': KIND[denom] })}>
      <I aria-hidden className="size-[55%]" strokeWidth={1.9} />
    </span>
  );
}

function Section({ id, title, lede, className = '', children }: { id: string; title: string; lede?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={`scroll-mt-16 border-t border-hair py-14 md:py-20 ${className}`}>
      <div className="mx-auto max-w-[1200px] px-4 sm:px-7">
        <div className="land-reveal mb-10 max-w-[64ch]">
          <h2 className="text-[1.75rem] font-bold leading-tight tracking-[-0.015em] md:text-[2.375rem]">{title}</h2>
          {lede && <p className="mt-3 text-[1.0625rem] text-muted md:text-[1.125rem]">{lede}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

function Checks({ items }: { items: [string, string][] }) {
  return (
    <ul className="mt-6 grid gap-4">
      {items.map(([lead, rest], n) => (
        <li key={lead} className="land-reveal grid grid-cols-[28px_1fr] gap-3" style={vars({ '--i': n })}>
          <span className="mt-0.5 grid size-6 place-items-center rounded-full bg-blue text-white">
            <Check aria-hidden className="size-3.5" strokeWidth={3} />
          </span>
          <span>
            <strong className="font-semibold">{lead}</strong> <span className="text-muted">{rest}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function SampleMark({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-right text-[0.75rem] text-muted">{children}</p>;
}

const th = 'bg-table-head px-2 py-1.5 text-left text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-muted';
const td = 'border-b border-hair-soft px-2 py-2.5 align-top';

export default async function WelcomePage() {
  const { t } = await getT();

  return (
    <div className="land min-h-dvh overflow-x-clip bg-paper">
      <a href="#top" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-[5px] focus:bg-note focus:px-3 focus:py-2">
        {t('land.skip')}
      </a>
      <header className="band sticky top-0 z-30 h-16 text-white shadow-[0_6px_18px_-12px_rgb(29_31_36/0.5)]">
        <div className="mx-auto flex h-full max-w-[1200px] items-center gap-4 px-4 sm:px-7 lg:gap-6">
          <Link href="/" className="mr-auto text-[1.5rem] font-bold tracking-[0.04em] lg:mr-0">
            {t('app.name')}
          </Link>
          <nav aria-label={t('land.navLabel')} className="mr-auto hidden gap-0.5 lg:flex">
            {NAV.map((n) => (
              <a key={n} href={`#${n}`} className="rounded-[4px] px-3 py-1.5 text-[0.875rem] text-blue-ink transition-colors duration-[120ms] hover:bg-white/10 hover:text-white">
                {t(k(`land.nav.${n}`))}
              </a>
            ))}
          </nav>
          <LangSwitch onBand />
          <Link href="/sign-in" className="whitespace-nowrap text-[0.875rem] font-semibold hover:underline hover:underline-offset-4">
            {t('land.signIn')}
          </Link>
          <Link href="/sign-up" className="btn hidden border-white text-blue-deep hover:bg-blue-ink sm:inline-flex">
            {t('land.trial')}
          </Link>
        </div>
      </header>

      <main>
        {/* Hero */}
        <div id="top" className="land-security relative py-14 md:py-24">
          <Guilloche className="absolute -left-[220px] -top-[180px] size-[640px]" opacity={0.12} />
          <Guilloche className="absolute -bottom-[260px] right-[-140px] hidden size-[560px] lg:block" color="#85600c" opacity={0.1} />
          <div className="relative mx-auto grid max-w-[1200px] items-center gap-14 px-4 sm:px-7 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
            <div className="reveal">
              <h1 className="max-w-[16ch] text-[2.5rem] font-bold leading-[1.02] tracking-[-0.025em] sm:text-[3rem] md:text-[3.75rem]">{t('land.hero.title')}</h1>
              <svg aria-hidden viewBox="0 0 220 14" className="land-swash mt-3 h-3.5 w-[220px] text-blue" fill="none">
                <path d="M2 9 C 40 2, 70 13, 110 7 S 180 3, 218 8" pathLength={1} stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              <p className="mt-5 max-w-[54ch] text-[1.125rem] leading-relaxed text-muted md:text-[1.1875rem]">{t('land.hero.lede')}</p>
              <div className="mt-8 flex flex-wrap gap-3 [&>*]:max-sm:flex-[1_1_100%]">
                <Link href="/sign-up" className="btn btn-primary h-12 px-6 text-[1rem]">
                  {t('land.trial')}
                  <ArrowRight aria-hidden className="land-arrow size-4" />
                </Link>
                <a href="#features" className="btn h-12 px-6 text-[1rem]">
                  {t('land.see')}
                </a>
              </div>
              <p className="mt-4 flex items-center gap-2 text-[0.875rem] text-muted">
                <ShieldCheck aria-hidden className="size-4 text-blue" />
                {t('land.hero.note')}
              </p>
            </div>

            <div className="relative mx-auto w-full max-w-[520px]">
              <span className="land-chip absolute -left-12 -top-5 z-10 hidden lg:inline-flex" style={vars({ '--d': '700ms' })}>
                <Icon icon={RefreshCw} denom="blue" />
                {t('land.chip.sync')}
              </span>
              <span className="land-chip absolute -right-10 top-[79%] z-10 hidden lg:inline-flex" style={vars({ '--d': '1000ms' })}>
                <Icon icon={PackageMinus} denom="gold" />
                {t('land.chip.stock')}
              </span>
              <span className="land-chip absolute -bottom-5 -left-8 z-10 hidden lg:inline-flex" style={vars({ '--d': '1300ms' })}>
                <Icon icon={BookCheck} denom="ink" />
                {t('land.chip.books')}
              </span>
              <div aria-hidden className="absolute inset-x-6 -bottom-3 top-6 rotate-[2.5deg] rounded-[6px] border border-hair bg-note/70" />
              <Note as="article" denom="blue" className="reveal px-6 py-6 pr-9 shadow-[0_24px_48px_-24px_rgb(60_50_20/0.35)]">
                <div aria-label={t('land.r.label')} role="group">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-[1.0625rem] font-semibold">{t('land.r.title')}</h2>
                    <span className="inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-[3px] border border-hair px-2 text-[0.75rem] font-semibold text-muted">
                      <RefreshCw aria-hidden className="size-3 text-blue" />
                      {t('land.r.offline')}
                    </span>
                  </div>
                  <Serial>S-MKT01-R1-000248 · REG 1 · 10:42</Serial>
                  <table className="mb-1.5 mt-3.5 w-full border-collapse text-[0.875rem]">
                    <thead>
                      <tr>
                        <th className={th}>{t('land.r.item')}</th>
                        <th className={th}>{t('land.r.qty')}</th>
                        <th className={`${th} text-right`}>{t('land.r.amount')}</th>
                      </tr>
                    </thead>
                    <tbody className="[&>tr:last-child>td]:border-0">
                      {(
                        [
                          ['1', '12', '₱102.00'],
                          ['2', '3', '₱67.50'],
                          ['3', '1', '₱96.00'],
                        ] as const
                      ).map(([n, qty, amount]) => (
                        <tr key={n} className="land-print" style={vars({ '--i': Number(n) - 1 })}>
                          <td className={td}>
                            {t(k(`land.r.l${n}`))}
                            <span className="serial block text-[0.6875rem] text-blue">{t(k(`land.r.l${n}s`))}</span>
                          </td>
                          <td className={`${td} serial`}>{qty}</td>
                          <td className={`${td} money text-right font-semibold`}>{amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="land-print grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-dashed border-hair pt-2.5 text-[0.875rem]" style={vars({ '--i': 3 })}>
                    <span>{t('land.r.vatable')}</span>
                    <span className="money text-right font-semibold">₱237.05</span>
                    <span>{t('land.r.vat')}</span>
                    <span className="money text-right font-semibold">₱28.45</span>
                    <span className="text-base font-bold">{t('land.r.total')}</span>
                    <span className="money text-right text-[1.25rem] font-bold text-blue">₱265.50</span>
                  </div>
                  <ul className="mt-4 grid gap-1.5 text-[0.8125rem] text-muted">
                    {(
                      [
                        ['var(--color-gold-soft)', 'land.r.t1'],
                        ['var(--color-ink)', 'land.r.t2'],
                        ['var(--color-orange-soft)', 'land.r.t3'],
                      ] as const
                    ).map(([color, key], n) => (
                      <li key={key} className="land-print flex items-center gap-2" style={vars({ '--i': 4 + n })}>
                        <span aria-hidden className="h-3.5 w-1 flex-none rounded-[1px]" style={{ background: color }} />
                        {t(key)}
                      </li>
                    ))}
                  </ul>
                  <SampleMark>{t('land.sample')}</SampleMark>
                </div>
              </Note>
            </div>
          </div>
        </div>

        {/* At a glance */}
        <div className="border-t border-hair bg-note">
          <ul aria-label={t('land.k.label')} className="mx-auto grid max-w-[1200px] gap-x-6 gap-y-4 px-4 py-6 sm:grid-cols-2 sm:px-7 lg:grid-cols-5">
            {KEYS.map((I, n) => (
              <li key={n} className="land-reveal flex items-center gap-3 text-[0.9375rem] font-semibold" style={vars({ '--i': n })}>
                <I aria-hidden className="size-5 flex-none text-blue" strokeWidth={2} />
                {t(k(`land.k.${n + 1}`))}
              </li>
            ))}
          </ul>
        </div>

        <Section id="features" title={t('land.f.title')} lede={t('land.f.lede')}>
          <ol aria-label={t('land.flow.label')} className="land-flow mb-14">
            {FLOW.map(([denom, I], n) => (
              <li key={n} className="land-reveal" style={vars({ '--i': n })}>
                <Icon icon={I} denom={denom} className="size-12 bg-white" />
                <span className="min-w-0">
                  <span className="block font-semibold">{t(k(`land.flow.${n + 1}`))}</span>
                  <span className="block text-[0.8125rem] text-muted">{t(k(`land.flow.${n + 1}s`))}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(([denom, f, I], n) => (
              <div key={f} className="land-reveal" style={vars({ '--i': n % 3 })}>
                <Note as="article" denom={denom} className="land-card h-full px-6 py-6 pr-9">
                  <Icon icon={I} denom={denom} />
                  <h3 className="mt-4 text-[1.125rem] font-semibold">{t(k(`land.f.${f}.t`))}</h3>
                  <Serial className="mb-3 block">
                    <span style={{ color: KIND[denom] }}>{t(k(`land.f.${f}.s`))}</span>
                  </Serial>
                  <p className="text-muted">{t(k(`land.f.${f}.p`))}</p>
                </Note>
              </div>
            ))}
          </div>
        </Section>

        <Section id="offline" title={t('land.o.title')} className="land-security bg-paper-deep/60">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <p className="land-reveal max-w-[56ch] text-[1.0625rem] text-muted md:text-[1.125rem]">{t('land.o.lede')}</p>
              <Checks
                items={[
                  [t('land.o.c1a'), t('land.o.c1b')],
                  [t('land.o.c2a'), t('land.o.c2b')],
                  [t('land.o.c3a'), t('land.o.c3b')],
                ]}
              />
            </div>
            <div className="land-reveal relative">
              <Guilloche className="absolute -right-24 -top-24 size-[300px]" color="#b85f12" opacity={0.16} />
              <Note as="article" denom="orange" className="px-6 py-6 pr-9 shadow-[0_24px_48px_-24px_rgb(60_50_20/0.35)]">
                <div role="group" aria-label={t('land.o.q.label')}>
                  <div className="flex items-start gap-3">
                    <Icon icon={ScanBarcode} denom="orange" />
                    <div>
                      <h3 className="text-[1.0625rem] font-semibold">{t('land.o.q.t')}</h3>
                      <Serial className="mb-3.5 block text-orange">{t('land.o.q.s')}</Serial>
                    </div>
                  </div>
                  <OfflineDemo />
                  <SampleMark>{t('land.sample')}</SampleMark>
                </div>
              </Note>
            </div>
          </div>
        </Section>

        <Section id="books" title={t('land.b.title')}>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="lg:order-2">
              <p className="land-reveal max-w-[56ch] text-[1.0625rem] text-muted md:text-[1.125rem]">{t('land.b.lede')}</p>
              <Checks
                items={[
                  [t('land.b.c1a'), t('land.b.c1b')],
                  [t('land.b.c2a'), t('land.b.c2b')],
                  [t('land.b.c3a'), t('land.b.c3b')],
                ]}
              />
            </div>
            <div className="land-reveal lg:order-1">
              <Note as="article" denom="gold" className="px-6 py-6 pr-9 shadow-[0_24px_48px_-24px_rgb(60_50_20/0.35)]">
                <div role="group" aria-label={t('land.b.label')}>
                  <div className="flex items-start gap-3">
                    <Icon icon={Package} denom="gold" />
                    <div>
                      <h3 className="text-[1.0625rem] font-semibold">{t('land.b.l.t')}</h3>
                      <Serial className="mb-3 block text-gold">{t('land.b.l.s')}</Serial>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[380px] border-collapse text-[0.875rem]">
                      <thead>
                        <tr>
                          <th className={th}>{t('land.b.l.doc')}</th>
                          <th className={th}>{t('land.b.l.what')}</th>
                          <th className={`${th} text-right`}>{t('land.b.l.qty')}</th>
                          <th className={`${th} text-right`}>{t('land.b.l.bal')}</th>
                        </tr>
                      </thead>
                      <tbody className="[&>tr:last-child>td]:border-0">
                        {(
                          [
                            ['GR-000031', 'land.b.l.r1', '+48', '48'],
                            ['S-000248', 'land.b.l.r2', '−3', '45'],
                            ['RT-000012', 'land.b.l.r3', '+1', '46'],
                            ['CNT-000004', 'land.b.l.r4', '−1', '45'],
                            ['ADJ-000009', 'land.b.l.r5', '−2', '43'],
                          ] as const
                        ).map(([doc, what, qty, bal], n) => (
                          <tr key={doc} className="land-reveal" style={vars({ '--i': n })}>
                            <td className={`${td} serial text-[0.75rem] text-gold`}>{doc}</td>
                            <td className={td}>{t(what)}</td>
                            <td className={`${td} money text-right font-semibold ${qty.startsWith('+') ? 'text-blue' : ''}`}>{qty}</td>
                            <td className={`${td} money text-right text-muted`}>{bal}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <SampleMark>{t('land.sample')}</SampleMark>
                </div>
              </Note>
            </div>
          </div>
        </Section>

        <Section id="ph" title={t('land.p.title')} lede={t('land.p.lede')} className="bg-note">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {PH.map((I, n) => (
              <div key={n} className="land-reveal land-card rounded-[6px] border border-hair bg-paper/60 p-5" style={vars({ '--i': n })}>
                <Icon icon={I} denom="blue" />
                <h3 className="mb-1.5 mt-4 font-semibold">{t(k(`land.p.${n + 1}.t`))}</h3>
                <p className="text-[0.9375rem] text-muted">{t(k(`land.p.${n + 1}.p`))}</p>
              </div>
            ))}
          </div>
          <div className="land-reveal mt-8">
            <Callout>{t('land.p.notice')}</Callout>
          </div>
        </Section>

        <Section id="start" title={t('land.s.title')} lede={t('land.s.lede')}>
          <div className="grid items-center gap-12 lg:grid-cols-[0.85fr_1.15fr]">
            <ol className="land-steps grid gap-6">
              {(['violet', 'blue', 'orange'] as const).map((denom, n) => (
                <li key={denom} className="land-reveal" style={vars({ '--i': n })}>
                  <span className="land-step-no" style={vars({ '--k': KIND[denom] })} aria-hidden>
                    {n + 1}
                  </span>
                  <Serial className="block">
                    <span style={{ color: KIND[denom] }}>{t('land.s.step', { n: n + 1 })}</span>
                  </Serial>
                  <h3 className="text-[1.125rem] font-semibold">{t(k(`land.s.${n + 1}.t`))}</h3>
                  <p className="mt-1.5 text-muted">{t(k(`land.s.${n + 1}.p`))}</p>
                </li>
              ))}
            </ol>
            <div className="land-reveal">
              <CounterScene label={t('land.ill')} />
            </div>
          </div>
        </Section>

        <Section id="faq" title={t('land.q.title')} className="bg-note">
          <div className="land-faq max-w-[860px]">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <details key={n} className="land-reveal group border-b border-hair" style={vars({ '--i': Math.min(n - 1, 3) })}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[1.0625rem] font-semibold transition-colors duration-[120ms] hover:text-blue [&::-webkit-details-marker]:hidden">
                  {t(k(`land.q.${n}.q`))}
                  <span aria-hidden className="grid size-8 flex-none place-items-center rounded-full border border-hair bg-white text-blue group-open:border-blue">
                    <Plus className="land-plus size-4" strokeWidth={2.5} />
                  </span>
                </summary>
                <p className="mb-5 max-w-[68ch] text-muted">{t(k(`land.q.${n}.p`))}</p>
              </details>
            ))}
          </div>
        </Section>

        {/* Closing call to action, printed on the band's blue */}
        <section className="band relative overflow-hidden text-white">
          <Guilloche className="absolute -right-24 top-1/2 size-[520px] -translate-y-1/2" color="#ffffff" opacity={0.18} />
          <Guilloche className="absolute -left-40 -top-40 size-[380px]" color="#ffffff" opacity={0.1} />
          <div className="land-reveal relative mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-8 px-4 py-16 sm:px-7 md:py-20">
            <div className="max-w-[40ch]">
              <h2 className="text-[2rem] font-bold leading-tight tracking-[-0.015em] md:text-[2.5rem]">{t('land.c.title')}</h2>
              <p className="mt-2 text-[1.0625rem] text-blue-ink">{t('land.c.lede')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-4 max-sm:w-full">
              <Link href="/sign-up" className="btn h-12 border-white px-6 text-[1rem] text-blue-deep hover:bg-blue-ink max-sm:flex-[1_1_100%]">
                {t('land.trial')}
                <ArrowRight aria-hidden className="land-arrow size-4" />
              </Link>
              <Link href="/sign-in" className="text-[0.9375rem] font-semibold text-white underline decoration-white/40 underline-offset-4 hover:decoration-white">
                {t('land.c.signIn')}
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-paper pb-10 pt-8 text-[0.875rem] text-muted">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-4 sm:px-7">
          <span className="flex items-center gap-3">
            <span className="text-[1.125rem] font-bold tracking-[0.04em] text-ink">{t('app.name')}</span>
            <span>© {new Date().getFullYear()}</span>
          </span>
          <span>{t('land.foot')}</span>
        </div>
        <div className="mx-auto mt-5 max-w-[1200px] px-4 sm:px-7">
          <p aria-hidden className="microprint">
            {`${t('app.name')} · `.repeat(60)}
          </p>
        </div>
      </footer>
    </div>
  );
}
