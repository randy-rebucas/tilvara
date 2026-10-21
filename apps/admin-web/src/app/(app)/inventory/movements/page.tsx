import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable, type Column } from '@/components/record-table';
import { ApiError, apiOrNull, type MovementSummary } from '@/lib/api';
import { peso, qty, signed, sumDecimal, todayManila } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { InventoryChrome, inventoryBranch } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('inventory.movements');

const TYPES = ['RECEIPT', 'SUPPLIER_RETURN', 'SALE', 'CONSUMPTION', 'RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'COUNT', 'ADJUSTMENT', 'WASTE', 'UNPACK_OUT', 'UNPACK_IN'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
type Row = MovementSummary['data'][number];

export default async function MovementsPage({ searchParams }: { searchParams: Promise<{ branch?: string; from?: string; to?: string }> }) {
  const { t } = await getT();
  const sp = await searchParams;
  const { branches, branch } = await inventoryBranch(sp.branch);
  const today = todayManila();
  const to = sp.to && DATE.test(sp.to) ? sp.to : today;
  const from = sp.from && DATE.test(sp.from) ? sp.from : `${to.slice(0, 7)}-01`;
  let report: MovementSummary | null = null;
  let problem: string | null = null;
  if (branch) {
    try {
      report = await apiOrNull<MovementSummary>(`/reports/stock-movements?branchId=${branch.id}&from=${from}&to=${to}`);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 400) throw e;
      problem = e.message;
    }
  }
  const anyBelow = report?.data.some((r) => r.belowZero > 0) ?? false;
  const present = TYPES.filter((type) => report?.data.some((r) => r.movements[type]));
  const sum = (pick: (r: Row) => string) => peso(sumDecimal((report?.data ?? []).map(pick)));

  const columns: Column<Row>[] = [
    { header: t('prod.sku'), cell: (r) => <Serial className="text-ink">{r.sku}</Serial> },
    { header: t('common.item'), cell: (r) => r.name },
    { header: t('inv.opening'), num: true, cell: (r) => qty(r.opening.quantity) },
    ...present.map((type) => ({ header: t(`mv.${type}` as MessageKey), num: true, cell: (r: Row) => (r.movements[type] ? signed(r.movements[type]!.quantity) : <span className="text-muted">·</span>) })),
    { header: t('inv.closing'), num: true, cell: (r) => <b>{qty(r.closing.quantity)}</b> },
    ...(anyBelow ? [{ header: t('inv.belowZero'), num: true, cell: (r: Row) => (r.belowZero ? <span className="font-semibold text-gold">{r.belowZero}×</span> : <span className="text-muted">·</span>) }] : []),
    { header: t('common.value'), num: true, cell: (r) => <span className="money font-semibold">{peso(r.closing.value)}</span> },
  ];

  return (
    <InventoryChrome tab="movements" branches={branches} branch={branch}>
      <form method="get" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="branch" value={branch?.id ?? ''} />
        <div className="field">
          <label htmlFor="mv-from">{t('common.from')}</label>
          <input id="mv-from" className="input" type="date" name="from" defaultValue={from} />
        </div>
        <div className="field">
          <label htmlFor="mv-to">{t('common.to')}</label>
          <input id="mv-to" className="input" type="date" name="to" defaultValue={to} />
        </div>
        <button className="btn">{t('common.show')}</button>
      </form>
      {problem && <Callout tone="error">{problem}</Callout>}
      <Note denom="gold" className="pr-2">
        {report && report.data.length > 0 ? (
          <RecordTable
            rows={report.data}
            rowKey={(r) => r.variantId}
            columns={columns}
            stacked={{
              title: (r) => r.name,
              meta: (r) => (
                <Serial>
                  {r.sku} · {t('inv.opening')} {qty(r.opening.quantity)}
                  {present.filter((type) => r.movements[type]).map((type) => ` · ${t(`mv.${type}` as MessageKey)} ${signed(r.movements[type]!.quantity)}`)} · {t('inv.closing')} {qty(r.closing.quantity)}
                  {r.belowZero > 0 && <span className="text-gold"> · {t('inv.belowZero')} {r.belowZero}×</span>}
                </Serial>
              ),
              figure: (r) => <span className="money font-semibold">{peso(r.closing.value)}</span>,
            }}
            foot={{
              cells: ['', t('common.total'), '', ...present.map(() => ''), '', ...(anyBelow ? [''] : []), <span key="c" className="money">{sum((r) => r.closing.value)}</span>],
              title: t('common.total'),
              figure: <span className="money">{sum((r) => r.closing.value)}</span>,
            }}
          />
        ) : (
          <Empty>{report ? t('inv.noMovements') : problem ? '—' : t('common.noAccess')}</Empty>
        )}
      </Note>
    </InventoryChrome>
  );
}
