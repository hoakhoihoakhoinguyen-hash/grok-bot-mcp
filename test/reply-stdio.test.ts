import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { forwardRpc, readPrivateSecretFile, validateBridgeUrl } from '../src/stdio-bridge-lib.mjs';

const SECRET = 'reply-secret-value';

function privateFile(mode: number): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'reply-stdio-'));
  const file = join(dir, 'secret');
  writeFileSync(file, `${SECRET}\n`, { mode: 0o600 });
  chmodSync(file, mode);
  return { dir, file };
}

function removeTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function runAdapter(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, ['src/reply-stdio.mjs', ...args], { env: { ...process.env } });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

describe('reply stdio adapter', () => {
  it('accepts only the reply endpoint and a private secret file', () => {
    expect(validateBridgeUrl('https://mcp.example/api/reply-mcp', '/api/reply-mcp').ok).toBe(true);
    expect(validateBridgeUrl('https://mcp.example/api/mcp', '/api/reply-mcp').ok).toBe(false);
    expect(validateBridgeUrl('http://mcp.example/api/reply-mcp', '/api/reply-mcp').ok).toBe(false);

    const opened = privateFile(0o600);
    const loose = privateFile(0o644);
    try {
      const read = readPrivateSecretFile(opened.file);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.secret).toBe(SECRET);
      const rejected = readPrivateSecretFile(loose.file);
      expect(rejected.ok).toBe(false);
      expect(JSON.stringify(rejected)).not.toContain(SECRET);
    } finally {
      removeTemp(opened.dir);
      removeTemp(loose.dir);
    }
  });

  it('sends the file secret only as a bearer header', async () => {
    const opened = privateFile(0o600);
    const read = readPrivateSecretFile(opened.file);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      removeTemp(opened.dir);
      return;
    }
    let body = '';
    let authorization = '';
    const result = await forwardRpc({
      fetchImpl: async (_input, init) => {
        body = String(init?.body);
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), { status: 200 });
      },
      url: 'https://mcp.example/api/reply-mcp',
      secret: read.secret,
      timeoutMs: 1000,
      message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_reply' } },
    });
    expect(result.ok).toBe(true);
    expect(authorization).toBe(`Bearer ${SECRET}`);
    expect(body).not.toContain(SECRET);
    removeTemp(opened.dir);
  });

  it('does not print the secret when the file is loose or the arguments are wrong', async () => {
    const loose = privateFile(0o644);
    const opened = privateFile(0o600);
    try {
      const looseRun = await runAdapter(['--url', 'https://mcp.example/api/reply-mcp', '--secret-file', loose.file]);
      expect(looseRun.code).toBe(1);
      expect(looseRun.stderr).toContain('secret_file_not_private');
      expect(looseRun.stderr).not.toContain(SECRET);

      const badUrl = await runAdapter(['--url', 'http://evil.example/api/reply-mcp', '--secret-file', opened.file]);
      expect(badUrl.code).toBe(1);
      expect(badUrl.stderr).not.toContain(SECRET);
      expect(badUrl.stderr).not.toContain('evil.example');

      const inline = await runAdapter(['--secret', SECRET, '--url', 'https://mcp.example/api/reply-mcp']);
      expect(inline.code).toBe(1);
      expect(inline.stderr).not.toContain(SECRET);
    } finally {
      removeTemp(loose.dir);
      removeTemp(opened.dir);
    }
  });
});
