import { Download } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Callout, Empty, Note, PageHeader, ToLocations } from '@/components/note';
import { PrintButton } from '@/components/print-button';
import { ScopePicker, SubNav } from '@/components/scope';
import { api, apiOrNull, type Branch, type Me, type PrescriptionStatus } from '@/lib/api';
import { servesPharmacy } from '@/lib/business-type';
import { datePresets, formatDateTime, todayManila } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';

export type PharmacyTab = 'prescriptions' | 'book' | 'dangerous' | 'trace' | 'holds' | 'setup';
export const PHARMACY_PATHS: Record<PharmacyTab, string> = {
  prescriptions: '/pharmacy',
  book: '/pharmacy/prescription-book',
  dangerous: '/pharmacy/dangerous-drugs',
  trace: '/pharmacy/batches',
  holds: '/pharmacy/holds',
  setup: '/pharmacy/setup',
};
/** Tabs about one branch (the trace and the holds cover every branch). */
const BRANCHED: readonly PharmacyTab[] = ['prescriptions', 'book', 'dangerous'];

/** Active branches, and the one the page works on (?branch=, else the first). */
export async function pharmacyBranch(param: string | undefined) {
  const list = await apiOrNull<{ data: Branch[] }>('/branches');
  const branches = list?.data.filter((b) => !b.archivedAt) ?? [];
  return { branches, branch: branches.find((b) => b.id === param) ?? branches[0] };
}

/** What the person may do here (UI hints only; the API checks each branch). */
export async function pharmacyAccess() {
  const me = await api<Me>('/me');
  const p = me.activeTenant?.permissions ?? [];
  return {
    me,
    businessType: me.activeTenant?.businessType,
    canRead: p.includes('pharmacy.read'),
    /** Record, edit and void prescriptions. */
    canDispense: p.includes('pharmacy.dispense'),
    canSetup: p.includes('pharmacy.setup'),
    canStock: p.includes('inventory.read'),
    /** Place and release holds on a batch. */
    canHold: p.includes('inventory.adjust'),
    canCustomers: p.includes('customers.read') || p.includes('customers.manage'),
  };
}

const isDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** The books' range (?from=&to=), today in Manila by default. */
export function bookRange(q: { from?: string; to?: string }) {
  const today = todayManila();
  return { from: isDate(q.from) ? q.from! : today, to: isDate(q.to) ? q.to! : today };
}

/**
 * Header, section tabs and branch picker of Pharmacy (ADR-0025). A business of another type sees why
 * instead (the API refuses prescription writes for it too).
 */
export async function PharmacyChrome({
  tab,
  branches = [],
  branch,
  extra = {},
  actions,
  children,
}: {
  tab: PharmacyTab;
  branches?: Branch[];
  branch?: Branch;
  /** Other choices kept in the URL across the branch picker. */
  extra?: Record<string, string>;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = await getT();
  const { businessType, canSetup, canRead, canStock } = await pharmacyAccess();
  if (!servesPharmacy(businessType)) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('pha.title')} lede={t('pha.lede')} />
        <Callout>
          {t('biz.pharmacyOff')}{' '}
          <a href="/subscription/business" className="font-semibold underline">{t('biz.restaurantOffLink')}</a>
        </Callout>
      </div>
    );
  }
  const branched = BRANCHED.includes(tab);
  const q = branch ? `?branch=${branch.id}` : '';
  const tabs = (Object.keys(PHARMACY_PATHS) as PharmacyTab[]).filter((k) =>
    k === 'setup' ? canSetup : k === 'trace' || k === 'holds' ? canStock : canRead,
  );
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('pha.title')} lede={t('pha.lede')} actions={actions} />
      <div className="contents print:hidden">
        <SubNav label={t('common.sections')} active={tab} items={tabs.map((key) => ({ key, href: `${PHARMACY_PATHS[key]}${BRANCHED.includes(key) ? q : ''}`, label: t(`pha.tab.${key}` as MessageKey) }))} />
        {branched && <ScopePicker label={t('common.branch')} items={branches} selected={branch?.id} href={(id) => `${PHARMACY_PATHS[tab]}?${new URLSearchParams({ branch: id, ...extra })}`} />}
      </div>
      {branched && !branch ? <Note><Empty action={<ToLocations label={t('loc.goTo')} />}>{t('inv.noBranch')}</Empty></Note> : children}
    </div>
  );
}

/** The books' date form, quick ranges, CSV and print (as the reports have), and the printed heading. */
export async function BookRangeForm({ tab, branch, from, to, report }: { tab: 'book' | 'dangerous'; branch: Branch; from: string; to: string; report: 'prescriptionBook' | 'dangerousDrugs' }) {
  const { t, lang } = await getT();
  const path = PHARMACY_PATHS[tab];
  return (
    <>
      <p className="hidden text-[0.9375rem] print:block" data-testid="print-heading">
        <b>{t(`pha.tab.${tab}` as MessageKey)}</b> · {branch.name} · {from === to ? from : `${from} – ${to}`} · {t('rep.printedAt', { at: formatDateTime(new Date().toISOString(), lang) })}
      </p>
      <div className="flex flex-col gap-2 print:hidden">
        <form method="get" action={path} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="branch" value={branch.id} />
          <div className="field">
            <label htmlFor="from">{t('common.from')}</label>
            <input id="from" name="from" type="date" className="input" defaultValue={from} />
          </div>
          <div className="field">
            <label htmlFor="to">{t('common.to')}</label>
            <input id="to" name="to" type="date" className="input" defaultValue={to} />
          </div>
          <button className="btn">{t('common.show')}</button>
          <a href={`/reports/export?${new URLSearchParams({ report, branch: branch.id, from, to })}`} className="btn" download>
            <Download aria-hidden className="size-4" /> {t('rep.csv')}
          </a>
          <PrintButton />
        </form>
        <nav aria-label={t('rep.presets')} className="flex flex-wrap gap-1.5">
          {datePresets(todayManila()).map((p) => {
            const on = p.from === from && p.to === to;
            return (
              <Link
                key={p.key}
                href={`${path}?${new URLSearchParams({ branch: branch.id, from: p.from, to: p.to })}`}
                aria-current={on ? 'true' : undefined}
                className={`tag h-8! px-3! text-[0.8125rem]! ${on ? 'border-blue! text-ink!' : 'hover:text-ink'}`}
              >
                {t(`rep.preset.${p.key}` as MessageKey)}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}

/** A prescription's status as one word: blue when filled (the Blue Tick Rule), struck when voided. */
export function PrescriptionTag({ status, label }: { status: PrescriptionStatus; label: string }) {
  const look = status === 'FILLED' ? 'tag border-blue! bg-blue! text-white!' : status === 'PARTLY_FILLED' ? 'tag border-blue/40! text-blue!' : status === 'VOIDED' ? 'tag line-through' : 'tag text-ink!';
  return <span className={look} data-rx-status={status}>{label}</span>;
}
