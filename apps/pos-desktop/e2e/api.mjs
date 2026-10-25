// Shared by the E2E scripts (counter and admin): the sign-up password and a small API client.

export const PASSWORD = 'correct horse battery staple';

export function client(api) {
  return async function call(method, path, token, body, headers = {}) {
    const res = await fetch(api + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}
