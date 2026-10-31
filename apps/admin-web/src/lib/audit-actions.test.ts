import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en, fil } from '../i18n/messages';

/**
 * Every action the business's audit log can show has words (`audit.action.<code>`, EN and FIL).
 * The actions are collected from where rows are written: `audit(db, auth, '<action>', …)` /
 * `recordAudit(db, { action: '<action>' })` / `tenantAudit(…, '<action>', …)` in the API, and
 * `INSERT INTO audit_logs … VALUES (<tenant>, …, '<action>', …)` in the SQL migrations.
 */
const ROOT = resolve(__dirname, '../../../..');
const API_SRC = join(ROOT, 'apps/api/src');
const MIGRATIONS = join(ROOT, 'packages/database/drizzle');
const ACTION = /^[a-z_]+\.[a-z_]+$/;

/** Actions built at run time (template literals): each code they can produce. */
const DYNAMIC: Record<string, string[]> = {
  'cash.${input.type.toLowerCase()}': ['cash.pay_in', 'cash.pay_out'],
  'payment.${outcome.status.toLowerCase()}': ['payment.succeeded', 'payment.failed'],
  'purchase_order.${verb}': ['purchase_order.cancelled', 'purchase_order.closed'],
  "member.${action === 'remove' ? 'removed' : action === 'suspend' ? 'suspended' : 'reactivated'}": ['member.removed', 'member.suspended', 'member.reactivated'],
};

/** Literals the scan picks up that are not actions of the business's log, with the reason. */
const NOT_ACTIONS: Record<string, string> = {
  'app.tenant_id': 'a setting read inside the statement',
  'app.user_id': 'a setting read inside the statement',
  'app.correlation_id': 'a setting read inside the statement',
};

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return path.endsWith(ext) && !path.endsWith(`.test${ext}`) ? [path] : [];
  });
}

/** The text of the call starting at `open` (the index of its "("), up to the matching ")". */
function callBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Splits an argument list at its top-level commas. */
function topLevelArgs(body: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === quote && body[i - 1] !== '\\') quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      args.push(body.slice(start, i));
      start = i + 1;
    }
  }
  args.push(body.slice(start));
  return args.map((a) => a.trim());
}

function literals(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/'([^'\n]*)'|`([^`]*)`/g)) {
    const value = m[1] ?? m[2]!;
    if (m[2] !== undefined && value.includes('${')) {
      const expanded = DYNAMIC[value];
      if (!expanded) throw new Error(`An audit action is built at run time and not listed in DYNAMIC: \`${value}\``);
      out.push(...expanded);
    } else if (ACTION.test(value)) out.push(value);
  }
  return out;
}

function apiActions(): Set<string> {
  const found = new Set<string>();
  for (const path of files(API_SRC, '.ts')) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/\b(audit|recordAudit|tenantAudit)\(/g)) {
      const before = src.slice(Math.max(0, m.index - 30), m.index);
      if (/(function|async|protected|private)\s*$/.test(before)) continue; // the definition
      const args = topLevelArgs(callBody(src, m.index + m[0].length - 1));
      let actionArg: string | undefined;
      if (m[1] === 'audit') actionArg = args[2];
      else if (m[1] === 'tenantAudit') actionArg = args[2];
      else actionArg = /\baction:\s*([^,\n]+)/.exec(args[1] ?? '')?.[1];
      if (actionArg) for (const a of literals(actionArg)) found.add(a);
    }
  }
  return found;
}

/**
 * The rows the migrations insert into a business's audit log: each `( … )` after `VALUES` in an
 * `INSERT INTO audit_logs` (the whole statement when it inserts a SELECT), leaving out the rows whose
 * tenant is NULL: an account or platform event outside any business, even in a statement that also
 * writes a business's row (`platform_change_subscription`, migration 0137).
 */
function tenantRows(src: string): string[] {
  const rows: string[] = [];
  for (const m of src.matchAll(/INSERT INTO audit_logs\b[\s\S]*?;/gi)) {
    const stmt = m[0];
    const values = /\bVALUES\s*\(/i.exec(stmt);
    if (!values) {
      rows.push(stmt);
      continue;
    }
    let i = values.index + values[0].length - 1;
    while (stmt[i] === '(') {
      const body = callBody(stmt, i);
      if (!/^NULL$/i.test(topLevelArgs(body)[0] ?? '')) rows.push(body);
      i += body.length + 2;
      const next = /^\s*,\s*/.exec(stmt.slice(i));
      if (!next) break;
      i += next[0].length;
    }
  }
  return rows;
}

function sqlActions(): Set<string> {
  const found = new Set<string>();
  for (const path of files(MIGRATIONS, '.sql')) {
    for (const row of tenantRows(readFileSync(path, 'utf8'))) for (const a of literals(row)) if (!(a in NOT_ACTIONS)) found.add(a);
  }
  return found;
}

describe('audit log actions', () => {
  const actions = [...new Set([...apiActions(), ...sqlActions()])].sort();

  it('finds the actions where rows are written', () => {
    // A sanity floor: the scan must keep seeing the writers (a refactor that hides them fails here).
    expect(actions).toEqual(expect.arrayContaining(['sale.completed', 'tenant.branding_updated', 'billing.bill_paid', 'data_export.expired']));
    expect(actions.length).toBeGreaterThan(100);
  });

  it('words every action in English and Filipino', () => {
    const missing = actions.filter((a) => !(`audit.action.${a}` in en) || !(fil as Record<string, string>)[`audit.action.${a}`]);
    expect(missing).toEqual([]);
  });
});

/**
 * The details of the rows the business cannot trace to a person of its own (billing, subscription,
 * data export): every key they write has words (`audit.key.<key>`), and every reason code
 * (`'PAID_UNTIL_REACHED'`) has words (`audit.reason.<code>`), in English and Filipino (audit 2026-10-31 #25).
 */
const WORDED_FAMILIES = /^(billing|subscription|data_export)\./;
const worded = (key: string) => key in en && !!(fil as Record<string, string>)[key];

function sqlDetails(): { keys: Set<string>; reasons: Set<string> } {
  const keys = new Set<string>();
  const reasons = new Set<string>();
  for (const path of files(MIGRATIONS, '.sql')) {
    const src = readFileSync(path, 'utf8');
    // The codes a function turns older words into (`billing_reason_code`, migration 0137).
    for (const f of src.matchAll(/FUNCTION billing_reason_code\b[\s\S]*?\$\$;/gi)) for (const r of f[0].matchAll(/THEN '([A-Z][A-Z_]+)'/g)) reasons.add(r[1]!);
    for (const row of tenantRows(src)) {
      if (!literals(row).some((a) => WORDED_FAMILIES.test(a))) continue;
      for (const b of row.matchAll(/jsonb_build_object\(/gi)) {
        const args = topLevelArgs(callBody(row, b.index + b[0].length - 1));
        for (let i = 0; i + 1 < args.length; i += 2) {
          const key = /^'([A-Za-z]\w*)'$/.exec(args[i]!)?.[1];
          if (!key) continue;
          keys.add(key);
          if (key === 'reason') for (const r of args[i + 1]!.matchAll(/'([A-Z][A-Z_]+)'/g)) reasons.add(r[1]!);
        }
      }
    }
  }
  return { keys, reasons };
}

function apiDetailKeys(): Set<string> {
  const keys = new Set<string>();
  for (const path of files(API_SRC, '.ts')) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/\baudit\(/g)) {
      const before = src.slice(Math.max(0, m.index - 30), m.index);
      if (/(function|async|protected|private)\s*$/.test(before)) continue;
      const args = topLevelArgs(callBody(src, m.index + m[0].length - 1));
      if (!literals(args[2] ?? '').some((a) => WORDED_FAMILIES.test(a))) continue;
      const meta = args[5]?.trim();
      if (!meta?.startsWith('{')) continue;
      for (const k of meta.slice(1, -1).matchAll(/(?:^|,)\s*([A-Za-z]\w*)\s*(?=[:,]|$)/g)) keys.add(k[1]!);
    }
  }
  return keys;
}

describe('audit log details of billing, subscription and data export rows', () => {
  const sql = sqlDetails();
  const keys = [...new Set([...sql.keys, ...apiDetailKeys()])].sort();

  it('finds the details where rows are written', () => {
    expect(keys).toEqual(expect.arrayContaining(['fromPlan', 'periodEnd', 'number', 'sizeBytes', 'effect']));
  });

  it('words every key in English and Filipino', () => {
    expect(keys.filter((k) => !worded(`audit.key.${k}`))).toEqual([]);
  });

  it('words every reason code in English and Filipino', () => {
    expect([...sql.reasons].sort().filter((r) => !worded(`audit.reason.${r}`))).toEqual([]);
  });
});
