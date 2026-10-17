import { loadWorkerEnv } from '@1pos/config';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { listDead, replayDead } from './dead-letters.js';

const USAGE = `DEAD-letter tool (ADR-0016). Connects as the worker (WORKER_DATABASE_URL).

  dead-letters list [--topic <topic>] [--limit <n>]
  dead-letters replay <event-id>... --reason "<why>" [--actor <name>]
  dead-letters replay --all [--topic <topic>] --reason "<why>" [--actor <name>]

Fix the cause first (runbook: docs/operations/monitoring.md#outbox-dead-letters); a replay of an
unfixed failure just dies again after its retries. Every replay is audited with actor and reason.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      topic: { type: 'string' },
      limit: { type: 'string' },
      reason: { type: 'string' },
      actor: { type: 'string' },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...ids] = positionals;
  if (values.help || !command || !['list', 'replay'].includes(command)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const env = loadWorkerEnv();
  const pool = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL ?? env.DATABASE_URL, max: 1 });
  try {
    if (command === 'list') {
      const limit = values.limit ? Number(values.limit) : 50;
      const rows = await listDead(pool, { limit, topic: values.topic });
      for (const r of rows) {
        console.log(`${r.id}  ${r.topic}  tenant=${r.tenantId}  attempts=${r.attempts}  failed=${r.failedAt.toISOString()}  ${r.lastError ?? ''}`);
      }
      console.log(`${rows.length} DEAD event(s)${rows.length === limit ? ' (limit reached; pass --limit)' : ''}`);
      return 0;
    }
    if (!values.reason || values.reason.trim().length < 3) {
      console.error('replay needs --reason "<why>" (recorded in the audit log)');
      return 2;
    }
    if (values.all === (ids.length > 0)) {
      console.error('replay takes either event ids or --all');
      return 2;
    }
    const bad = ids.filter((i) => !UUID.test(i));
    if (bad.length) {
      console.error(`not event ids: ${bad.join(', ')}`);
      return 2;
    }
    const actor = values.actor ?? userInfo().username;
    const targets = values.all ? (await listDead(pool, { limit: 500, topic: values.topic })).map((r) => r.id) : ids;
    let replayed = 0;
    for (const id of targets) {
      const ok = await replayDead(pool, id, actor, values.reason);
      console.log(`${id}  ${ok ? 'queued again' : 'not DEAD (already replayed or unknown)'}`);
      if (ok) replayed++;
    }
    console.log(`${replayed} of ${targets.length} replayed by ${actor}`);
    return replayed === targets.length ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('dead-letters failed:', err instanceof Error ? err.message.split('\nparams:')[0] : err);
    process.exit(1);
  },
);
