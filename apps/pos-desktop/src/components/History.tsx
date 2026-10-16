import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure, uuid } from '../lib/api';
import { peso } from '../lib/money';
import type { Receipt as ReceiptData, SaleDetail, SaleSummary } from '../types';
import type { Shift } from './Registers';
import { Receipt } from './Receipt';
import { Callout, Field, Money, Note } from './ui';

const timeAt = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-PH', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** Sales of this shift; managers can void (same shift) or return items with a cash refund. */
export function History({ shift, permissions }: { shift: Shift; permissions: string[] }) {
  const { t } = useT();
  const [sales, setSales] = useState<SaleSummary[] | null>(null);
  const [selected, setSelected] = useState<{ detail: SaleDetail; receipt: ReceiptData } | null>(null);
  const [mode, setMode] = useState<'void' | 'return' | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [key, setKey] = useState(uuid);
  const canVoid = permissions.includes('sales.void');
  const canReturn = permissions.includes('sales.refund');

  const load = () =>
    api<{ data: SaleSummary[] }>('GET', `/v1/sales?cashierSessionId=${shift.sessionId}`)
      .then((r) => setSales(r.data))
      .catch((e) => setMessage({ kind: 'error', text: e instanceof ApiFailure ? e.error.message : t('common.error') }));
  useEffect(() => {
    void load();
  }, []);

  async function open(id: string) {
    const [detail, receipt] = await Promise.all([api<SaleDetail>('GET', `/v1/sales/${id}`), api<ReceiptData>('GET', `/v1/sales/${id}/receipt`)]);
    setSelected({ detail, receipt });
    setMode(null);
    setMessage(null);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || !mode) return;
    const f = new FormData(e.currentTarget);
    const lines =
      mode === 'return'
        ? selected.detail.lines
            .map((l) => ({ saleLineId: l.id, quantity: String(f.get(`qty-${l.id}`) ?? '').trim(), disposition: f.get(`dmg-${l.id}`) ? 'DAMAGED' : 'RESTOCK' }))
            .filter((l) => l.quantity && l.quantity !== '0')
        : undefined;
    try {
      const r = await api<{ amountDue: string; returnNumber: number }>(
        'POST',
        `/v1/sales/${selected.detail.id}/returns`,
        { cashierSessionId: shift.sessionId, kind: mode === 'void' ? 'VOID' : 'RETURN', reason: String(f.get('reason') ?? ''), ...(lines && { lines }) },
        { 'idempotency-key': key },
      );
      setKey(uuid());
      await open(selected.detail.id);
      // After reloading the sale (which clears messages), confirm the refund to hand over.
      setMessage({ kind: 'info', text: t('history.refund', { amount: peso(r.amountDue) }) });
      void load();
    } catch (err) {
      // No answer or a server failure: the refund may have been recorded. Keep the key so
      // submitting again replays it instead of refunding twice.
      if (err instanceof ApiFailure && (err.error.status === 0 || err.error.status >= 500)) {
        return setMessage({ kind: 'error', text: t('history.unconfirmed') });
      }
      setKey(uuid());
      setMessage({ kind: 'error', text: err instanceof ApiFailure ? err.error.message : t('common.error') });
    }
  }

  return (
    <div className="mx-auto grid max-w-[1440px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[380px_1fr]">
      <Note denom="blue" className="p-2">
        {sales?.length === 0 && <p className="p-4 text-muted">{t('history.empty')}</p>}
        <ul>
          {sales?.map((s) => (
            <li key={s.id} className="row-rule">
              <button className={`flex w-full items-center justify-between px-3 py-3 text-left hover:bg-paper ${selected?.detail.id === s.id ? 'bg-paper' : ''}`} onClick={() => open(s.id)}>
                <span>
                  <span className="serial block">#{String(s.saleNumber).padStart(6, '0')}</span>
                  {/* Time tells two similar amounts apart before a void. */}
                  <span className="serial block text-[0.75rem] text-muted">{timeAt(s.completedAt, shift.branch.timezone)}</span>
                </span>
                <Money value={s.amountDue} />
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
              {canReturn && <button className="btn" aria-pressed={mode === 'return'} onClick={() => setMode('return')}>{t('history.return')}</button>}
              {!canVoid && !canReturn && <Callout kind="info">{t('history.managerOnly')}</Callout>}
            </div>
            {mode && (
              <Note className="no-print p-5">
                <form className="grid gap-3" onSubmit={submit}>
                  {mode === 'return' &&
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
                  <div>
                    <button className={`btn ${mode === 'void' ? 'btn-danger' : 'btn-primary'}`}>{mode === 'void' ? t('history.void') : t('history.return')}</button>
                  </div>
                </form>
              </Note>
            )}
            <Receipt data={selected.receipt} />
          </>
        )}
      </div>
    </div>
  );
}
