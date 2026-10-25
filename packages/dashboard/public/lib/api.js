// Calls the IceCrawl API of the origin that served the dashboard, with the API key the user typed in.

const KEY = 'icecrawl.apiKey';

export const keyStore = {
  get() {
    try {
      return sessionStorage.getItem(KEY) ?? '';
    } catch {
      return '';
    }
  },
  set(value) {
    try {
      if (value) sessionStorage.setItem(KEY, value);
      else sessionStorage.removeItem(KEY);
    } catch {
      // storage can be blocked; the key then lasts until the page is reloaded
    }
  },
};

export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {unknown} body */
  constructor(status, code, message, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** @param {string} path @param {{method?: string, body?: unknown, form?: FormData, raw?: boolean}} [o] */
async function call(path, o = {}) {
  const headers = {};
  const key = keyStore.get();
  if (key) headers.authorization = `Bearer ${key}`;
  let body;
  if (o.form) body = o.form;
  else if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const res = await fetch(path, { method: o.method ?? 'GET', headers, body });
  if (o.raw) {
    if (!res.ok) throw new ApiError(res.status, `HTTP_${res.status}`, `The server answered ${res.status}`, null);
    return res;
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status, `HTTP_${res.status}`, 'The server did not answer with JSON', null);
  }
  if (!res.ok) throw new ApiError(res.status, json.code ?? `HTTP_${res.status}`, json.error ?? res.statusText, json);
  return json;
}

export const api = {
  get: (path) => call(path),
  post: (path, body) => call(path, { method: 'POST', body }),
  patch: (path, body) => call(path, { method: 'PATCH', body }),
  del: (path) => call(path, { method: 'DELETE' }),
  upload: (path, form) => call(path, { method: 'POST', form }),
  async bytes(path) {
    return new Uint8Array(await (await call(path, { raw: true })).arrayBuffer());
  },
};

/** Waits for a job started with `start` to leave `processing`; `read(id)` returns the status object. */
export async function poll(read, { intervalMs = 1500, timeoutMs = 300_000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await read();
    onTick?.(s);
    if (s.status !== 'processing' && s.status !== 'scraping') return s;
    if (Date.now() > deadline) throw new ApiError(408, 'WAIT_TIMEOUT', 'Still running; check again later.', null);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
