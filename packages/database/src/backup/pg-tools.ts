import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Where pg_dump / pg_restore run. By default from PATH on this host. With `docker` set, inside that
 * container (`docker exec`), reaching the server at `dockerHost` as seen from inside it: this is how
 * the dev machine runs them (the compose Postgres image has the tools; Windows has none).
 * Their major version must be at least the server's.
 */
export interface PgTools {
  docker?: string;
  /** host:port of the server from inside the container (default 127.0.0.1:5432). */
  dockerHost?: string;
}

export function pgToolsFromEnv(env: NodeJS.ProcessEnv = process.env): PgTools {
  return env.PG_TOOLS_DOCKER ? { docker: env.PG_TOOLS_DOCKER, dockerHost: env.PG_TOOLS_DOCKER_HOST || undefined } : {};
}

/** The parts of a postgres:// URL the tools take as options (the password goes in PGPASSWORD, never argv). */
export function connectionParts(url: string, tools: PgTools = {}) {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new Error('The connection URL names no database');
  let host = u.hostname;
  let port = u.port || '5432';
  if (tools.docker) {
    const [h, p] = (tools.dockerHost ?? '127.0.0.1:5432').split(':');
    host = h!;
    port = p ?? '5432';
  }
  return { host, port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database };
}

/** Replace the database of a connection URL. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

/**
 * Start pg_dump / pg_restore against `url` with extra `args`. stdin/stdout are pipes; stderr is
 * collected and returned by `done`, which rejects on a non-zero exit.
 */
export function startPgTool(tool: 'pg_dump' | 'pg_restore', url: string, args: string[], tools: PgTools = {}) {
  const c = connectionParts(url, tools);
  const conn = ['--host', c.host, '--port', c.port, '--username', c.user, '--no-password'];
  const env = { ...process.env, PGPASSWORD: c.password, PGCONNECT_TIMEOUT: '10' };
  const [cmd, argv] = tools.docker
    ? ['docker', ['exec', '-i', '-e', 'PGPASSWORD', '-e', 'PGCONNECT_TIMEOUT', tools.docker, tool, ...conn, ...args]]
    : [tool, [...conn, ...args]];
  const child: ChildProcess = spawn(cmd, argv, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (d: string) => {
    if (stderr.length < 20_000) stderr += d;
  });
  const done = new Promise<string>((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`${tool} could not start (${cmd}): ${e.message}`)));
    child.on('close', (code, signal) =>
      code === 0 ? resolve(stderr) : reject(new Error(`${tool} failed (${signal ?? `exit ${code}`}): ${stderr.trim() || 'no output'}`)),
    );
  });
  return { child, done, database: c.database };
}

/** `pg_dump --version` / `pg_restore --version`, as the tools report it. */
export async function pgToolVersion(tool: 'pg_dump' | 'pg_restore', tools: PgTools = {}): Promise<string> {
  const [cmd, argv] = tools.docker ? ['docker', ['exec', tools.docker, tool, '--version']] : [tool, ['--version']];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${tool} --version exited ${code}`))));
  });
}
