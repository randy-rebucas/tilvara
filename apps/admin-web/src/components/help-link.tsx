'use client';

import { CircleHelp } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import type { BusinessType } from '@/lib/business-type';
import { topicFor } from '@/lib/guide';

/** The band's help button: opens the user guide at the part about the page you are on. */
export function HelpLink({ businessType, features }: { businessType: BusinessType; features?: string[] }) {
  const { t } = useT();
  const path = usePathname();
  const here = path === '/help';
  return (
    <Link
      href={here ? '/help' : `/help#${topicFor(path, businessType, features)}`}
      title={t('guide.help')}
      aria-current={here ? 'page' : undefined}
      className={`grid size-8 shrink-0 place-items-center rounded-[4px] ${here ? 'bg-white/18 text-white' : 'text-blue-ink hover:bg-white/10 hover:text-white'}`}
    >
      <CircleHelp aria-hidden className="size-4.5" />
      <span className="sr-only">{t('guide.help')}</span>
    </Link>
  );
}
