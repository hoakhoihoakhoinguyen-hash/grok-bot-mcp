import { readPrivateSecretFile, startStdioPump, validateBridgeUrl } from './stdio-bridge-lib.mjs';

const args = process.argv.slice(2);
const flags = new Set(['--url', '--secret-file']);
let urlArg;
let fileArg;
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!flags.has(flag) || value === undefined || value.startsWith('--')) {
    process.stderr.write('{"event":"bridge_misconfigured"}\n');
    process.exit(1);
  }
  if (flag === '--url') urlArg = value;
  if (flag === '--secret-file') fileArg = value;
}
if (args.length !== 4 || urlArg === undefined || fileArg === undefined) {
  process.stderr.write('{"event":"bridge_misconfigured"}\n');
  process.exit(1);
}

const url = validateBridgeUrl(urlArg, '/api/reply-mcp');
const secret = readPrivateSecretFile(fileArg);
if (!url.ok || !secret.ok) {
  const event = !secret.ok && secret.reason === 'secret_file_not_private' ? 'secret_file_not_private' : 'bridge_misconfigured';
  process.stderr.write(`{"event":"${event}"}\n`);
  process.exit(1);
}

startStdioPump({ url: url.href, secret: secret.secret });
