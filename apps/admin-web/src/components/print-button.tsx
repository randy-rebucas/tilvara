'use client';

import { Printer } from 'lucide-react';
import { useT } from '@/i18n/client';

/** The browser's print dialog, which also saves as PDF; the page's print styles keep only the report. */
export function PrintButton() {
  const { t } = useT();
  return (
    <button type="button" className="btn" onClick={() => window.print()}>
      <Printer aria-hidden className="size-4" /> {t('rep.print')}
    </button>
  );
}
