const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function validateBridgeUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return { ok: false };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'https:') return { ok: false };
  if (url.username || url.password || url.search || url.hash) return { ok: false };
  if (url.port && url.port !== '443') return { ok: false };
  if (url.pathname !== '/api/mcp') return { ok: false };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME.test(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false };
  }
  if (host.includes(':') || /^\d+$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false };
  return { ok: true, href: url.href };
}

export function encodeFrame(message) {
  const json = JSON.stringify(message);
  const bytes = Buffer.byteLength(json);
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes}\r\n\r\n`), Buffer.from(json)]);
}

export function takeFrame(buffer) {
  const text = buffer.toString('latin1');
  const headerEnd = text.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const header = text.slice(0, headerEnd);
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (!match) return { error: 'invalid_frame' };
  const length = Number(match[1]);
  if (!Number.isInteger(length) || length < 2 || length > 256 * 1024) return { error: 'invalid_frame' };
  const start = Buffer.byteLength(text.slice(0, headerEnd + 4), 'latin1');
  if (buffer.length < start + length) return null;
  const body = buffer.subarray(start, start + length).toString('utf8');
  let message;
  try {
    message = JSON.parse(body);
  } catch {
    return { error: 'invalid_frame' };
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { error: 'invalid_frame' };
  return { message, rest: buffer.subarray(start + length) };
}

export function parseRpcBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const data = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);
  const last = data.at(-1);
  if (!last) return null;
  return JSON.parse(last);
}

export async function forwardRpc({ fetchImpl, url, secret, timeoutMs, message }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'redirect' };
  }
  const text = await response.text();
  if (text.length > 300_000) return { ok: false, reason: 'too_large' };
  try {
    const parsed = parseRpcBody(text);
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'invalid_response' };
    return { ok: true, message: parsed };
  } catch {
    return { ok: false, reason: 'invalid_response' };
  }
}
