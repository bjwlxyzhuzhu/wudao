// Fetch wrapper: JSON, CSRF header, typed errors, SSE step streaming.
export class ApiError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); } }

export async function api(method, path, body, { raw = false } = {}) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-yz-csrf': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw && res.ok) return res;
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const e = data?.error || { code: 'http_' + res.status, message: `请求失败（${res.status}）` };
    const err = new ApiError(res.status, e.code, e.message, e);
    if (res.status === 401 && !path.includes('/auth/')) window.dispatchEvent(new CustomEvent('yz:unauth', { detail: path }));
    if (e.code === 'must_change_password') window.dispatchEvent(new CustomEvent('yz:mustchange'));
    throw err;
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

export const key = (p = 'k') => `${p}-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** POST a step and read the SSE stream. handlers: {start, delta, final, end, error}. Resolves with the last payload type. */
export async function stepStream(runId, handlers, idempotencyKey = key('step')) {
  const res = await fetch(`/api/runs/${runId}/step`, { method: 'POST', credentials: 'same-origin', headers: { accept: 'text/event-stream', 'content-type': 'application/json', 'x-yz-csrf': '1' }, body: JSON.stringify({ idempotency_key: idempotencyKey }) });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('event-stream')) {
    const data = await res.json().catch(() => ({}));
    const e = data.error || { code: 'http_' + res.status, message: '步进失败' };
    handlers.error?.(e); return { type: 'error', data: e };
  }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let last = { type: 'none' };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const type = (block.match(/^event: (.+)$/m) || [])[1]; const line = (block.match(/^data: (.*)$/m) || [])[1];
      if (!type || line == null) continue;
      const data = JSON.parse(line); last = { type, data };
      handlers[type]?.(data);
    }
  }
  return last;
}

export function download(path, filename) {
  const a = document.createElement('a'); a.href = path; if (filename) a.download = filename; document.body.appendChild(a); a.click(); a.remove();
}
export async function downloadPost(path, body, fallbackName) {
  const res = await api('POST', path, body, { raw: true });
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || ''; const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const url = URL.createObjectURL(blob); download(url, name); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
