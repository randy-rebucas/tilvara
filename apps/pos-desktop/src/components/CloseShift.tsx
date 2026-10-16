import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure } from '../lib/api';
import { parseAmount, peso } from '../lib/money';
import type { Shift } from './Registers';
import { Callout, Field, Money, Note } from './ui';

interface SessionView {
  status: string;
  expectedCash: string;
  reconciliation: { variance: string } | null;
}

/** Count the drawer and close. The expected amount comes from the drawer ledger on the server. */
export function CloseShift({ shift, onClosed }: { shift: Shift; onClosed: () => void }) {
  const { t } = useT();
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  useEffect(() => {
    api<SessionView>('GET', `/v1/cashier-sessions/${shift.sessionId}`).then(setView).catch(() => setError(t('common.error')));
  }, [shift.sessionId]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const counted = parseAmount(String(new FormData(e.currentTarget).get('counted') ?? ''));
    if (!counted) return setFieldError(t('register.floatInvalid'));
    setFieldError(undefined);
    try {
      setView(await api<SessionView>('POST', `/v1/cashier-sessions/${shift.sessionId}/close`, { countedCash: counted }));
    } catch (err) {
      setError(err instanceof ApiFailure ? (err.error.status ? err.error.message : t('common.network')) : t('common.error'));
    }
  }

  const closed = view && view.status !== 'OPEN';
  return (
    <div className="mx-auto max-w-[560px] px-4 py-8 sm:px-6">
      <h1 className="text-[1.75rem] font-bold">{t('close.title')}</h1>
      <Note denom="orange" className="mt-5 grid gap-4 p-6">
        <p className="flex items-baseline justify-between">
          <span className="text-muted">{t('close.expected')}</span>
          <Money value={view?.expectedCash} className="text-[1.75rem] font-semibold" />
        </p>
        {!closed && (
          <form className="grid gap-3" onSubmit={submit}>
            <Field id="counted" name="counted" inputMode="decimal" autoFocus className="input-money" label={t('close.counted')} error={fieldError} placeholder="0.00" />
            <button className="btn btn-primary">{t('close.submit')}</button>
          </form>
        )}
        {error && <Callout kind="error">{error}</Callout>}
        {closed && view.status === 'RECONCILED' && <Callout kind="info">{t('close.balanced')}</Callout>}
        {closed && view.status === 'CLOSED' && <Callout kind="warn">{t('close.variance', { amount: peso(view.reconciliation?.variance) })}</Callout>}
        {closed && <button className="btn" onClick={onClosed}>{t('common.back')}</button>}
      </Note>
    </div>
  );
}
