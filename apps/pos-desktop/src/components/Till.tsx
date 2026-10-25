import type { OfflineReceipt as OfflineReceiptData } from '@1pos/pos-offline';
import { Printer, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { windowsPrinters, type PrinterTarget } from '../lib/desktop';
import { offlineReceiptToPrintable } from '../lib/printing';
import { useTill } from '../lib/till';
import { AuthStub } from './AuthNote';
import { Callout, Field, Money, Note } from './ui';

const when = (ms: number | string) => new Date(ms).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });

/** In the band: online or offline, and how many sales wait. Opens the till settings. */
export function TillStatus({ onOpen }: { onOpen: () => void }) {
  const { t } = useT();
  const { mode, online, status } = useTill();
  if (mode !== 'ready') return null;
  const revoked = status?.authState === 'REVOKED';
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('till.statusTitle')}
      className={`flex h-10 shrink-0 items-center gap-2 rounded px-3 text-[0.8125rem] font-semibold ${online && !revoked ? 'text-blue-ink hover:bg-white/10' : 'bg-amber-bg text-ink'}`}
    >
      {online && !revoked ? <Wifi className="size-4" aria-hidden /> : <WifiOff className="size-4" aria-hidden />}
      <span>{revoked ? t('till.revoked') : online ? t('till.online') : t('till.offline')}</span>
      {!!status?.pending && <span className="serial">· {t('till.pending', { n: String(status.pending) })}</span>}
      {!!status?.needsReview && <span className="serial">· {t('till.review', { n: String(status.needsReview) })}</span>}
    </button>
  );
}

/** First launch of the desktop till: bind it to a terminal issued in the admin. */
export function TillSetup({ onSkip }: { onSkip: () => void }) {
  const { t } = useT();
  const { setUp, apiUrl } = useTill();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await setUp(String(f.get('terminalId') ?? '').trim(), String(f.get('credential') ?? '').trim(), String(f.get('apiUrl') ?? ''));
    } catch (err) {
      const kind = (err as { kind?: string }).kind;
      setError(kind === 'INVALID_URL' ? t('till.serverInvalid') : kind === 'NETWORK' ? t('till.setupOffline') : t('till.setupFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthStub denom="orange" title={t('till.setupTitle')} lede={t('till.setupHint')}>
      <form className="grid gap-4" onSubmit={submit}>
        <Field id="apiUrl" name="apiUrl" type="url" label={t('till.server')} hint={t('till.serverHint')} required defaultValue={apiUrl} autoComplete="off" spellCheck={false} />
        <Field id="terminalId" name="terminalId" label={t('till.terminalId')} required autoComplete="off" spellCheck={false} />
        <Field id="credential" name="credential" type="password" label={t('till.credential')} required autoComplete="off" />
        {error && <Callout kind="error">{error}</Callout>}
        <button className="btn btn-primary" disabled={busy}>{t('till.connect')}</button>
        <button type="button" className="btn" onClick={onSkip}>{t('till.skip')}</button>
      </form>
    </AuthStub>
  );
}

/** Connection, queue and printer for this till. */
export function TillSettings({ onBack }: { onBack: () => void }) {
  const { t } = useT();
  const till = useTill();
  const { status } = till;
  const [kind, setKind] = useState<'none' | PrinterTarget['kind']>(till.printerTarget?.kind ?? 'none');
  const [printers, setPrinters] = useState<string[]>([]);
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (kind === 'windows') windowsPrinters().then(setPrinters, () => setPrinters([]));
  }, [kind]);

  async function savePrinter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const target: PrinterTarget | null =
      kind === 'network' ? { kind, host: String(f.get('host') ?? '').trim(), port: Number(f.get('port') || 9100) }
      : kind === 'windows' ? { kind, name: String(f.get('printerName') ?? '') }
      : null;
    await till.setPrinter(target);
    setNote({ kind: 'info', text: t('till.printerSaved') });
  }

  async function testPrint() {
    setNote(null);
    try {
      await till.printer.print(document.body, {
        header: ['Tilvara'], notice: 'TEST PRINT — NOT A RECEIPT', meta: [[till.terminalId ?? '', when(Date.now())]],
        items: [], totals: [], payments: [], footer: [t('till.printerTest')],
      });
    } catch (err) {
      setNote({ kind: 'error', text: `${t('receipt.printFailed')} (${(err as Error).message})` });
    }
  }

  const current = till.printerTarget;
  return (
    <div className="mx-auto grid max-w-[720px] gap-4 px-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[1.5rem] font-bold">{t('till.settings')}</h1>
        <button className="btn" onClick={onBack}>{t('till.settingsBack')}</button>
      </div>

      <Note denom="orange" className="grid gap-2 p-5">
        <h2 className="section-title">{t('till.statusTitle')}</h2>
        <p className="serial text-[0.8125rem] text-muted">{t('till.terminal', { id: till.terminalId ?? '—' })} · {till.apiUrl}</p>
        <p className="font-semibold">{till.online ? t('till.online') : t('till.offline')}</p>
        {status && (
          <ul className="grid gap-1 text-[0.9375rem]">
            <li>{t('till.pending', { n: String(status.pending) })} · {t('till.review', { n: String(status.needsReview) })}</li>
            {status.snapshot && <li>{t('till.priceListAge', { when: when(status.snapshot.asOf) })}</li>}
            {status.lastSyncAt && <li>{t('till.lastSync', { when: when(status.lastSyncAt) })}</li>}
          </ul>
        )}
        {status?.snapshot?.expired && <Callout kind="warn">{t('till.priceListExpired')}</Callout>}
        {status?.authState === 'REVOKED' && <Callout kind="error">{t('till.revoked')}. {t('till.revokedHelp')}</Callout>}
        <button className="btn justify-self-start" onClick={() => void till.engine?.drain().finally(() => void till.refresh())}>{t('till.syncNow')}</button>
      </Note>

      <Note className="p-5">
        <form className="grid gap-3" onSubmit={savePrinter}>
          <h2 className="section-title">{t('till.printer')}</h2>
          <div className="field">
            <label htmlFor="printerKind">{t('till.printer')}</label>
            <select id="printerKind" className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="none">{t('till.printerNone')}</option>
              <option value="network">{t('till.printerNetwork')}</option>
              <option value="windows">{t('till.printerWindows')}</option>
            </select>
          </div>
          {kind === 'network' && (
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <Field id="host" name="host" required label={t('till.printerHost')} placeholder="192.168.1.50" defaultValue={current?.kind === 'network' ? current.host : ''} />
              <Field id="port" name="port" type="number" min={1} max={65535} label={t('till.printerPort')} defaultValue={current?.kind === 'network' ? String(current.port) : '9100'} />
            </div>
          )}
          {kind === 'windows' && (
            <div className="field">
              <label htmlFor="printerName">{t('till.printerName')}</label>
              <select id="printerName" name="printerName" className="input" required defaultValue={current?.kind === 'windows' ? current.name : ''}>
                {printers.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}
          {note && <Callout kind={note.kind}>{note.text}</Callout>}
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary">{t('till.printerSave')}</button>
            {current && <button type="button" className="btn" onClick={() => void testPrint()}><Printer className="size-4" aria-hidden /> {t('till.printerTest')}</button>}
          </div>
        </form>
      </Note>

      <button className="btn btn-danger justify-self-start" onClick={() => void till.forget().then(onBack)}>{t('till.forget')}</button>
    </div>
  );
}

/** A sale kept on the till: its local reference and that it is not an invoice (ADR-0015 §6). */
export function OfflineReceipt({ data }: { data: OfflineReceiptData }) {
  const { t } = useT();
  const { printer } = useTill();
  const ref = useRef<HTMLDivElement>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const dateTime = when(data.occurredAt);
  const print = async () => {
    if (!ref.current) return;
    setPrintError(null);
    try {
      await printer.print(ref.current, offlineReceiptToPrintable(data, dateTime));
    } catch (e) {
      setPrintError((e as Error).message);
    }
  };
  const isVat = data.seller.vatStatus === 'VAT';
  const totals: [string, string][] = isVat
    ? [['VATable sales', data.totals.vatableSales], ['VAT', data.totals.vatAmount], ['VAT-exempt sales', data.totals.vatExemptSales], ['Zero-rated sales', data.totals.zeroRatedSales]]
    : [['Sales subject to percentage tax', data.totals.percentageTaxSales], ['Exempt sales', data.totals.vatExemptSales]];
  return (
    <div className="grid content-start gap-3">
      <div className="mx-auto w-full max-w-[420px]">
        <Callout kind="info">{t('till.offlineRecorded')}</Callout>
      </div>
      <div ref={ref} aria-label={t('till.offlineReceipt')} className="printable note mx-auto w-full max-w-[420px] p-6 font-[family-name:var(--font-serial)] text-[0.875rem]">
        <header className="text-center">
          <p className="text-[1.0625rem] font-semibold">{data.seller.name}</p>
          <p>{data.seller.registeredName}</p>
          {data.seller.tin && <p className="serial">{isVat ? 'VAT REG TIN' : 'NON-VAT REG TIN'} {data.seller.tin}</p>}
          <p className="serial mt-2 font-semibold">{data.notice}</p>
        </header>
        <p className="serial mt-3 flex justify-between border-y border-dashed border-hair py-1">
          <span>{data.localReference}</span>
          <span>{dateTime}</span>
        </p>
        <ul className="mt-2 grid gap-1">
          {data.lines.map((l, i) => (
            <li key={i}>
              <p className="flex justify-between gap-3"><span>{l.name}</span><span className="money">{l.amount} {l.flag}</span></p>
              <p className="text-muted">{l.quantity} × {l.unitPrice}</p>
              {l.promotion && <p className="text-muted">{l.promotion.name} −{l.promotion.discount}</p>}
            </li>
          ))}
        </ul>
        <dl className="mt-3 grid gap-0.5 border-t border-dashed border-hair pt-2">
          {totals.filter(([, v]) => !/^0(\.0+)?$/.test(v)).map(([k, v]) => (
            <div key={k} className="flex justify-between"><dt>{k}</dt><dd><Money value={v} /></dd></div>
          ))}
          <div className="flex justify-between text-[1rem] font-semibold"><dt>Total due</dt><dd><Money value={data.totals.amountDue} /></dd></div>
        </dl>
        <div className="mt-2 grid gap-0.5 border-t border-dashed border-hair pt-2">
          <p className="flex justify-between"><span>CASH</span><Money value={data.tendered} /></p>
          <p className="flex justify-between font-semibold"><span>Change</span><Money value={data.change} /></p>
        </div>
        <p className="mt-3 text-center text-muted">{t('receipt.cashier')}: {data.cashierName} · {data.register.name}</p>
      </div>
      {printError && (
        <div className="no-print mx-auto w-full max-w-[420px]">
          <Callout kind="error">{t('receipt.printFailed')} ({printError})</Callout>
        </div>
      )}
      <button className="no-print btn mx-auto" onClick={() => void print()}>
        <Printer className="size-4" aria-hidden /> {printError ? t('receipt.reprint') : t('receipt.print')}
      </button>
    </div>
  );
}
