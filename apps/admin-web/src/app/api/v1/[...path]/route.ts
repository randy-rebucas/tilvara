import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/config';
import { ACCESS_COOKIE } from '@/lib/cookies';
import { rejectCrossSite } from '@/lib/csrf';

/**
 * Same-origin proxy for client components: attaches the httpOnly bearer token server-side and
 * forwards to the API. Only an allow-listed set of resources is reachable through it. Accepting an
 * invitation goes through `/api/auth` (it sets the session cookies), never through here.
 */
const ALLOWED =
  /^(legal-entities|branches|registers|terminals|uoms|tax-categories|categories|products|variants|pack-conversions|barcodes|price-lists|promotions|members|roles|invitations(?!\/accept)|me|suppliers|supplier-items|customers|purchase-orders|goods-receipts|supplier-returns|supplier-invoices|supplier-payments(?:\/[0-9a-f-]{36}\/void)?|stock|accounts|journal-entries|accounting|kitchen-stations|dining-areas|restaurant-tables|modifier-groups|modifier-options|menus|menu-versions|sync\/transactions|support-access|api-keys|webhooks|webhook-deliveries|business|data-exports|data-export-files|sample-data|cashier-sessions\/[0-9a-f-]{36}\/approve-variance|service-staff|appointments)(\/|$)/;
/**
 * Lodging (ADR-0023), exact paths only: set-up, housekeeping, availability and the night audit, stays
 * with their registry, beneficiaries and deposits, and folio adjustments and night reversals. Folio
 * payments are not here: they are taken at the till, at an open drawer.
 */
const ID = '[0-9a-f-]{36}';
const LODGING = new RegExp(
  `^(room-types(\\/${ID})?|rooms(\\/${ID}(\\/status)?)?|room-blocks(\\/${ID})?|lodging\\/(availability|night-audit|housekeeping)` +
    `|stays(\\/${ID}(\\/(cancel|no-show|check-in|prepare-check-out|check-out|guests(\\/${ID})?|beneficiaries(\\/${ID})?|deposits(\\/(apply|refund|forfeit))?))?)?` +
    `|folios\\/${ID}\\/(adjustments|night-reversals))$`,
);
/**
 * Laundry (ADR-0024), exact paths only: settings, garment types, machines and runs, job orders with
 * their lines, items, status moves, cancel and disposal, down payments by bank transfer, loads on a
 * machine, and a trip's changes (PATCH), start, done, failed or cancel. The claim is not here: it is a sale, taken at the till at an open drawer.
 */
const LAUNDRY = new RegExp(
  `^(branches\\/${ID}\\/laundry-settings|laundry\\/(garment-types(\\/${ID})?|machines(\\/(${ID}|board))?|trips\\/${ID}(\\/(start|done|failed|cancel))?)|machine-runs\\/${ID}\\/stop` +
    `|job-orders(\\/(lookup|${ID}(\\/(lines|items|status|cancel|dispose|ticket|message|notices|machine-runs|trips|deposits(\\/refund)?))?))?)$`,
);
/**
 * Pharmacy (ADR-0025), exact paths only: recording and correcting a prescription, voiding one, the
 * pharmacy settings and a member's pharmacist licence. Lot holds and their release are under `stock`
 * (above). A pharmacist's approval at the till is not here: it is taken at the till.
 */
const PHARMACY = new RegExp(`^(prescriptions(\\/${ID}(\\/void)?)?|pharmacy\\/(settings|pharmacists\\/${ID}))$`);
/** DELETE reaches only these: a staff member's time off and a customer's service note (ADR-0022), a room block, a stay's guest or SC/PWD guest (ADR-0023). */
const DELETABLE = new RegExp(`^((service-staff\\/${ID}\\/time-off|customers\\/${ID}\\/notes)\\/${ID}|room-blocks\\/${ID}|stays\\/${ID}\\/(guests|beneficiaries)\\/${ID})$`);

async function forward(request: NextRequest, path: string[]) {
  const joined = path.join('/');
  if (!(ALLOWED.test(joined) || LODGING.test(joined) || LAUNDRY.test(joined) || PHARMACY.test(joined)) || path.some((p) => p === '..' || p.includes('\\')) || (request.method === 'DELETE' && !DELETABLE.test(joined))) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 });
  }
  if (request.method !== 'GET') {
    const refused = rejectCrossSite(request);
    if (refused) return refused;
  }
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Session expired' } }, { status: 401 });

  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const idem = request.headers.get('idempotency-key');
  if (idem) headers['idempotency-key'] = idem;
  const correlation = request.headers.get('x-correlation-id');
  if (correlation) headers['x-correlation-id'] = correlation;

  const res = await fetch(`${API_URL}/${joined}${request.nextUrl.search}`, {
    method: request.method,
    headers,
    body: request.method === 'GET' ? undefined : await request.text(),
    cache: 'no-store',
  });
  // Bytes, not text: a data export is a ZIP. Download headers pass through.
  const headersOut: Record<string, string> = { 'content-type': res.headers.get('content-type') ?? 'application/json' };
  for (const h of ['content-disposition', 'cache-control', 'content-length']) {
    const v = res.headers.get(h);
    if (v) headersOut[h] = v;
  }
  const body = res.status === 204 ? null : await res.arrayBuffer();
  return new NextResponse(body && body.byteLength > 0 ? body : null, { status: res.status, headers: headersOut });
}

type Ctx = { params: Promise<{ path: string[] }> };
export const GET = async (r: NextRequest, c: Ctx) => forward(r, (await c.params).path);
export const POST = async (r: NextRequest, c: Ctx) => forward(r, (await c.params).path);
export const PATCH = async (r: NextRequest, c: Ctx) => forward(r, (await c.params).path);
export const PUT = async (r: NextRequest, c: Ctx) => forward(r, (await c.params).path);
export const DELETE = async (r: NextRequest, c: Ctx) => forward(r, (await c.params).path);
