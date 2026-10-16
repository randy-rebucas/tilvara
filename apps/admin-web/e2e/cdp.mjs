// Minimal Chrome DevTools Protocol harness shared by the E2E smoke test and the review
// capture pass. Drives a locally installed Edge/Chrome (no Playwright download needed here).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openBrowser({ base, out, port = 9333 }) {
  const exe = BROWSERS.find((b) => existsSync(b));
  if (!exe) throw new Error('No Edge/Chrome found');
  mkdirSync(out, { recursive: true });

  const browser = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), '1pos-e2e-'))}`,
    '--no-first-run', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { await sleep(200); }
  }
  if (!target) throw new Error('browser did not start');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result.value;
  };
  const viewport = (width, height, mobile = false) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  async function waitFor(expr, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expr})`).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error(`timeout waiting for: ${expr}`);
  }
  async function go(path) {
    await send('Page.navigate', { url: base + path });
    await waitFor(`document.readyState === 'complete'`);
    await sleep(400);
  }
  /** Fill a React-controlled input by name (the visible one, if a hidden view has the same name). */
  const fill = (name, value) => evaluate(`(() => {
    const all = [...document.querySelectorAll('[name="${name}"]')];
    const el = all.find((x) => x.getClientRects().length) ?? all[0];
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const clickText = (text) => evaluate(`(() => {
    // Prefer a visible match: the POS keeps the Sell view mounted (hidden) behind other tabs.
    const all = [...document.querySelectorAll('button, a, summary')].filter((x) => x.textContent.trim().includes(${JSON.stringify(text)}));
    const b = all.find((x) => x.getClientRects().length) ?? all[0];
    if (!b) throw new Error('no button: ${text}');
    b.click();
  })()`);
  const shot = async (file, full = true) => {
    // A sticky header would be painted at the current scroll offset in a full-page capture.
    if (full) { await evaluate('window.scrollTo(0, 0)'); await sleep(100); }
    const metrics = await send('Page.getLayoutMetrics');
    const height = full ? Math.ceil(metrics.cssContentSize.height) : undefined;
    const r = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: full,
      ...(full ? { clip: { x: 0, y: 0, width: metrics.cssLayoutViewport.clientWidth, height, scale: 1 } } : {}),
    });
    writeFileSync(join(out, file), Buffer.from(r.data, 'base64'));
  };
  /** Call the BFF from the page (same origin, CSRF header) — exercises the real proxy. */
  const bff = (method, path, body, idem = false) => evaluate(`fetch(${JSON.stringify(path)}, {
    method: ${JSON.stringify(method)},
    headers: { 'content-type': 'application/json', 'x-onepos-request': '1' ${idem ? ", 'idempotency-key': crypto.randomUUID()" : ''} },
    ${body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(body))},`}
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
  const noHorizontalScroll = () => evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`);

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    send, evaluate, viewport, waitFor, go, fill, clickText, shot, bff, noHorizontalScroll,
    close() { ws.close(); browser.kill(); },
  };
}

export function checklist() {
  const checks = [];
  const check = (name, ok) => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
  const finish = () => {
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  };
  return { check, finish };
}
