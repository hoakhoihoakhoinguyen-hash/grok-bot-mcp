import { encodeFrame, forwardRpc, takeFrame, validateBridgeUrl } from './stdio-bridge-lib.mjs';

const MIN_SECRET_CHARS = 16;
const url = validateBridgeUrl(process.env.GROK_MCP_URL ?? '');
const secret = process.env.MCP_CALLER_SECRET ?? '';

if (!url.ok || secret.trim().length < MIN_SECRET_CHARS) {
  process.stderr.write('{"event":"bridge_misconfigured"}\n');
  process.exit(1);
}

let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  void drain();
});

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      const frame = takeFrame(pending);
      if (!frame) return;
      if ('error' in frame) {
        process.stderr.write('{"event":"bridge_frame_invalid"}\n');
        process.exit(1);
      }
      pending = frame.rest;
      try {
        const forwarded = await forwardRpc({
          fetchImpl: fetch,
          url: url.href,
          secret,
          timeoutMs: 30_000,
          message: frame.message,
        });
        const payload = forwarded.ok
          ? forwarded.message
          : { jsonrpc: '2.0', id: frame.message.id ?? null, error: { code: -32000, message: 'bridge_failed' } };
        process.stdout.write(encodeFrame(payload));
      } catch {
        process.stderr.write('{"event":"bridge_forward_failed"}\n');
        process.stdout.write(
          encodeFrame({ jsonrpc: '2.0', id: frame.message.id ?? null, error: { code: -32000, message: 'bridge_failed' } }),
        );
      }
    }
  } finally {
    draining = false;
    if (takeFrame(pending)) void drain();
  }
}
