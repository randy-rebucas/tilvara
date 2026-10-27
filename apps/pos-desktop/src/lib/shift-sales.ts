import { api } from './api';
import type { SaleSummary } from '../types';

/** All sales of a shift, newest first, page after page (a short page with a cursor only means "look further"). */
export async function shiftSales(sessionId: string, get: typeof api = api): Promise<SaleSummary[]> {
  const all: SaleSummary[] = [];
  let cursor: string | null = null;
  // Bounded, so a server that kept answering with a cursor could not loop forever (100 × 200 sales).
  for (let page = 0; page < 100; page++) {
    const r: { data: SaleSummary[]; nextCursor?: string | null } = await get('GET', `/v1/sales?cashierSessionId=${sessionId}&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    all.push(...r.data);
    cursor = r.nextCursor ?? null;
    if (!cursor) break;
  }
  return all;
}
