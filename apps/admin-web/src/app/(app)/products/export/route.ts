import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/config';
import { ACCESS_COOKIE, LANG_COOKIE } from '@/lib/cookies';
import type { Category, CurrentPrice, PriceList, Product, TaxCategory, Uom } from '@/lib/api';
import { categoryTree } from '@/lib/categories';
import { COLUMNS, productExportRows } from '@/lib/product-csv';
import { productApiQuery, readProductFilters } from '@/lib/product-filters';
import { toCsv } from '@/lib/report-csv';
import { translate, type MessageKey } from '@/i18n/messages';

/** Pages of 200; a catalogue larger than this is cut (the file says nothing about it, so keep it far above any shop). */
const MAX_PAGES = 250;

/**
 * The products the list shows (same filters) as CSV, one row per variant, in the columns the import
 * reads. `?template=1`: the header only, to fill in. The API answers with the person's own access.
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.redirect(new URL('/sign-in', request.url));
  const lang = request.cookies.get(LANG_COOKIE)?.value === 'fil' ? 'fil' : 'en';
  const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const file = (csv: string, name: string) =>
    new NextResponse(csv, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' },
    });
  if (request.nextUrl.searchParams.get('template') === '1') return file(toCsv([COLUMNS.filter((c) => c.key !== 'status').map((c) => t(c.label))]), 'tilvara-products-template.csv');

  const get = async <T,>(path: string): Promise<{ ok: true; body: T } | { ok: false; res: NextResponse }> => {
    const res = await fetch(`${API_URL}${path}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (res.ok) return { ok: true, body: (await res.json()) as T };
    return { ok: false, res: NextResponse.json((await res.json().catch(() => null)) ?? { error: { code: 'ERROR', message: 'Export failed' } }, { status: res.status }) };
  };

  const filters = readProductFilters(Object.fromEntries(request.nextUrl.searchParams));
  const products: Product[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await get<{ data: Product[]; nextCursor: string | null }>(`/products?${productApiQuery(filters, { limit: 200, cursor })}`);
    if (!r.ok) return r.res;
    products.push(...r.body.data);
    if (!r.body.nextCursor) break;
    cursor = r.body.nextCursor;
  }
  const [cats, uoms, taxes, lists] = [
    await get<{ data: Category[] }>('/categories'),
    await get<{ data: Uom[] }>('/uoms'),
    await get<{ data: TaxCategory[] }>('/tax-categories'),
    await get<{ data: PriceList[] }>('/price-lists'),
  ];
  const defaultList = lists.ok ? lists.body.data.find((l) => l.isDefault && !l.archivedAt) : undefined;
  const prices = defaultList ? await get<{ data: CurrentPrice[] }>(`/price-lists/${defaultList.id}/prices`) : null;
  const rows = productExportRows(
    products,
    {
      categoryPath: new Map(cats.ok ? categoryTree(cats.body.data).map((r) => [r.category.id, r.path]) : []),
      unitCode: new Map(uoms.ok ? uoms.body.data.map((u) => [u.id, u.code]) : []),
      // The name the product form shows (VAT-able), which the import reads back; the code when two share a name.
      taxCode: new Map(
        taxes.ok
          ? taxes.body.data.map((x) => [x.id, taxes.body.data.filter((y) => y.name.trim().toLowerCase() === x.name.trim().toLowerCase()).length > 1 ? x.code : x.name])
          : [],
      ),
      price: new Map(prices?.ok ? prices.body.data.map((p) => [p.variantId, p.amount]) : []),
    },
    t,
  );
  return file(toCsv(rows), `tilvara-products-${today}.csv`);
}
