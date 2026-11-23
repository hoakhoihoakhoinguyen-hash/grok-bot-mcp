import { readFileSync, statSync } from 'node:fs';

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function validateBridgeUrl(value, expectedPath = '/api/mcp') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return { ok: false };
  if (expectedPath !== '/api/mcp' && expectedPath !== '/api/reply-mcp') return { ok: false };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'https:') return { ok: false };
  if (url.username || url.password || url.search || url.hash) return { ok: false };
  if (url.port && url.port !== '443') return { ok: false };
  if (url.pathname !== expectedPath) return { ok: false };
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

export function readPrivateSecretFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096 || filePath.includes('\0')) {
    return { ok: false, reason: 'secret_file_invalid' };
  }
  if (!filePath.startsWith('/')) return { ok: false, reason: 'secret_file_invalid' };
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return { ok: false, reason: 'secret_file_invalid' };
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) return { ok: false, reason: 'secret_file_not_private' };
  if (stat.size < 16 || stat.size > 4096) return { ok: false, reason: 'secret_file_invalid' };
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'secret_file_invalid' };
  }
  const secret = text.trim();
  if (secret.length < 16 || /[\r\n]/.test(secret)) return { ok: false, reason: 'secret_file_invalid' };
  return { ok: true, secret };
}

export function startStdioPump({ url, secret, fetchImpl = fetch, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr }) {
  let pending = Buffer.alloc(0);
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const frame = takeFrame(pending);
        if (!frame) return;
        if ('error' in frame) {
          stderr.write('{"event":"bridge_frame_invalid"}\n');
          process.exit(1);
        }
        pending = frame.rest;
        try {
          const forwarded = await forwardRpc({
            fetchImpl,
            url,
            secret,
            timeoutMs: 30_000,
            message: frame.message,
          });
          const payload = forwarded.ok
            ? forwarded.message
            : { jsonrpc: '2.0', id: frame.message.id ?? null, error: { code: -32000, message: 'bridge_failed' } };
          stdout.write(encodeFrame(payload));
        } catch {
          stderr.write('{"event":"bridge_forward_failed"}\n');
          stdout.write(
            encodeFrame({ jsonrpc: '2.0', id: frame.message.id ?? null, error: { code: -32000, message: 'bridge_failed' } }),
          );
        }
      }
    } finally {
      draining = false;
      if (takeFrame(pending)) void drain();
    }
  }
  stdin.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    void drain();
  });
}
