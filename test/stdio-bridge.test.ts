import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { encodeFrame, forwardRpc, takeFrame, validateBridgeUrl } from '../src/stdio-bridge-lib.mjs';

describe('desktop stdio bridge', () => {
  it('accepts only the ask endpoint on public https', () => {
    expect(validateBridgeUrl('https://mcp.example/api/mcp').ok).toBe(true);
    expect(validateBridgeUrl('https://mcp.example/api/reply-mcp').ok).toBe(false);
    expect(validateBridgeUrl('http://mcp.example/api/mcp').ok).toBe(false);
    expect(validateBridgeUrl('https://mcp.example/api/mcp?token=secret').ok).toBe(false);
    expect(validateBridgeUrl('https://127.0.0.1/api/mcp').ok).toBe(false);
    expect(validateBridgeUrl('https://user:secret@mcp.example/api/mcp').ok).toBe(false);
  });

  it('frames JSON-RPC and sends the caller secret only as a bearer header', async () => {
    const secret = 'caller-secret-value';
    let seen: { url?: string; authorization?: string; body?: string; redirect?: RequestInit['redirect'] } = {};
    const result = await forwardRpc({
      fetchImpl: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen = {
          url: String(input),
          authorization: headers.get('authorization') ?? '',
          body: String(init?.body),
          redirect: init?.redirect,
        };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), { status: 200 });
      },
      url: 'https://mcp.example/api/mcp',
      secret,
      timeoutMs: 1000,
      message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_bot' } },
    });
    expect(result.ok).toBe(true);
    expect(seen.redirect).toBe('manual');
    expect(seen.authorization).toBe(`Bearer ${secret}`);
    expect(seen.body).not.toContain(secret);
    expect(seen.url).toBe('https://mcp.example/api/mcp');

    const frame = encodeFrame({ jsonrpc: '2.0', id: 7, method: 'ping' });
    const parsed = takeFrame(frame);
    expect(parsed && 'message' in parsed && parsed.message).toMatchObject({ id: 7, method: 'ping' });
  });

  it('does not follow a redirect or print the secret when misconfigured', async () => {
    let calls = 0;
    const redirected = await forwardRpc({
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } });
      },
      url: 'https://mcp.example/api/mcp',
      secret: 'caller-secret-value',
      timeoutMs: 1000,
      message: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(calls).toBe(1);
    expect(redirected).toEqual({ ok: false, reason: 'redirect' });

    const child = spawn(process.execPath, ['src/stdio-bridge.mjs'], {
      env: {
        ...process.env,
        GROK_MCP_URL: 'http://evil.example/api/mcp',
        MCP_CALLER_SECRET: 'super-secret-value-not-logged',
      },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('bridge_misconfigured');
    expect(stderr).not.toContain('super-secret-value-not-logged');
    expect(stderr).not.toContain('evil.example');
  });
});
