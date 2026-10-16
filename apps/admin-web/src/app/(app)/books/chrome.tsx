import type { ReactNode } from 'react';
import { Callout, Empty, Note, PageHeader } from '@/components/note';
import { ScopePicker, SubNav } from '@/components/scope';
import { apiOrNull, type LegalEntity } from '@/lib/api';
import { getT } from '@/i18n/server';

export type BooksTab = 'journal' | 'trial' | 'accounts' | 'periods';
const PATHS: Record<BooksTab, string> = { journal: '/books', trial: '/books/trial-balance', accounts: '/books/accounts', periods: '/books/periods' };

/** Books are per legal entity: the active entities, and the one the page works on (?entity=). */
export async function booksEntity(param: string | undefined) {
  const list = await apiOrNull<{ data: LegalEntity[] }>('/legal-entities');
  const entities = list?.data.filter((e) => !e.archivedAt) ?? [];
  return { entities, entity: entities.find((e) => e.id === param) ?? entities[0] };
}

/** Where a journal entry came from: the document page, when the admin has one. */
export function sourceHref(e: { sourceType: string; sourceId: string | null; reversesEntryId: string | null }, entityId: string): string | null {
  if (e.sourceType === 'REVERSAL' && e.reversesEntryId) return `/books/entries/${e.reversesEntryId}?entity=${entityId}`;
  if (!e.sourceId) return null;
  switch (e.sourceType) {
    case 'GOODS_RECEIPT': return `/purchasing/receipts/${e.sourceId}`;
    case 'TRANSFER_DISPATCH':
    case 'TRANSFER_RECEIPT': return `/inventory/transfers/${e.sourceId}`;
    case 'STOCK_COUNT': return `/inventory/counts/${e.sourceId}`;
    default: return null;
  }
}

export async function BooksChrome({ tab, entities, entity, children }: { tab: BooksTab; entities: LegalEntity[]; entity: LegalEntity | undefined; children: ReactNode }) {
  const { t } = await getT();
  const q = entity ? `?entity=${entity.id}` : '';
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('books.title')} lede={t('books.lede')} />
      <Callout>{t('books.review')}</Callout>
      <SubNav
        label={t('common.sections')}
        active={tab}
        items={[
          { key: 'journal', href: `${PATHS.journal}${q}`, label: t('books.tab.journal') },
          { key: 'trial', href: `${PATHS.trial}${q}`, label: t('books.tab.trial') },
          { key: 'accounts', href: `${PATHS.accounts}${q}`, label: t('books.tab.accounts') },
          { key: 'periods', href: `${PATHS.periods}${q}`, label: t('books.tab.periods') },
        ]}
      />
      <ScopePicker label={t('loc.entityOne')} items={entities.map((e) => ({ id: e.id, name: e.registeredName }))} selected={entity?.id} href={(id) => `${PATHS[tab]}?entity=${id}`} />
      {entity ? children : <Note><Empty>{t('books.noEntity')}</Empty></Note>}
    </div>
  );
}
