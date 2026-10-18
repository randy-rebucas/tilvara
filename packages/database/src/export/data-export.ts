import type { PoolClient } from 'pg';
import type { Writable } from 'node:stream';
import { ZipWriter } from './zip.js';

/**
 * Tenant tables left out of a data export, with the reason (reviewed in rls-catalog.test.ts, which
 * also checks that the worker can read every other tenant table).
 */
export const EXPORT_EXCLUDED_TABLES: Record<string, string> = {
  idempotency_records: 'request replay cache, purged after a day; holds copies of API answers, not records',
  outbox_events: 'internal delivery queue of the worker',
  sequence_counters: 'next numbers of the document series; every document carries its own number',
};

/** Columns never exported (the worker has no grant on them either). */
export const EXPORT_SECRET_COLUMNS: Record<string, readonly string[]> = {
  terminals: ['credential_hash'],
  member_invitations: ['token_hash'],
};

export const EXPORT_FORMAT_VERSION = 1;

export interface ExportTable {
  name: string;
  columns: string[];
  hasId: boolean;
}

/** The tables and columns an export writes, from the system catalog (new tenant tables are included). */
export async function exportTables(client: Pick<PoolClient, 'query'>): Promise<ExportTable[]> {
  const { rows } = await client.query<{ name: string; columns: string[] }>(`
    SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attnum) AS columns
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)
     GROUP BY c.relname ORDER BY c.relname`);
  return rows
    .filter((r) => !(r.name in EXPORT_EXCLUDED_TABLES))
    .map((r) => {
      const secret = EXPORT_SECRET_COLUMNS[r.name] ?? [];
      return { name: r.name, columns: r.columns.filter((c) => !secret.includes(c)), hasId: r.columns.includes('id') };
    });
}

/** RFC 4180 field: NULL is an empty field, an empty string is `""`, anything with , " CR LF is quoted. */
export function csvField(v: string | null): string {
  if (v === null) return '';
  if (v === '' || /[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export const csvRow = (values: readonly (string | null)[]) => `${values.map(csvField).join(',')}\r\n`;

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const BOM = '﻿';
const FETCH = 2000;

/** One table as CSV, read through a cursor so memory stays flat. */
async function* tableCsv(client: PoolClient, t: ExportTable, counter: { rows: number }): AsyncGenerator<string> {
  yield BOM + csvRow(t.columns);
  const cursor = `export_${t.name}`;
  const cols = t.columns.map((c) => `${ident(c)}::text`).join(', ');
  await client.query(`DECLARE ${ident(cursor)} NO SCROLL CURSOR FOR SELECT ${cols} FROM ${ident(t.name)}${t.hasId ? ' ORDER BY id' : ''}`);
  try {
    for (;;) {
      const { rows } = await client.query<(string | null)[]>({ text: `FETCH ${FETCH} FROM ${ident(cursor)}`, rowMode: 'array' });
      if (rows.length === 0) break;
      counter.rows += rows.length;
      yield rows.map(csvRow).join('');
    }
  } finally {
    await client.query(`CLOSE ${ident(cursor)}`);
  }
}

export interface DataExportInfo {
  exportId: string;
  /** Who asked (shown in the README). */
  requestedBy: string | null;
}

export interface DataExportResult {
  rowCounts: Record<string, number>;
  generatedAt: string;
}

/**
 * Write a business's records as a ZIP of CSVs into `out`. The caller runs this inside
 * `withTenant(…, { isolation: 'REPEATABLE READ' })`, so every file comes from one snapshot and RLS
 * keeps it to that business. Row counts are taken first in the same snapshot and checked against
 * the rows written.
 */
export async function writeDataExport(client: PoolClient, out: Writable, info: DataExportInfo): Promise<DataExportResult> {
  await client.query(`SET LOCAL TimeZone = 'UTC'`);
  await client.query(`SET LOCAL DateStyle = 'ISO, YMD'`);
  await client.query(`SET LOCAL IntervalStyle = 'iso_8601'`);
  const { rows: [meta] } = await client.query<{ now: string; tenant_id: string | null }>(
    `SELECT to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now, current_setting('app.tenant_id', true) AS tenant_id`,
  );
  if (!meta?.tenant_id) throw new Error('writeDataExport needs a tenant context');
  const { rows: [business] } = await client.query<{ id: string; slug: string; name: string; status: string; timezone: string; default_currency: string }>(
    'SELECT id, slug, name, status, timezone, default_currency FROM tenants',
  );
  if (!business || business.id !== meta.tenant_id) throw new Error('the business is not visible in its own context');

  const tables = await exportTables(client);
  const rowCounts: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${ident(t.name)}`);
    rowCounts[t.name] = Number(rows[0]!.n);
  }
  const { rows: [members] } = await client.query<{ n: string }>('SELECT count(*) AS n FROM tenant_memberships');
  const memberCount = Number(members!.n);

  const zip = new ZipWriter(out, new Date(meta.now));
  const manifest = {
    format: 'tilvara-data-export',
    version: EXPORT_FORMAT_VERSION,
    exportId: info.exportId,
    business: { id: business.id, slug: business.slug, name: business.name, status: business.status, timezone: business.timezone, currency: business.default_currency },
    generatedAt: meta.now,
    files: [
      { name: 'members.csv', rows: memberCount },
      ...tables.map((t) => ({ name: `tables/${t.name}.csv`, table: t.name, rows: rowCounts[t.name], columns: t.columns })),
    ],
    excluded: { tables: EXPORT_EXCLUDED_TABLES, columns: EXPORT_SECRET_COLUMNS },
  };
  await zip.add('README.txt', [readme(business.name, meta.now, info, tables, rowCounts, memberCount)]);
  await zip.add('manifest.json', [`${JSON.stringify(manifest, null, 2)}\n`]);

  // People: the member list with names and emails (the user accounts themselves are not the business's).
  const memberCounter = { rows: 0 };
  await zip.add('members.csv', membersCsv(client, memberCounter));
  if (memberCounter.rows !== memberCount) throw new Error(`members: wrote ${memberCounter.rows} rows, counted ${memberCount}`);

  for (const t of tables) {
    const counter = { rows: 0 };
    await zip.add(`tables/${t.name}.csv`, tableCsv(client, t, counter));
    if (counter.rows !== rowCounts[t.name]) throw new Error(`${t.name}: wrote ${counter.rows} rows, counted ${rowCounts[t.name]}`);
  }
  await zip.finish();
  return { rowCounts: { members: memberCount, ...rowCounts }, generatedAt: meta.now };
}

async function* membersCsv(client: PoolClient, counter: { rows: number }): AsyncGenerator<string> {
  const header = ['membership_id', 'user_id', 'email', 'display_name', 'membership_status', 'joined_at'];
  yield BOM + csvRow(header);
  const { rows } = await client.query<(string | null)[]>({
    text: `SELECT m.id::text, m.user_id::text, u.email, u.display_name, m.status, m.created_at::text
             FROM tenant_memberships m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.created_at, m.id`,
    rowMode: 'array',
  });
  counter.rows = rows.length;
  yield rows.map(csvRow).join('');
}

function readme(
  businessName: string,
  generatedAt: string,
  info: DataExportInfo,
  tables: ExportTable[],
  rowCounts: Record<string, number>,
  memberCount: number,
): string {
  const lines = [
    `Tilvara data export — ${businessName}`,
    '',
    `Made ${generatedAt} (UTC) from one consistent snapshot of this business's records.`,
    info.requestedBy ? `Requested by ${info.requestedBy}. Export ${info.exportId}.` : `Export ${info.exportId}.`,
    '',
    'What is inside',
    '  members.csv            the people in this business: name, email, membership status',
    '  tables/<name>.csv      one file per table of records, every row and column of this business',
    '  manifest.json          the same list with row counts and column names, for programs',
    '',
    'How the files are written',
    '  - UTF-8 with a byte-order mark, comma-separated, lines end with CRLF, first line = column names (RFC 4180).',
    '  - Values are exactly as stored. Amounts and quantities are decimal text (e.g. 120.5000), never rounded.',
    '  - Times are UTC, ISO 8601 (2026-10-18 04:00:00.123+00). Business days are local dates (YYYY-MM-DD).',
    '  - An empty field is "no value" (NULL); "" is an empty text. JSON columns hold JSON text.',
    '  - Ids are UUIDs and link the files together (e.g. sale_lines.sale_id = sales.id).',
    '  - Cells are not altered for spreadsheets: a value that begins with = + - or @ is kept as it is.',
    '    When opening in a spreadsheet, import the columns as text.',
    '',
    'Left out on purpose',
    ...Object.entries(EXPORT_EXCLUDED_TABLES).map(([t, why]) => `  ${t}: ${why}`),
    ...Object.entries(EXPORT_SECRET_COLUMNS).map(([t, cols]) => `  ${t}.${cols.join(', ')}: secret credential hashes`),
    '  Passwords, two-step sign-in secrets and sessions belong to each person\'s account, not to the business.',
    '',
    'Row counts',
    `  members.csv: ${memberCount}`,
    ...tables.map((t) => `  ${t.name}: ${rowCounts[t.name]}`),
    '',
    'This file holds personal data (names, emails, IDs of SC/PWD customers). Keep it private.',
    'Tilvara receipts are not BIR invoices; this export is a copy of records, not a BIR-accredited e-journal.',
    '',
  ];
  return lines.join('\r\n');
}
