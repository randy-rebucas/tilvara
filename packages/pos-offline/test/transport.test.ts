import type { Snapshot, SnapshotItem } from '@1pos/sync-protocol';
import { SNAPSHOT_PAGE_SIZE } from '@1pos/sync-protocol';
import { describe, expect, it } from 'vitest';
import { httpTransport, TransportError } from '../src/index.js';

const item = (n: number): SnapshotItem => ({
  variantId: `v${n}`, sku: `S${String(n).padStart(5, '0')}`, name: `Item ${n}`, barcodes: [], priceId: `p${n}`, priceListId: 'l1',
  unitPrice: '10.0000', priceIncludesTax: true, vatTreatment: 'VATABLE', taxCategoryCode: 'VAT', wholeUnits: true, trackInventory: true,
});
const header: Omit<Snapshot, 'items'> = {
  snapshotId: 'snap-1', asOf: '2026-10-17T00:00:00.000Z', validUntil: '2026-10-18T00:00:00.000Z',
  terminal: { id: 't1', name: 'Till 1', credentialHint: 'AbCd' }, register: { id: 'r1', code: 'R1', name: 'Front' },
  branch: { id: 'b1', code: 'B1', name: 'Cubao', timezone: 'Asia/Manila' },
  legalEntity: { id: 'le', registeredName: 'Nena Trading', tradeName: null, tin: null, receiptTin: null }, currency: 'PHP',
  taxProfile: { id: 'tp', effectiveFrom: '2026-01-01T00:00:00.000Z', vatStatus: 'VAT', vatRate: '0.12', roundingMode: 'HALF_UP' }, openSession: null,
};

/** A server with `total` items, answering pages the way the API does (cursor = index of the next item). */
function pagedServer(total: number, failAtPage?: number) {
  const all = Array.from({ length: total }, (_, i) => item(i));
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    const size = Number(url.searchParams.get('pageSize'));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/terminal/snapshot') {
      return json({ ...header, items: all.slice(0, size), nextPage: total > size ? String(size) : null });
    }
    if (failAtPage !== undefined && urls.length - 1 === failAtPage) return json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'down' } }, 503);
    const from = Number(url.searchParams.get('after'));
    return json({ snapshotId: header.snapshotId, items: all.slice(from, from + size), nextPage: from + size < total ? String(from + size) : null });
  };
  return { all, urls, fetchFn };
}

describe('snapshot over HTTP (paged, ADR-0016 slice 5)', () => {
  it('asks for pages and hands the engine one whole snapshot', async () => {
    const s = pagedServer(2 * SNAPSHOT_PAGE_SIZE + 17);
    const snap = await httpTransport({ baseUrl: 'http://api.test/', terminalId: 't1', credential: 'c', fetch: s.fetchFn }).snapshot();
    expect(snap.items).toEqual(s.all);
    expect(snap).not.toHaveProperty('nextPage');
    expect(snap.snapshotId).toBe('snap-1');
    expect(s.urls).toEqual([
      `/v1/terminal/snapshot?pageSize=${SNAPSHOT_PAGE_SIZE}`,
      `/v1/terminal/snapshot/snap-1/items?pageSize=${SNAPSHOT_PAGE_SIZE}&after=${SNAPSHOT_PAGE_SIZE}`,
      `/v1/terminal/snapshot/snap-1/items?pageSize=${SNAPSHOT_PAGE_SIZE}&after=${2 * SNAPSHOT_PAGE_SIZE}`,
    ]);
  });

  it('a small catalogue takes one request', async () => {
    const s = pagedServer(3);
    expect((await httpTransport({ baseUrl: 'http://api.test', terminalId: 't1', credential: 'c', fetch: s.fetchFn }).snapshot()).items).toHaveLength(3);
    expect(s.urls).toHaveLength(1);
  });

  it('a failed page fails the whole refresh (the till keeps its previous snapshot), retryably', async () => {
    const s = pagedServer(3 * SNAPSHOT_PAGE_SIZE, 2);
    const err = await httpTransport({ baseUrl: 'http://api.test', terminalId: 't1', credential: 'c', fetch: s.fetchFn }).snapshot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect([(err as TransportError).status, (err as TransportError).retryable]).toEqual([503, true]);
  });
});
