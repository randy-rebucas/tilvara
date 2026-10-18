import { apiBase } from './desktop';

/**
 * API client (browser mode and the desktop shell). Tokens live in memory only (never
 * localStorage/sessionStorage): a reload signs the cashier out, which suits a shift-based counter and
 * keeps tokens out of reach of injected scripts. Offline sync authenticates the terminal instead.
 */
export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** The API's correlation id (in every error body): the reference support looks up in the logs. */
  correlationId?: string;
}

export class ApiFailure extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
  }
}

/**
 * The server answered but could not finish (5xx): add the start of its correlation id, enough for
 * support to find the request in the logs. "Ref." reads the same in English and Filipino.
 */
export const withReference = (text: string, err: unknown): string =>
  err instanceof ApiFailure && err.error.status >= 500 && err.error.correlationId ? `${text} · Ref. ${err.error.correlationId.slice(0, 8)}` : text;

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

let tokens: Tokens | null = null;
let activeTenantId: string | null = null;
let onSignedOut: () => void = () => undefined;

export const session = {
  get signedIn() {
    return tokens !== null;
  },
  get tenantId() {
    return activeTenantId;
  },
  onSignedOut(fn: () => void) {
    onSignedOut = fn;
  },
  clear() {
    tokens = null;
    activeTenantId = null;
  },
};

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(apiBase() + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function refresh(): Promise<boolean> {
  if (!tokens) return false;
  const res = await fetch(`${apiBase()}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken, ...(activeTenantId ? { tenantId: activeTenantId } : {}) }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { tokens: Tokens };
  tokens = { accessToken: data.tokens.accessToken, refreshToken: data.tokens.refreshToken };
  return true;
}

/** JSON request; one silent refresh on 401, then sign-out. Network failures surface as code NETWORK. */
export async function api<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await raw(method, path, body, headers);
    if (res.status === 401 && (await refresh())) res = await raw(method, path, body, headers);
  } catch {
    throw new ApiFailure({ status: 0, code: 'NETWORK', message: 'Network error' });
  }
  if (res.status === 401) {
    session.clear();
    onSignedOut();
  }
  const data = (await res.json().catch(() => null)) as { error?: Omit<ApiError, 'status'> } | null;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiFailure({ status: res.status, code: e?.code ?? 'ERROR', message: e?.message ?? res.statusText, details: e?.details, correlationId: e?.correlationId });
  }
  return data as T;
}

export interface Membership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
}

/** Signed in, or — for an account with two-step sign-in (ADR-0016) — a challenge to answer with a code. */
export type SignInResult = { activeTenantId: string | null; challenge?: undefined } | { challenge: string };

async function postAuth(path: string, body: unknown) {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFailure({ status: res.status, code: data?.error?.code ?? 'ERROR', message: data?.error?.message ?? 'Sign-in failed' });
  return data;
}

function startSession(data: { tokens: Tokens; activeTenantId?: string | null }): SignInResult {
  tokens = { accessToken: data.tokens.accessToken, refreshToken: data.tokens.refreshToken };
  activeTenantId = data.activeTenantId ?? null;
  return { activeTenantId };
}

export async function signIn(email: string, password: string, tenantId?: string): Promise<SignInResult> {
  const data = await postAuth('/v1/auth/login', { email, password, ...(tenantId ? { tenantId } : {}) });
  // The 5-minute challenge stays in memory like the tokens.
  if (data?.mfaRequired) return { challenge: String(data.challengeToken) };
  return startSession(data);
}

export async function verifyMfa(challenge: string, answer: { code: string } | { recoveryCode: string }): Promise<SignInResult> {
  return startSession(await postAuth('/v1/auth/mfa/verify', { challengeToken: challenge, ...answer }));
}

/** A new access token for the chosen business; the refresh token (same session) stays. */
export async function switchTenant(tenantId: string) {
  const data = await api<{ accessToken: string; accessTokenExpiresAt: string }>('POST', '/v1/auth/switch-tenant', { tenantId });
  if (!tokens) throw new ApiFailure({ status: 401, code: 'UNAUTHENTICATED', message: 'Sign in again' });
  tokens = { accessToken: data.accessToken, refreshToken: tokens.refreshToken };
  activeTenantId = tenantId;
}

export async function signOut() {
  try {
    await api('POST', '/v1/auth/logout', {});
  } catch {
    // Best effort; tokens are dropped either way.
  }
  session.clear();
}

export const uuid = () => crypto.randomUUID();
