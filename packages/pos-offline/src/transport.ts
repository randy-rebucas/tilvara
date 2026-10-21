import type { CatalogVersion, KitchenStationsResponse, KitchenTicketPrint, OfflineSale, Snapshot, SnapshotItemsPage, SyncSalesResponse } from '@1pos/sync-protocol';
import { SNAPSHOT_PAGE_SIZE, TERMINAL_AUTH_SCHEME, TERMINAL_ID_HEADER } from '@1pos/sync-protocol';

/** How the engine reaches the server. Swappable so drills can lose answers or take the server away. */
export interface Transport {
  snapshot(): Promise<Snapshot>;
  syncSales(sales: OfflineSale[]): Promise<SyncSalesResponse>;
  /** The server's catalog version (session 16); absent in transports for older servers and some tests. */
  catalogVersion?(): Promise<CatalogVersion>;
  /** Kitchen printing (session 25): the branch's stations, the next tickets to print, and how printing went. */
  kitchenStations?(): Promise<KitchenStationsResponse>;
  claimKitchenTickets?(stationIds: string[]): Promise<{ data: KitchenTicketPrint[] }>;
  settleKitchenPrint?(ticketId: string, outcome: 'printed' | 'release'): Promise<unknown>;
}

/**
 * Why a call failed. NETWORK means no answer (refused, dropped, timed out): the outcome is unknown and
 * the same envelopes are sent again later. HTTP carries the server's status and error code.
 */
export class TransportError extends Error {
  constructor(
    readonly kind: 'NETWORK' | 'HTTP',
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }

  /** Worth retrying with the same envelopes: no answer, a 5xx, or a rate limit. */
  get retryable() {
    return this.kind === 'NETWORK' || (this.status !== undefined && (this.status >= 500 || this.status === 429));
  }
}

export interface HttpTransportOptions {
  baseUrl: string;
  terminalId: string;
  credential: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The API's terminal routes over HTTP (ADR-0015 §2): `X-Terminal-Id` + `Authorization: Terminal <credential>`. */
export function httpTransport(o: HttpTransportOptions): Transport {
  const doFetch = o.fetch ?? fetch;
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${o.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          [TERMINAL_ID_HEADER]: o.terminalId,
          authorization: `${TERMINAL_AUTH_SCHEME} ${o.credential}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new TransportError('NETWORK', `No answer from the server: ${(e as Error).message}`);
    }
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (!res.ok) {
      throw new TransportError('HTTP', data?.error?.message ?? `HTTP ${res.status}`, res.status, data?.error?.code);
    }
    if (data === null) throw new TransportError('NETWORK', 'The server answered without a body');
    return data as T;
  };
  return {
    // Paged (ADR-0016 slice 5): every answer stays bounded however large the catalogue; the pages are
    // put together here, so the engine still stores one snapshot. A failed page fails the whole
    // refresh and the till keeps the snapshot it had.
    snapshot: async () => {
      const first = await call<Snapshot>('GET', `/v1/terminal/snapshot?pageSize=${SNAPSHOT_PAGE_SIZE}`);
      const items = [...first.items];
      for (let after = first.nextPage ?? null; after; ) {
        const page = await call<SnapshotItemsPage>(
          'GET',
          `/v1/terminal/snapshot/${first.snapshotId}/items?pageSize=${SNAPSHOT_PAGE_SIZE}&after=${encodeURIComponent(after)}`,
        );
        items.push(...page.items);
        after = page.nextPage;
      }
      const { nextPage: _next, ...whole } = first;
      return { ...whole, items };
    },
    syncSales: (sales) => call<SyncSalesResponse>('POST', '/v1/sync/sales', { sales }),
    catalogVersion: () => call<CatalogVersion>('GET', '/v1/terminal/catalog-version'),
    kitchenStations: () => call<KitchenStationsResponse>('GET', '/v1/terminal/kitchen-stations'),
    claimKitchenTickets: (stationIds) => call<{ data: KitchenTicketPrint[] }>('POST', '/v1/terminal/kitchen-tickets/claim', { stationIds }),
    settleKitchenPrint: (ticketId, outcome) => call<unknown>('POST', `/v1/terminal/kitchen-tickets/${encodeURIComponent(ticketId)}/${outcome}`, {}),
  };
}
