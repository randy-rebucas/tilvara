import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure, uuid } from '../lib/api';
import { parseAmount } from '../lib/money';
import type { Workstation } from '../types';
import { Callout, Field, Note } from './ui';

export interface Shift {
  sessionId: string;
  register: Workstation['register'];
  branch: Workstation['branch'];
}

/**
 * Pick a register: continue your open shift, or open one with a counted starting float. Kitchen staff
 * (kitchen.operate) can open the kitchen display instead, without a register or a drawer.
 */
export function RegisterPicker({ onReady, onKitchen }: { onReady: (shift: Shift) => void; onKitchen?: () => void }) {
  const { t } = useT();
  const [stations, setStations] = useState<Workstation[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [floatError, setFloatError] = useState<string | undefined>();
  // One key per open attempt, reused if the request is retried after a network failure.
  const [openKey] = useState(uuid);

  useEffect(() => {
    api<{ data: Workstation[] }>('GET', '/v1/pos/workstations')
      .then((r) => setStations(r.data))
      .catch((e) => setError(e instanceof ApiFailure ? e.error.message : t('common.error')));
  }, []);

  async function open(e: FormEvent<HTMLFormElement>, ws: Workstation) {
    e.preventDefault();
    const amount = parseAmount(String(new FormData(e.currentTarget).get('float') ?? ''));
    if (!amount) return setFloatError(t('register.floatInvalid'));
    setFloatError(undefined);
    try {
      const s = await api<{ id: string }>('POST', '/v1/cashier-sessions', { registerId: ws.register.id, openingFloat: amount }, { 'idempotency-key': openKey });
      onReady({ sessionId: s.id, register: ws.register, branch: ws.branch });
    } catch (err) {
      setError(err instanceof ApiFailure ? (err.error.status === 0 || err.error.status >= 500 ? t('common.network') : err.error.message) : t('common.error'));
    }
  }

  return (
    <div className="mx-auto max-w-[760px] px-4 py-10 sm:px-6">
      <h1 className="text-[1.75rem] font-bold">{t('register.title')}</h1>
      <p className="mt-1 text-muted">{t('register.lede')}</p>
      {error && <div className="mt-4"><Callout kind="error">{error}</Callout></div>}
      {stations?.length === 0 && !onKitchen && <div className="mt-6"><Callout kind="warn">{t('register.none')}</Callout></div>}
      {onKitchen && (
        <Note denom="violet" className="mt-6 flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <p className="text-[1.0625rem] font-semibold">{t('kds.entryTitle')}</p>
            <p className="text-[0.875rem] text-muted">{t('kds.entryLede')}</p>
          </div>
          <button type="button" className="btn" onClick={onKitchen}>{t('kds.open')}</button>
        </Note>
      )}
      <div className="mt-6 grid gap-3">
        {stations?.map((ws) => (
          <Note key={ws.register.id} denom="orange" className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[1.0625rem] font-semibold">{ws.register.name}</p>
                <p className="serial text-[0.8125rem] text-muted">
                  <span className="text-orange">{ws.register.code}</span> · {ws.branch.name}
                </p>
              </div>
              {ws.openSession?.mine ? (
                <button className="btn btn-primary" onClick={() => onReady({ sessionId: ws.openSession!.id, register: ws.register, branch: ws.branch })}>
                  {t('register.continue')}
                </button>
              ) : ws.openSession ? (
                <span className="tag">{t('register.busy')}</span>
              ) : opening === ws.register.id ? null : (
                <button className="btn" onClick={() => setOpening(ws.register.id)}>
                  {t('register.open')}
                </button>
              )}
            </div>
            {opening === ws.register.id && !ws.openSession && (
              <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={(e) => open(e, ws)}>
                <Field id="float" name="float" inputMode="decimal" autoFocus className="input-money" label={t('register.float')} hint={t('register.floatHint')} error={floatError} placeholder="0.00" />
                <button className="btn btn-primary sm:mb-[1.6rem]">{t('register.open')}</button>
              </form>
            )}
          </Note>
        ))}
      </div>
    </div>
  );
}
