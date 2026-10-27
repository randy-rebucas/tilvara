import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/config';
import { ACCESS_COOKIE, LANG_COOKIE } from '@/lib/cookies';
import { toCsv } from '@/lib/report-csv';
import { translate, type MessageKey } from '@/i18n/messages';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Line { entryNumber: number; entryDate: string; sourceType: string; memo: string | null; accountCode: string; accountName: string; branchCode: string | null; debit: string; credit: string }

/** The journal of one legal entity as CSV, one row per line (for the accountant's own system). */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const entity = q.get('entity') ?? '';
  const from = q.get('from') ?? '';
  const to = q.get('to') ?? '';
  if (!UUID.test(entity) || !DATE.test(from) || !DATE.test(to)) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Choose an entity and a date range' } }, { status: 404 });
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.redirect(new URL('/sign-in', request.url));
  const res = await fetch(`${API_URL}/journal-lines?legalEntityId=${entity}&from=${from}&to=${to}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) {
    // Back to the journal with the reason (a plain link, so the browser shows the page, not a JSON file).
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    const code = body?.error?.code ?? '';
    const back = new URL('/books', request.url);
    back.searchParams.set('entity', entity);
    back.searchParams.set('exportError', /^[A-Z_]{1,40}$/.test(code) ? code : 'ERROR');
    return NextResponse.redirect(back, 303);
  }
  const lang = request.cookies.get(LANG_COOKIE)?.value === 'fil' ? 'fil' : 'en';
  const t = (key: MessageKey) => translate(lang, key);
  const { data } = (await res.json()) as { data: Line[] };
  const csv = toCsv([
    [t('books.entry'), t('common.date'), t('books.source'), t('books.memo'), t('books.accountCode'), t('books.account'), t('common.branch'), t('books.debit'), t('books.credit')],
    ...data.map((l) => [l.entryNumber, l.entryDate, t(`src.${l.sourceType}` as MessageKey), l.memo ?? '', l.accountCode, l.accountName, l.branchCode ?? '', l.debit, l.credit]),
  ]);
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="tilvara-journal-${from}_${to}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
