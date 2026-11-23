import { startStdioPump, validateBridgeUrl } from './stdio-bridge-lib.mjs';

const MIN_SECRET_CHARS = 16;
const url = validateBridgeUrl(process.env.GROK_MCP_URL ?? '');
const secret = process.env.MCP_CALLER_SECRET ?? '';

if (!url.ok || secret.trim().length < MIN_SECRET_CHARS) {
  process.stderr.write('{"event":"bridge_misconfigured"}\n');
  process.exit(1);
}

startStdioPump({ url: url.href, secret });
