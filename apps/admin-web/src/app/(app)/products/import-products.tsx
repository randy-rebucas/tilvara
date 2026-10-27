'use client';

import { Download, Upload } from 'lucide-react';
import { useState } from 'react';
import { FormError } from '@/components/fields';
import { RecordTable } from '@/components/record-table';
import { Sheet } from '@/components/sheet';
import { useSubmit, type ValidationIssue } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import { peso } from '@/lib/format';
import { columnLabel, decodeCsvFile, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, parseCsvLines, readImport, type ImportProblem, type ImportRow } from '@/lib/product-csv';

type Action = 'CREATE' | 'ADD_VARIANT' | 'UPDATE' | 'UNCHANGED' | 'ERROR';
type Shift = { before: string | null; after: string };
interface PlanRow {
  line: number;
  sku: string;
  action: Action;
  changes: string[];
  errors: { code: string; message: string }[];
  values?: Partial<Record<'name' | 'category' | 'price', Shift>>;
  warnings?: { code: string; message: string; vars: Record<string, string> }[];
}
interface Plan { rows: PlanRow[]; summary: { products: number; variants: number; updated: number; unchanged: number; errors: number }; newCategories: string[] }
/** One line of the file and what it gets: the file's own problems (in the viewer's language) or the API's. */
interface Shown { line: number; sku: string; action: Action; notes: string[]; warnings: string[] }

/** Warnings the admin has words for (others show the API's message). */
const WARNINGS = new Set(['SKU_LEADING_ZEROS', 'BARCODE_LEADING_ZEROS']);

/** Rows listed under the summary; the rest are counted. */
const SHOWN = 100;

function ImportForm({ close }: { close: () => void }) {
  const { t } = useT();
  const { pending, submit, error, setError } = useSubmit();
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [shown, setShown] = useState<Shown[] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState<Plan['summary'] | null>(null);
  // One key per checked file: a retry after no answer replays the import instead of running it twice.
  const [key, setKey] = useState(() => crypto.randomUUID());

  const problemText = (p: ImportProblem) => t(p.key, { ...p.vars, col: p.col ? t(columnLabel(p.col)) : '' });
  const actionText = (a: Action) => t(`pio.act.${a}` as MessageKey);
  const warningText = (w: NonNullable<PlanRow['warnings']>[number]) => (WARNINGS.has(w.code) ? t(`pio.warn.${w.code}` as MessageKey, w.vars) : w.message);
  /** "Name: Cola → Cola Zero", "Price: ₱20.00 → ₱22.00": what the person checks by eye. */
  const shiftText = (field: 'name' | 'category' | 'price', v: Shift) => {
    const show = (x: string | null) => (x === null ? '—' : field === 'price' ? peso(x) : x);
    return t('pio.shift', { field: t(`pio.ch.${field}` as MessageKey), before: show(v.before), after: show(v.after) });
  };
  const tooLarge = () => t('pio.tooLarge', { max: IMPORT_MAX_ROWS });

  /** The API's answer as lines: refused rows first, then what changes. */
  function merge(source: ImportRow[], local: ImportProblem[], planned: Plan | null, invalid: { line: number; message: string }[] = []): Shown[] {
    const byLine = new Map<number, Shown>();
    const sku = (line: number) => source.find((r) => r.line === line)?.sku ?? '';
    for (const p of local) {
      const s = byLine.get(p.line) ?? { line: p.line, sku: p.sku, action: 'ERROR' as const, notes: [], warnings: [] };
      s.notes.push(problemText(p));
      byLine.set(p.line, s);
    }
    for (const r of planned?.rows ?? []) {
      const warnings = (r.warnings ?? []).map(warningText);
      if (r.action === 'UNCHANGED' && warnings.length === 0) continue;
      const shifts = (['name', 'category', 'price'] as const).flatMap((f) => (r.values?.[f] ? [shiftText(f, r.values[f])] : []));
      const plain = r.changes.filter((c) => !r.values?.[c as 'name']).map((c) => t(`pio.ch.${c}` as MessageKey));
      byLine.set(r.line, {
        line: r.line,
        sku: r.sku,
        action: r.action,
        notes: r.action === 'ERROR' ? r.errors.map((e) => e.message) : r.action === 'UPDATE' ? [...shifts, ...(plain.length ? [plain.join(', ')] : [])] : [],
        warnings,
      });
    }
    for (const i of invalid) {
      const s = byLine.get(i.line) ?? { line: i.line, sku: sku(i.line), action: 'ERROR' as const, notes: [], warnings: [] };
      s.action = 'ERROR';
      s.notes.push(i.message);
      byLine.set(i.line, s);
    }
    const order = (s: Shown) => (s.action === 'ERROR' ? 0 : 1);
    return [...byLine.values()].sort((a, b) => order(a) - order(b) || a.line - b.line);
  }

  async function check(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    setNotes([]);
    setShown(null);
    setPlan(null);
    setError(null);
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') {
      setMessage(t('pio.notCsv'));
      return;
    }
    const decoded = decodeCsvFile(await file.arrayBuffer());
    const parsed = parseCsvLines(decoded.text);
    const read = readImport(parsed.map((r) => r.cells), parsed.map((r) => r.line));
    if (read.missing.length) {
      setMessage(t('pio.missing', { cols: read.missing.map((k) => t(columnLabel(k))).join(', ') }));
      return;
    }
    const total = read.rows.length + new Set(read.problems.map((p) => p.line)).size;
    if (total > IMPORT_MAX_ROWS) {
      setMessage(t('pio.tooMany', { max: IMPORT_MAX_ROWS, n: total }));
      return;
    }
    if (total === 0) {
      setMessage(t('pio.empty'));
      return;
    }
    setNotes([
      ...(decoded.encoding === 'windows-1252' ? [t('pio.ansi')] : []),
      ...(read.unknown.length ? [t('pio.unknown', { cols: read.unknown.join(', ') })] : []),
      ...(read.archived ? [t('pio.archived', { n: read.archived })] : []),
    ]);
    setRows(read.rows);
    setKey(crypto.randomUUID());
    if (read.rows.length === 0) {
      setShown(merge(read.rows, read.problems, null));
      return;
    }
    // The API takes 2 MB at most: say so before sending, in the viewer's language.
    if (new TextEncoder().encode(JSON.stringify({ rows: read.rows })).length > IMPORT_MAX_BYTES) {
      setMessage(tooLarge());
      return;
    }
    const r = await submit<Plan>('POST', '/api/v1/products/import/preview', { rows: read.rows }, { refresh: false });
    if (r.ok) {
      setPlan(r.data);
      setShown(merge(read.rows, read.problems, r.data));
    } else if (r.error.code === 'VALIDATION_FAILED') {
      // A row the file check let through but the API's schema did not: `rows.<index>.<field>`.
      const issues = (r.error.details?.issues as ValidationIssue[] | undefined) ?? [];
      const invalid = issues.flatMap((i) => {
        const at = /^rows\.(\d+)\.?(.*)$/.exec(i.path);
        const row = at ? read.rows[Number(at[1])] : undefined;
        return row ? [{ line: row.line, message: `${at![2] || ''}${at![2] ? ': ' : ''}${i.message}` }] : [];
      });
      if (invalid.length) {
        setError(null);
        setShown(merge(read.rows, read.problems, null, invalid));
      }
    } else if (r.error.code === 'PAYLOAD_TOO_LARGE') {
      setError(null);
      setMessage(tooLarge());
    }
  }

  async function commit() {
    const r = await submit<Plan>('POST', '/api/v1/products/import', { rows }, { idempotencyKey: key });
    if (r.ok) setDone(r.data.summary);
    else if (r.error.code === 'IMPORT_INVALID') {
      // Something changed since the check (another person's edit): the rows that now fail.
      const failed = (r.error.details?.rows as PlanRow[] | undefined) ?? [];
      setShown(merge(rows, [], { rows: failed, summary: plan!.summary, newCategories: [] }));
      setPlan(null);
    } else if (r.error.code === 'PAYLOAD_TOO_LARGE') {
      setError(null);
      setMessage(tooLarge());
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="text-[0.9375rem]">{t('pio.done', { products: done.products, variants: done.variants, updated: done.updated })}</p>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={close}>{t('common.close')}</button>
        </div>
      </div>
    );
  }

  const localErrors = shown?.some((s) => s.action === 'ERROR') ?? false;
  const changing = plan ? plan.summary.products + plan.summary.variants + plan.summary.updated : 0;
  const ready = plan && !localErrors && plan.summary.errors === 0;
  return (
    <form onSubmit={check} className="form-grid" noValidate>
      <p className="form-lede">{t('pio.lede')}</p>
      <p className="form-lede">
        <a href="/products/export?template=1" download className="inline-flex items-center gap-1.5 underline">
          <Download aria-hidden className="size-4" /> {t('pio.template')}
        </a>
        <span className="hint mt-1 block">{t('pio.templateHint')}</span>
      </p>
      <div className="field">
        <label htmlFor="product-file">{t('pio.file')}</label>
        <input
          id="product-file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          className="input"
          aria-describedby="product-file-hint"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPlan(null);
            setShown(null);
            setMessage(null);
          }}
        />
        <p id="product-file-hint" className="hint">{t('pio.columnsHint')}</p>
      </div>
      <FormError message={message} />
      {notes.map((n) => <p key={n} className="form-lede text-muted">{n}</p>)}

      {plan && (
        <ul className="flex flex-wrap gap-2 text-[0.875rem]" role="status" aria-label={t('pio.what')}>
          <li className="tag">{t('pio.sum.products', { n: plan.summary.products })}</li>
          <li className="tag">{t('pio.sum.variants', { n: plan.summary.variants })}</li>
          <li className="tag">{t('pio.sum.updated', { n: plan.summary.updated })}</li>
          <li className="tag">{t('pio.sum.unchanged', { n: plan.summary.unchanged })}</li>
          {(shown?.some((s) => s.warnings.length > 0) ?? false) && <li className="tag">{t('pio.sum.warnings', { n: shown!.filter((s) => s.warnings.length > 0).length })}</li>}
          {(plan.summary.errors > 0 || localErrors) && <li className="tag border-red/40 text-red!">{t('pio.sum.errors', { n: shown?.filter((s) => s.action === 'ERROR').length ?? plan.summary.errors })}</li>}
        </ul>
      )}
      {plan && plan.newCategories.length > 0 && <p className="form-lede">{t('pio.newCategories', { list: plan.newCategories.join(', ') })}</p>}
      {shown && localErrors && <FormError message={t('pio.fixFirst')} />}
      {ready && changing === 0 && <p className="form-lede" role="status">{t('pio.nothing')}</p>}

      {shown && shown.length > 0 && (
        <div data-testid="import-rows">
          <RecordTable
            rows={shown.slice(0, SHOWN)}
            rowKey={(s) => String(s.line)}
            columns={[
              { header: t('pio.line'), num: true, cell: (s) => s.line },
              { header: t('prod.sku'), cell: (s) => <span className="font-mono text-[0.8125rem]">{s.sku}</span> },
              { header: t('pio.what'), cell: (s) => <span className={s.action === 'ERROR' ? 'font-semibold text-red' : ''}>{actionText(s.action)}</span> },
              { header: '', cell: (s) => <Notes s={s} /> },
            ]}
            stacked={{
              title: (s) => <span className={s.action === 'ERROR' ? 'text-red' : ''}>{t('pio.line')} {s.line} · {actionText(s.action)}</span>,
              meta: (s) => <><span className="font-mono">{s.sku}</span><span className="mt-1 block"><Notes s={s} /></span></>,
            }}
          />
          {shown.length > SHOWN && <p className="hint mt-2">{t('pio.moreRows', { n: shown.length - SHOWN })}</p>}
        </div>
      )}

      <div className="form-actions">
        {ready && changing > 0 ? (
          <button type="button" className="btn btn-primary" disabled={pending} onClick={commit}>
            {t('pio.go', { n: changing })}
          </button>
        ) : (
          <button className="btn btn-primary" disabled={pending || !file}>{pending ? t('pio.checking') : t('pio.check')}</button>
        )}
        {ready && changing > 0 && <button className="btn" disabled={pending}>{t('pio.check')}</button>}
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && error.code !== 'IMPORT_INVALID' ? error.message : null} />
      </div>
    </form>
  );
}

/** A row's notes (one per line), then its warnings. */
function Notes({ s }: { s: Shown }) {
  return (
    <span className="flex flex-col gap-0.5 text-[0.875rem]">
      {s.notes.map((n, i) => <span key={`n${i}`}>{n}</span>)}
      {s.warnings.map((w, i) => <span key={`w${i}`} className="font-semibold text-orange">⚠ {w}</span>)}
    </span>
  );
}

/** "Import CSV": a sheet that checks a file, shows what each row will do, then imports all of it. */
export function ImportProducts() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Upload aria-hidden className="size-4" /> {t('pio.import')}
      </button>
      <Sheet open={open} title={t('pio.import')} wide onClose={() => setOpen(false)}>
        <ImportForm close={() => setOpen(false)} />
      </Sheet>
    </>
  );
}
