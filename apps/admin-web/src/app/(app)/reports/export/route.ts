import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/config';
import { ACCESS_COOKIE, LANG_COOKIE } from '@/lib/cookies';
import { reportPath, reportRows, toCsv, type CsvReport } from '@/lib/report-csv';
import { translate, type MessageKey } from '@/i18n/messages';
import { REPORT_PATHS } from '../paths';

const REPORTS: readonly CsvReport[] = ['sales', 'products', 'cashiers', 'refunds', 'tenders', 'tax', 'statutory', 'category', 'branches', 'discounts', 'purchases', 'payments', 'promotions', 'attributes'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A report as a CSV download (GET, same origin). The API answers with the person's own access, so
 * this route adds nothing a page could not show; it only reshapes the JSON into rows.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const report = REPORTS.find((r) => r === q.get('report'));
  const branchId = q.get('branch') ?? '';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const pick = (k: string) => (DATE.test(q.get(k) ?? '') ? q.get(k)! : today);
  if (!report || !UUID.test(branchId)) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Unknown report' } }, { status: 404 });
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.redirect(new URL('/sign-in', request.url));

  // Sales by size and colour: the attribute ("Size") the report totals by; the API checks it.
  const attribute = (q.get('attribute') ?? '').trim().slice(0, 50) || undefined;
  const range = { branchId, from: pick('from'), to: pick('to'), attribute };
  const res = await fetch(`${API_URL}${reportPath(report, range)}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) {
    // Back to the report with the reason (a plain link, so the browser shows the page, not a JSON file).
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    const back = new URL(REPORT_PATHS[report], request.url);
    for (const [k, v] of Object.entries({ branch: branchId, from: range.from, to: range.to, ...(attribute && { attribute }) })) back.searchParams.set(k, v);
    back.searchParams.set('exportError', /^[A-Z_]{1,40}$/.test(body?.error?.code ?? '') ? body!.error!.code! : 'ERROR');
    return NextResponse.redirect(back, 303);
  }
  const lang = request.cookies.get(LANG_COOKIE)?.value === 'fil' ? 'fil' : 'en';
  const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars);
  const csv = toCsv(reportRows(report, await res.json(), t));
  const span = range.from === range.to ? range.from : `${range.from}_${range.to}`;
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="tilvara-${report}-${span}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
