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

function sqlActions(): Set<string> {
  const found = new Set<string>();
  for (const path of files(MIGRATIONS, '.sql')) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/INSERT INTO audit_logs\b[\s\S]*?;/gi)) {
      const values = /\bVALUES\s*\(\s*([^,]+)/i.exec(m[0]);
      if (values && /^NULL$/i.test(values[1]!.trim())) continue; // an account event outside any business
      for (const a of literals(m[0])) if (!(a in NOT_ACTIONS)) found.add(a);
    }
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
