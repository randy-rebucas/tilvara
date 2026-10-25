import { httpTransport, LocalStore, OfflineEngine, type EngineStatus } from '@1pos/pos-offline';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { browserPrinter, escposDrawer, escposPrinter, noDrawer, type CashDrawer, type ReceiptPrinter } from './devices';
import { apiBase, isDesktop, normalizeApiUrl, setApiBase, tauriByteChannel, tauriSqlDriver, terminalSecret, type PrinterTarget } from './desktop';

/**
 * The desktop till (ADR-0015 slice 5): which terminal this is, its offline engine, whether the API
 * answers, and the receipt printer. Browser mode has none of it (`mode: 'browser'`), and the counter
 * then behaves exactly as before: online only, browser print dialog.
 */
export interface Till {
  mode: 'browser' | 'loading' | 'unconfigured' | 'ready';
  engine: OfflineEngine | null;
  status: EngineStatus | null;
  /** False once the API stopped answering; true again after the next successful snapshot. */
  online: boolean;
  terminalId: string | null;
  printerTarget: PrinterTarget | null;
  printer: ReceiptPrinter;
  drawer: CashDrawer;
  /** The server this till talks to (saved at set-up). */
  apiUrl: string;
  /**
   * Check the server address, terminal id and one-time credential against the API, then keep them
   * (credential in the OS store). Rejects with `INVALID_URL` for an address the till will not use.
   */
  setUp(terminalId: string, credential: string, apiUrl: string): Promise<void>;
  /** Forget this terminal (the queue stays in the file; a new set-up continues it). */
  forget(): Promise<void>;
  setPrinter(target: PrinterTarget | null): Promise<void>;
  /** Re-read the engine status now (after ringing up or syncing). */
  refresh(): Promise<void>;
  /** The API failed to answer a request; switch to offline until it answers again. */
  reportUnreachable(): void;
  /** Fetch a fresh snapshot now (e.g. the counter opened on a shift the till has not seen yet). */
  refreshSnapshot(): Promise<void>;
  /** The branch's service staff from the stored snapshot (ADR-0022 §5), for naming who did a line offline. */
  snapshotStaff(): Promise<{ id: string; displayName: string; color: string | null }[]>;
}

const TillContext = createContext<Till | null>(null);

export function useTill(): Till {
  const t = useContext(TillContext);
  if (!t) throw new Error('useTill outside TillProvider');
  return t;
}

const STATUS_MS = 3_000;
/**
 * Snapshots: every fetch is recorded server-side and carries the whole catalogue, so online the till
 * refreshes prices every 10 minutes (often enough for managers to see it alive: their till-health view
 * flags 30 minutes of silence during a shift); offline it probes every 30 s for the API coming back.
 */
const REFRESH_ONLINE_MS = 10 * 60_000;
const PROBE_OFFLINE_MS = 30_000;
/** Online, how often the till asks whether its snapshot is out of date (a cheap version check). */
const CHECK_ONLINE_MS = 30_000;
export function TillProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => (isDesktop ? new LocalStore(tauriSqlDriver()) : null), []);
  const [mode, setMode] = useState<Till['mode']>(isDesktop ? 'loading' : 'browser');
  const [engine, setEngine] = useState<OfflineEngine | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [online, setOnline] = useState(true);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [printerTarget, setPrinterTarget] = useState<PrinterTarget | null>(null);
  const [apiUrl, setApiUrl] = useState(apiBase());
  const engineRef = useRef<OfflineEngine | null>(null);

  const start = useCallback(async (id: string, credential: string) => {
    engineRef.current?.stop();
    const transport = httpTransport({ baseUrl: apiBase(), terminalId: id, credential });
    const e = new OfflineEngine({ store: store!, transport });
    await e.open();
    engineRef.current = e;
    setEngine(e);
    setTerminalId(id);
    setMode('ready');
    e.start(10_000);
    e.refreshSnapshot().then(() => setOnline(true), () => setOnline(false));
  }, [store]);

  // On launch: the terminal saved in the file + its credential from the OS store; pending sales resume.
  useEffect(() => {
    if (!store) return;
    let cancelled = false; // StrictMode runs this twice in development: only one engine may run
    void (async () => {
      await store.migrate();
      const printer = await store.meta('printer');
      const savedUrl = await store.meta('api_url');
      const id = await store.meta('terminal_id');
      const credential = id ? await terminalSecret.get().catch(() => null) : null;
      if (cancelled) return;
      if (savedUrl) {
        setApiBase(savedUrl);
        setApiUrl(savedUrl);
      }
      if (printer) setPrinterTarget(JSON.parse(printer) as PrinterTarget);
      if (id && credential) await start(id, credential);
      else setMode('unconfigured');
    })();
    return () => {
      cancelled = true;
      engineRef.current?.stop();
    };
  }, [store, start]);

  const refresh = useCallback(async () => {
    if (engineRef.current) setStatus(await engineRef.current.status());
  }, []);

  useEffect(() => {
    if (!engine) return;
    void refresh();
    const s = setInterval(() => void refresh(), STATUS_MS);
    return () => clearInterval(s);
  }, [engine, refresh]);

  useEffect(() => {
    if (!engine) return;
    const p = setInterval(() => {
      engine.refreshSnapshot().then(() => setOnline(true), () => setOnline(false));
    }, online ? REFRESH_ONLINE_MS : PROBE_OFFLINE_MS);
    return () => clearInterval(p);
  }, [engine, online]);

  // Online, a cheap question every half minute: did anything the snapshot is made of change (an edit
  // in the back office, or a scheduled price taking effect)? Then fetch a new one at once (session 16).
  useEffect(() => {
    if (!engine || !online) return;
    const c = setInterval(() => {
      engine.snapshotOutdated().then(
        (outdated) => (outdated ? engine.refreshSnapshot().then(() => setOnline(true), () => setOnline(false)) : undefined),
        () => setOnline(false),
      );
    }, CHECK_ONLINE_MS);
    return () => clearInterval(c);
  }, [engine, online]);

  // A sync that got no answer means the API is unreachable too.
  useEffect(() => {
    if (status?.lastError?.startsWith('NETWORK')) setOnline(false);
    else if (status?.lastSyncAt && !status.lastError) setOnline(true);
  }, [status?.lastError, status?.lastSyncAt]);

  const setUp = useCallback(async (id: string, credential: string, url: string) => {
    const origin = normalizeApiUrl(url);
    if (!origin) throw Object.assign(new Error('Use an https:// server address'), { kind: 'INVALID_URL' });
    // Proves the address and the pair before keeping them: a wrong one is refused here, not at the first outage.
    await httpTransport({ baseUrl: origin, terminalId: id, credential }).snapshot();
    await terminalSecret.set(credential);
    await store!.setMeta('api_url', origin);
    setApiBase(origin);
    setApiUrl(origin);
    await store!.setMeta('terminal_id', id);
    await store!.setMeta('auth_state', 'OK');
    await start(id, credential);
  }, [store, start]);

  const forget = useCallback(async () => {
    engineRef.current?.stop();
    engineRef.current = null;
    await terminalSecret.clear();
    await store!.setMeta('terminal_id', null);
    setEngine(null);
    setStatus(null);
    setTerminalId(null);
    setMode('unconfigured');
  }, [store]);

  const setPrinter = useCallback(async (target: PrinterTarget | null) => {
    await store!.setMeta('printer', target ? JSON.stringify(target) : null);
    setPrinterTarget(target);
  }, [store]);

  const value = useMemo<Till>(() => {
    const channel = printerTarget ? tauriByteChannel(printerTarget) : null;
    return {
      mode, engine, status, online, terminalId, printerTarget, apiUrl,
      printer: channel ? escposPrinter(channel) : browserPrinter,
      drawer: channel ? escposDrawer(channel) : noDrawer,
      setUp, forget, setPrinter, refresh,
      snapshotStaff: async () => (store ? ((await store.snapshot())?.body.staff ?? []) : []),
      reportUnreachable: () => { if (engineRef.current) setOnline(false); },
      refreshSnapshot: async () => {
        const e = engineRef.current;
        if (!e) return;
        await e.refreshSnapshot().then(() => setOnline(true), () => setOnline(false));
        setStatus(await e.status());
      },
    };
  }, [store, mode, engine, status, online, terminalId, printerTarget, apiUrl, setUp, forget, setPrinter, refresh]);

  return <TillContext.Provider value={value}>{children}</TillContext.Provider>;
}
