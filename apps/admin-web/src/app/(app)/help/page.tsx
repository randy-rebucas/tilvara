import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Note, PageHeader } from '@/components/note';
import { getT } from '@/i18n/server';
import { api, type Me } from '@/lib/api';
import { POS_URL } from '@/lib/config';
import { guideFor, type GuideTopic } from '@/lib/guide';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('help');

/** Where a section's "Open …" button goes when it is not one of the band's tabs. */
const OWN_PAGE: Partial<Record<GuideTopic, string>> = { start: '/', account: '/account' };

/**
 * The user guide: every area the business offers, in set-up order. Areas the person's role does
 * not open are still explained (marked), so a cashier can see what a manager does.
 */
export default async function HelpPage() {
  const me = await api<Me>('/me');
  const { t } = await getT();
  const tenant = me.activeTenant!;
  const sections = guideFor(tenant.businessType, tenant.permissions);

  const openHref = (id: GuideTopic, areaHref: string | undefined) => (id === 'till' ? POS_URL : (areaHref ?? OWN_PAGE[id] ?? null));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('guide.title')} lede={t('guide.lede')} />
      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* Contents: a wrapped list on top below lg, a sticky column beside the sections from lg. */}
        <nav aria-label={t('guide.contents')} className="lg:sticky lg:top-24 lg:self-start">
          <h2 className="section-title mb-2">{t('guide.contents')}</h2>
          <ol className="flex flex-wrap gap-x-4 gap-y-1.5 text-[0.9375rem] lg:flex-col lg:gap-y-1">
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-blue hover:underline">
                  {t(s.title)}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex min-w-0 flex-col gap-5">
          {sections.map((s) => {
            const href = openHref(s.id, s.href ?? s.area?.href);
            return (
              <Note key={s.id} id={s.id} denom={s.denom} className="scroll-mt-24 px-5 py-4 pr-8" as="article">
                <h2 className="text-[1.0625rem] font-semibold">{t(s.title)}</h2>
                <p className="mt-1 max-w-[68ch] text-muted">{t(s.lede)}</p>
                {!s.permitted && (
                  <p className="mt-2">
                    <span className="tag">{t('guide.notInRole')}</span>
                  </p>
                )}
                <ol className="mt-3 flex max-w-[72ch] list-decimal flex-col gap-1.5 pl-5 marker:font-semibold marker:text-muted">
                  {s.steps.map((l) => (
                    <li key={l.key}>{t(l.key)}</li>
                  ))}
                </ol>
                {s.tips.length > 0 && (
                  <>
                    <h3 className="section-title mt-4 mb-1.5">{t('guide.tips')}</h3>
                    <ul className="flex max-w-[72ch] list-disc flex-col gap-1 pl-5 text-[0.9375rem] marker:text-muted">
                      {s.tips.map((l) => (
                        <li key={l.key}>{t(l.key)}</li>
                      ))}
                    </ul>
                  </>
                )}
                {href && s.permitted && (
                  <Link href={href} className="btn mt-4">
                    {s.id === 'till' ? t('guide.openTill') : t('guide.open', { area: t(s.title) })}
                    <ChevronRight aria-hidden className="size-4" />
                  </Link>
                )}
              </Note>
            );
          })}
        </div>
      </div>
    </div>
  );
}
