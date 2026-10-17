import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Callout, Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, ApiError, type Member } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';

export const metadata = { title: 'Audit log' };

interface AuditRow {
  id: string;
  occurredAt: string;
  actorType: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  correlationId: string | null;
  metadata: Record<string, unknown>;
}

type Query = { from?: string; to?: string; action?: string; actor?: string; type?: string; record?: string; cursor?: string };
const isDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** Action families to narrow by (prefixes; the API matches "starts with"). */
const FAMILIES = ['sale', 'cash', 'stock', 'goods', 'supplier', 'purchase', 'order', 'member', 'role', 'invitation', 'product', 'price', 'journal', 'period', 'terminal'] as const;

/** Where a record lives in the admin, when it has a page. */
function recordHref(type: string, id: string | null): string | null {
  if (!id) return null;
  switch (type) {
    case 'sale': return `/sales/${id}`;
    case 'cashier_session': return `/shifts/${id}`;
    case 'supplier': return `/purchasing/suppliers/${id}`;
    case 'purchase_order': return `/purchasing/orders/${id}`;
    case 'goods_receipt': return `/purchasing/receipts/${id}`;
    case 'supplier_return': return `/purchasing/returns/${id}`;
    case 'stock_transfer': return `/inventory/transfers/${id}`;
    case 'stock_count': return `/inventory/counts/${id}`;
    case 'stock_adjustment': return `/inventory/adjustments/${id}`;
    case 'product': return `/products/${id}`;
    case 'role': return `/team/roles/${id}`;
    case 'membership': return `/team/members/${id}`;
    case 'legal_entity': return `/locations/entities/${id}`;
    case 'menu': return `/restaurant/menus/${id}`;
    default: return null;
  }
}

/** A short, readable view of an event's details (keys and simple values; nested values are counted). */
function details(m: Record<string, unknown>): string {
  return Object.entries(m)
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${v === null ? '—' : typeof v === 'object' ? (Array.isArray(v) ? `${v.length} items` : '…') : String(v)}`)
    .join(' · ');
}

/** The business's audit log: who did what to which record, when (append-only; audit.read for the whole business). */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Query> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const q = new URLSearchParams({ limit: '50' });
  if (isDate(sp.from)) q.set('from', sp.from!);
  if (isDate(sp.to)) q.set('to', sp.to!);
  if (sp.action && /^[a-z_.]{2,80}$/.test(sp.action)) q.set('action', sp.action);
  if (sp.actor && isUuid(sp.actor)) q.set('actorUserId', sp.actor);
  if (sp.type && /^[a-z_]{2,40}$/.test(sp.type)) q.set('resourceType', sp.type);
  if (sp.record && sp.record.length <= 100) q.set('resourceId', sp.record);
  if (sp.cursor && isUuid(sp.cursor)) q.set('cursor', sp.cursor);

  let log: { data: AuditRow[]; nextCursor: string | null } | null = null;
  let error: string | null = null;
  try {
    log = await api(`/audit-logs?${q}`);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status !== 403) error = (e.details?.issues as { message: string }[] | undefined)?.map((i) => i.message).join(' ') || e.message;
  }
  const members = await apiOrNull<{ data: Member[] }>('/members');
  const filtered = [...q.keys()].some((k) => !['limit', 'cursor'].includes(k));
  const keep = (extra: Record<string, string>) => {
    const p = new URLSearchParams(Object.entries(sp).filter(([k, v]) => k !== 'cursor' && v) as [string, string][]);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `/audit?${p}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('audit.title')} lede={t('audit.lede')} />
      <form method="get" action="/audit" className="flex flex-wrap items-end gap-3">
        <div className="field">
          <label htmlFor="from">{t('common.from')}</label>
          <input id="from" name="from" type="date" className="input" defaultValue={sp.from} />
        </div>
        <div className="field">
          <label htmlFor="to">{t('common.to')}</label>
          <input id="to" name="to" type="date" className="input" defaultValue={sp.to} />
        </div>
        <div className="field">
          <label htmlFor="action">{t('audit.what')}</label>
          <select id="action" name="action" className="input" defaultValue={sp.action ?? ''}>
            <option value="">{t('common.all')}</option>
            {FAMILIES.map((f) => <option key={f} value={f}>{t(`audit.family.${f}`)}</option>)}
          </select>
        </div>
        {members && (
          <div className="field">
            <label htmlFor="actor">{t('audit.who')}</label>
            <select id="actor" name="actor" className="input" defaultValue={sp.actor ?? ''}>
              <option value="">{t('common.all')}</option>
              {members.data.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.displayName}</option>)}
            </select>
          </div>
        )}
        {sp.type && <input type="hidden" name="type" value={sp.type} />}
        {sp.record && <input type="hidden" name="record" value={sp.record} />}
        <button className="btn">{t('common.show')}</button>
        {filtered && <Link href="/audit" className="self-center text-[0.875rem] underline">{t('audit.clear')}</Link>}
      </form>
      {(sp.type || sp.record) && <p className="text-[0.875rem] text-muted">{t('audit.oneRecord', { type: sp.type ?? '', id: sp.record ?? '' })}</p>}
      {error && <Callout tone="error">{error}</Callout>}
      <Note denom="ink" className="pr-2">
        {log && log.data.length > 0 ? (
          <RecordTable
            rows={log.data}
            rowKey={(r) => r.id}
            columns={[
              { header: t('audit.when'), cell: (r) => <span className="whitespace-nowrap text-muted">{formatDateTime(r.occurredAt, lang)}</span> },
              { header: t('audit.who'), cell: (r) => (r.actorUserId ? <Link href={keep({ actor: r.actorUserId })} className="underline">{r.actorName ?? '—'}</Link> : <span className="text-muted">{t('audit.system')}</span>) },
              { header: t('audit.what'), cell: (r) => <Serial className="text-ink">{r.action}</Serial> },
              {
                header: t('audit.record'),
                cell: (r) => {
                  const href = recordHref(r.resourceType, r.resourceId);
                  return (
                    <span className="flex flex-col">
                      {href ? <Link href={href} className="underline">{r.resourceType}</Link> : <span>{r.resourceType}</span>}
                      {r.resourceId && <Link href={keep({ type: r.resourceType, record: r.resourceId })} className="serial text-[0.75rem] text-muted hover:underline">{t('audit.history')}</Link>}
                    </span>
                  );
                },
              },
              { header: t('audit.details'), cell: (r) => <span className="text-[0.8125rem] text-muted">{details(r.metadata)}</span> },
            ]}
            stacked={{
              title: (r) => <Serial className="text-ink">{r.action}</Serial>,
              meta: (r) => <span className="text-[0.8125rem] text-muted">{formatDateTime(r.occurredAt, lang)} · {r.actorName ?? t('audit.system')} · {r.resourceType}</span>,
            }}
          />
        ) : (
          <Empty>{log ? (filtered ? t('audit.noMatches') : t('audit.empty')) : error ? '' : t('common.noAccess')}</Empty>
        )}
      </Note>
      {log?.nextCursor && (
        <Link className="btn self-center" href={keep({ cursor: log.nextCursor })}>
          {t('common.nextPage')} <ChevronRight aria-hidden className="size-4" />
        </Link>
      )}
    </div>
  );
}
