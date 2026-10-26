import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure, uuid, withReference } from '../lib/api';
import { peso } from '../lib/money';
import type { Receipt as ReceiptData, SaleDetail, SaleSummary, Workstation } from '../types';
import type { ExchangeStart } from './CounterTools';
import type { Shift } from './Registers';
import { Receipt } from './Receipt';
import { Callout, Empty, Field, Money, Note } from './ui';

const METHOD: Record<string, 'pay.cash' | 'pay.card' | 'pay.qr' | 'pay.storeCredit'> = { CASH: 'pay.cash', CARD: 'pay.card', QR: 'pay.qr', EWALLET: 'pay.qr', STORE_CREDIT: 'pay.storeCredit' };
const timeAt = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-PH', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/**
 * Sales of this shift; managers can void (same shift), return items with a cash refund, or start an
 * exchange (the refund pays for new items rung up on Sell). Earlier sales are found by register and number.
 */
export function History({ shift, permissions, onExchange }: { shift: Shift; permissions: string[]; onExchange?: (x: ExchangeStart) => void }) {
  const { t } = useT();
  const [sales, setSales] = useState<SaleSummary[] | null>(null);
  const [selected, setSelected] = useState<{ detail: SaleDetail; receipt: ReceiptData } | null>(null);
  /** The refund/void slip just made, shown (and printable) until the cashier goes back to the sale. */
  const [slip, setSlip] = useState<ReceiptData | null>(null);
  const [mode, setMode] = useState<'void' | 'return' | 'exchange' | null>(null);
  /** The refund an exchange would give, shown before the new items are chosen. */
  const [preview, setPreview] = useState<ExchangeStart | null>(null);
  const [registers, setRegisters] = useState<Workstation['register'][]>([shift.register]);
  const [findRegister, setFindRegister] = useState(shift.register.id);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [key, setKey] = useState(uuid);
  const canVoid = permissions.includes('sales.void');
  const canReturn = permissions.includes('sales.refund');
  const canExchange = canReturn && permissions.includes('sales.create') && Boolean(onExchange);

  const load = () =>
    api<{ data: SaleSummary[] }>('GET', `/v1/sales?cashierSessionId=${shift.sessionId}`)
      .then((r) => setSales(r.data))
      .catch((e) => setMessage({ kind: 'error', text: e instanceof ApiFailure ? e.error.message : t('common.error') }));
  useEffect(() => {
    void load();
    // A sale rung up at another register of this branch can come back here too.
    if (canVoid || canReturn) {
      void api<{ data: Workstation[] }>('GET', '/v1/pos/workstations')
        .then((r) => setRegisters(r.data.filter((w) => w.branch.id === shift.branch.id).map((w) => w.register)))
        .catch(() => undefined);
    }
  }, []);

  async function open(id: string) {
    const [detail, receipt] = await Promise.all([api<SaleDetail>('GET', `/v1/sales/${id}`), api<ReceiptData>('GET', `/v1/sales/${id}/receipt`)]);
    setSelected({ detail, receipt });
    setSlip(null);
    setMode(null);
    setPreview(null);
    setMessage(null);
  }

  async function find(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const n = Number.parseInt(String(new FormData(e.currentTarget).get('findNumber') ?? '').trim(), 10);
    if (!Number.isInteger(n) || n <= 0) return setMessage({ kind: 'error', text: t('history.notFound') });
    try {
      const r = await api<{ data: SaleSummary[] }>('GET', `/v1/sales?registerId=${findRegister}&saleNumber=${n}&limit=1`);
      if (!r.data[0]) return setMessage({ kind: 'error', text: t('history.notFound') });
      await open(r.data[0].id);
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiFailure ? withReference(err.error.message, err) : t('common.error') });
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || !mode) return;
    const f = new FormData(e.currentTarget);
    const lines =
      mode !== 'void'
        ? selected.detail.lines
            .map((l) => ({ saleLineId: l.id, quantity: String(f.get(`qty-${l.id}`) ?? '').trim(), disposition: (f.get(`dmg-${l.id}`) ? 'DAMAGED' : 'RESTOCK') as 'RESTOCK' | 'DAMAGED' }))
            .filter((l) => l.quantity && !/^0*\.?0*$/.test(l.quantity))
        : undefined;
    if (mode === 'exchange') {
      if (!lines?.length) return setMessage({ kind: 'error', text: t('history.exchangeNone') });
      try {
        const r = await api<{ refund: string }>('POST', `/v1/sales/${selected.detail.id}/returns/preview`, { lines });
        const items = lines.map((l) => ({ name: selected.detail.lines.find((x) => x.id === l.saleLineId)!.name, quantity: l.quantity }));
        setPreview({ saleId: selected.detail.id, saleNumber: selected.detail.saleNumber, reason: String(f.get('reason') ?? '').trim(), returnLines: lines, refund: r.refund, items });
        setMessage(null);
      } catch (err) {
        setMessage({ kind: 'error', text: err instanceof ApiFailure ? withReference(err.error.message, err) : t('common.error') });
      }
      return;
    }
    try {
      const r = await api<{ id: string; amountDue: string; returnNumber: number; refundMethod?: string; refunds?: { method: string; amount: string }[] }>(
        'POST',
        `/v1/sales/${selected.detail.id}/returns`,
        {
          cashierSessionId: shift.sessionId, kind: mode === 'void' ? 'VOID' : 'RETURN', reason: String(f.get('reason') ?? ''), ...(lines && { lines }),
          // A sale with a customer can be refunded as their store credit instead of cash (ADR-0018).
          ...(f.get('toCredit') === 'on' && { refundTo: 'STORE_CREDIT' }),
        },
        { 'idempotency-key': key },
      );
      setKey(uuid());
      await open(selected.detail.id);
      // After reloading the sale (which clears messages), confirm the refund and show its slip to hand over.
      // A sale paid with store credit gives that share back to the credit, the rest in cash (ADR-0018).
      const parts = r.refunds?.length ? r.refunds : [{ method: f.get('toCredit') === 'on' ? 'STORE_CREDIT' : (r.refundMethod ?? 'CASH'), amount: r.amountDue }];
      const refunded = parts.map((p) => t(p.method === 'STORE_CREDIT' ? 'history.creditGiven' : 'history.refund', { amount: peso(p.amount) })).join(' · ');
      setMessage({ kind: 'info', text: refunded });
      void api<ReceiptData>('GET', `/v1/sale-returns/${r.id}/receipt`).then(setSlip).catch(() => undefined);
      void load();
    } catch (err) {
      // No answer or a server failure: the refund may have been recorded. Keep the key so
      // submitting again replays it instead of refunding twice.
      if (err instanceof ApiFailure && (err.error.status === 0 || err.error.status >= 500)) {
        return setMessage({ kind: 'error', text: withReference(t('history.unconfirmed'), err) });
      }
      setKey(uuid());
      setMessage({ kind: 'error', text: err instanceof ApiFailure ? err.error.message : t('common.error') });
    }
  }

  return (
    <div className="mx-auto grid max-w-[1440px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[380px_1fr]">
      <Note denom="blue" className="p-2">
        {(canVoid || canReturn) && (
          // Returns are not limited to this shift: find any sale of this register by its receipt number.
          <form className="no-print row-rule grid gap-2 px-3 pb-3 pt-2" onSubmit={find}>
            <p className="font-semibold">{t('history.findTitle')}</p>
            <p className="text-[0.8125rem] text-muted">{t('history.findHint')}</p>
            {registers.length > 1 && (
              <div className="field">
                <label htmlFor="findRegister">{t('history.register')}</label>
                <select id="findRegister" name="findRegister" className="input" value={findRegister} onChange={(e) => setFindRegister(e.target.value)}>
                  {registers.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
                </select>
              </div>
            )}
            <div className="flex items-end gap-2">
              <Field id="findNumber" name="findNumber" inputMode="numeric" label={t('history.findNumber')} placeholder="000123" />
              <button className="btn mb-[2px]">{t('history.find')}</button>
            </div>
          </form>
        )}
        {sales?.length === 0 && <Empty>{t('history.empty')}</Empty>}
        <ul>
          {sales?.map((s) => (
            <li key={s.id} className="row-rule">
              <button className="row-pick flex w-full items-center justify-between px-3 py-3 text-left" aria-current={selected?.detail.id === s.id ? 'true' : undefined} onClick={() => open(s.id)}>
                <span>
                  <span className="serial block">#{String(s.saleNumber).padStart(6, '0')}</span>
                  {/* Time tells two similar amounts apart before a void; the tender, how it was paid. */}
                  <span className="serial block text-[0.75rem] text-muted">
                    {timeAt(s.completedAt, shift.branch.timezone)}
                    {s.tenderMethods?.length ? ` · ${s.tenderMethods.map((m) => (METHOD[m] ? t(METHOD[m]) : m)).join(' + ')}` : ''}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <Money value={s.amountDue} />
                  {s.voided ? (
                    <span className="tag tag-bad">{t('history.voidedTag')}</span>
                  ) : s.returnCount ? (
                    <span className="tag tag-warn">{t('history.returnedTag')}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Note>
      <div className="grid content-start gap-4">
        {message && <Callout kind={message.kind}>{message.text}</Callout>}
        {selected && (
          <>
            <div className="no-print flex flex-wrap gap-2">
              {canVoid && <button className="btn btn-danger" aria-pressed={mode === 'void'} onClick={() => setMode('void')}>{t('history.void')}</button>}
              {canReturn && <button className="btn" aria-pressed={mode === 'return'} onClick={() => { setMode('return'); setPreview(null); }}>{t('history.return')}</button>}
              {canExchange && <button className="btn" aria-pressed={mode === 'exchange'} onClick={() => setMode('exchange')}>{t('history.exchange')}</button>}
              {!canVoid && !canReturn && <Callout kind="info">{t('history.managerOnly')}</Callout>}
            </div>
            {mode && (
              <Note className="no-print p-5">
                <form className="grid gap-3" onSubmit={submit}>
                  {mode !== 'void' &&
                    selected.detail.lines.map((l) => (
                      <div key={l.id} className="grid items-end gap-3 sm:grid-cols-[1fr_120px_auto]">
                        <p>
                          {l.name}{' '}
                          <span className="serial text-[0.75rem] text-muted">
                            {l.quantity} · {t('history.returned', { qty: l.returnedQuantity })}
                          </span>
                        </p>
                        <Field id={`qty-${l.id}`} name={`qty-${l.id}`} label={t('history.returnQty')} inputMode="decimal" placeholder="0" />
                        <label className="flex items-center gap-2 pb-3 text-[0.875rem]">
                          <input type="checkbox" name={`dmg-${l.id}`} /> {t('history.damaged')}
                        </label>
                      </div>
                    ))}
                  <Field id="reason" name="reason" required label={t('history.reason')} />
                  {mode !== 'exchange' && selected.detail.customerId && (
                    <label className="flex items-center gap-2 text-[0.875rem]">
                      <input type="checkbox" name="toCredit" /> {t('history.toCredit')}
                    </label>
                  )}
                  <div>
                    <button className={`btn ${mode === 'void' ? 'btn-danger' : mode === 'exchange' ? '' : 'btn-primary'}`}>
                      {mode === 'void' ? t('history.void') : mode === 'exchange' ? t('history.previewRefund') : t('history.return')}
                    </button>
                  </div>
                </form>
                {mode === 'exchange' && preview && (
                  <div className="mt-4 grid gap-3 border-t border-hair-soft pt-4">
                    <p className="flex justify-between text-[1.0625rem] font-semibold"><span>{t('history.exchangeRefund', { amount: peso(preview.refund) })}</span></p>
                    <button type="button" className="btn btn-primary justify-self-start" onClick={() => onExchange?.(preview)}>{t('history.chooseItems')}</button>
                  </div>
                )}
              </Note>
            )}
            {slip ? (
              <>
                <button type="button" className="no-print btn btn-sm justify-self-start" onClick={() => setSlip(null)}>{t('history.showSale')}</button>
                <Receipt data={slip} />
              </>
            ) : (
              <Receipt data={selected.receipt} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
