// Minimal Microsoft Graph client with paging and throttling retries.
const BASE = 'https://graph.microsoft.com/v1.0';

export function createGraph(getToken, scopes) {
  async function call(method, path, body, headers = {}, attempt = 0) {
    const token = await getToken(scopes);
    const res = await fetch(path.startsWith('http') ? path : BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 4) {
      const wait = (Number(res.headers.get('Retry-After')) || 2 ** attempt) * 1000;
      await new Promise(r => setTimeout(r, wait));
      return call(method, path, body, headers, attempt + 1);
    }
    if (!res.ok) {
      let msg = res.statusText, code;
      try { const j = await res.json(); msg = (j.error && j.error.message) || msg; code = j.error && j.error.code; } catch { /* no body */ }
      const e = new Error(msg || `Request failed (${res.status})`);
      e.status = res.status;
      e.code = code;
      throw e;
    }
    if (res.status === 202 || res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    patch: (p, b, h) => call('PATCH', p, b, h),
    del: (p, h) => call('DELETE', p, undefined, h),
    async getAll(p, h) {
      let out = [], url = p;
      while (url) {
        const r = await call('GET', url, undefined, h);
        out = out.concat(r.value || []);
        url = r['@odata.nextLink'];
      }
      return out;
    },
    withScopes: s => createGraph(getToken, s),
  };
}
