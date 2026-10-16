/**
 * API client for browser mode. Tokens live in memory only (never localStorage/sessionStorage):
 * a reload signs the cashier out, which suits a shift-based counter and keeps tokens out of reach
 * of injected scripts. The Tauri shell (Phase 5) will authenticate with terminal credentials.
 */
export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiFailure extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
  }
}

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
  return fetch(path, {
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
  const res = await fetch('/v1/auth/refresh', {
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
    throw new ApiFailure({ status: res.status, code: e?.code ?? 'ERROR', message: e?.message ?? res.statusText, details: e?.details });
  }
  return data as T;
}

export interface Membership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
}

export async function signIn(email: string, password: string, tenantId?: string) {
  const res = await fetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, ...(tenantId ? { tenantId } : {}) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFailure({ status: res.status, code: data?.error?.code ?? 'ERROR', message: data?.error?.message ?? 'Sign-in failed' });
  tokens = { accessToken: data.tokens.accessToken, refreshToken: data.tokens.refreshToken };
  activeTenantId = data.activeTenantId ?? null;
  return { activeTenantId };
}

export async function switchTenant(tenantId: string) {
  const data = await api<{ activeTenantId: string; tokens: Tokens }>('POST', '/v1/auth/switch-tenant', { tenantId });
  tokens = { accessToken: data.tokens.accessToken, refreshToken: data.tokens.refreshToken };
  activeTenantId = data.activeTenantId;
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
