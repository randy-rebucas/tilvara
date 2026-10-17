import { Printer } from 'lucide-react';
import { useRef, useState } from 'react';
import { useT } from '../i18n';
import type { ReceiptPrinter } from '../lib/devices';
import { useTill } from '../lib/till';
import { receiptToPrintable, SETTLEMENT, signedTotal, TOTAL_LABELS } from '../lib/printing';
import type { Receipt as ReceiptData } from '../types';
import { Callout, Money } from './ui';

/**
 * The server's receipt document, rendered as-is. Its notice (e.g. "THIS IS NOT AN OFFICIAL
 * INVOICE") is always printed; the counter never adds or removes compliance wording.
 */
export function Receipt({ data, printer: given }: { data: ReceiptData; printer?: ReceiptPrinter }) {
  const { t } = useT();
  // The desktop till's thermal printer when one is set up; the browser print dialog otherwise.
  const till = useTill();
  const printer = given ?? till.printer;
  const ref = useRef<HTMLDivElement>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const print = async () => {
    if (!ref.current) return;
    setPrintError(null);
    try {
      await printer.print(ref.current, receiptToPrintable(data));
    } catch (e) {
      setPrintError((e as Error).message);
    }
  };
  const entries = Object.entries(data.totals).filter(([k]) => k !== 'currency' && k !== 'vatLabel');
  const totals = entries.filter(([k]) => !SETTLEMENT.includes(k));
  const settlement = SETTLEMENT.flatMap((k) => entries.filter(([e]) => e === k));
  return (
    <div className="grid content-start gap-3">
      <div ref={ref} className="printable note mx-auto w-full max-w-[420px] p-6 font-[family-name:var(--font-serial)] text-[0.875rem]">
        <header className="text-center">
          <p className="text-[1.0625rem] font-semibold">{data.seller.name}</p>
          <p>{data.seller.registeredName}</p>
          {data.seller.address && <p>{data.seller.address}</p>}
          {data.seller.tin && <p className="serial">{data.seller.tinLabel} {data.seller.tin}</p>}
          <p className="serial mt-2 font-semibold">{data.notice}</p>
        </header>
        <p className="serial mt-3 flex justify-between border-y border-dashed border-hair py-1">
          <span>{data.transaction.reference}</span>
          <span>{data.transaction.dateTime}</span>
        </p>
        <ul className="mt-2 grid gap-1">
          {data.lines.map((l, i) => (
            <li key={i}>
              <p className="flex justify-between gap-3">
                <span>{l.name}</span>
                <span className="money">{l.amount} {l.flag}</span>
              </p>
              <p className="text-muted">
                {l.quantity} × {l.unitPrice}
              </p>
            </li>
          ))}
          {/* Not an item (RA 11360): the service charge prints on its own line (ADR-0014 §9). */}
          {data.charges?.map((c) => (
            <li key={c.kind} className="flex justify-between gap-3">
              <span>{c.label}</span>
              <span className="money">{c.amount} {c.flag}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 grid gap-0.5 border-t border-dashed border-hair pt-2">
          {totals.map(([k, v]) => (
            <div key={k} className={`flex justify-between ${k === 'amountDue' ? 'text-[1rem] font-semibold' : ''}`}>
              <dt>{k === 'vatAmount' ? data.totals.vatLabel : (TOTAL_LABELS[k] ?? k)}</dt>
              <dd><Money value={signedTotal(k, v)} /></dd>
            </div>
          ))}
        </dl>
        <div className="mt-2 grid gap-0.5 border-t border-dashed border-hair pt-2">
          {data.tenders.map((tn, i) => (
            <p key={i} className="flex justify-between">
              <span>{tn.method}</span>
              <Money value={tn.amount} />
            </p>
          ))}
          {settlement.map(([k, v]) => (
            <p key={k} className={`flex justify-between ${k === 'change' ? 'font-semibold' : ''}`}>
              <span>{TOTAL_LABELS[k]}</span>
              <Money value={v} />
            </p>
          ))}
        </div>
        {data.statutory.map((s, i) => (
          <div key={i} className="mt-3 border-t border-dashed border-hair pt-2">
            <p>{s.label}: {s.name}</p>
            <p className="serial">ID {s.idNumber}</p>
            <p className="flex justify-between"><span>Discount</span><Money value={s.discount} /></p>
            {s.signatureLine && <p className="mt-6 border-t border-ink pt-1 text-center text-muted">{t('receipt.signature')}</p>}
          </div>
        ))}
        {data.legend && <p className="mt-3 text-muted">{data.legend}</p>}
        <p className="mt-3 text-center text-muted">{t('receipt.cashier')}: {data.transaction.cashier} · {data.transaction.register}</p>
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
