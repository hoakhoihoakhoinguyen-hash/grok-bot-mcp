import { describe, expect, it } from 'vitest';
import { ASK_ATTEMPT_LIMIT } from '../src/core/constants';
import { KvJobStore } from '../src/core/kv-store';
import { UpstashJobStore } from '../src/core/upstash-store';
import { REPLY_SECRET, callTool, postJson, testApp, toolText } from './helpers';

describe('overlapping requests in one process', () => {
  it('wakes the webhook once for overlapping asks from the same caller', async () => {
    let calls = 0;
    const { app } = testApp({
      config: { waitSeconds: 0 },
      fetchImpl: async () => {
        calls += 1;
        await Promise.resolve();
        return new Response('awake', { status: 200 });
      },
    });
    const results = await Promise.all(
      Array.from({ length: ASK_ATTEMPT_LIMIT + 8 }, (_, index) => callTool(app, 'ask_bot', { message: `overlap ${index}` })),
    );
    expect(calls).toBe(1);
    const ids = results
      .map((result) => result.rpc.result?.structuredContent?.job_id)
      .filter((id): id is string => typeof id === 'string');
    expect(new Set(ids).size).toBe(1);
    expect(results.filter((result) => toolText(result.rpc) === 'rate_limited')).toHaveLength(8);
    expect(results.some((result) => toolText(result.rpc).startsWith('pending '))).toBe(true);
  });

  it('keeps one job when the same idempotency key is sent together', async () => {
    let calls = 0;
    const { app } = testApp({
      config: { waitSeconds: 0 },
      fetchImpl: async () => {
        calls += 1;
        await Promise.resolve();
        return new Response('awake', { status: 200 });
      },
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => callTool(app, 'ask_bot', { message: 'same', idempotency_key: 'same-key1' })),
    );
    expect(calls).toBe(1);
    const ids = results.map((result) => String(result.rpc.result?.structuredContent?.job_id));
    expect(new Set(ids).size).toBe(1);
  });

  it('stores exactly one of two overlapping replies', async () => {
    const { app } = testApp({
      config: { waitSeconds: 0 },
      fetchImpl: async () => new Response('awake', { status: 200 }),
    });
    const asked = await callTool(app, 'ask_bot', { message: 'question' });
    const jobId = String(asked.rpc.result?.structuredContent?.job_id);
    const headers = { authorization: `Bearer ${REPLY_SECRET}` };
    const [alpha, beta] = await Promise.all([
      postJson(app, '/api/reply', { job_id: jobId, reply: 'alpha-answer' }, headers),
      postJson(app, '/api/reply', { job_id: jobId, reply: 'beta-answer' }, headers),
    ]);
    expect([alpha.status, beta.status].sort()).toEqual([200, 409]);
    const winner = alpha.status === 200 ? 'alpha-answer' : 'beta-answer';
    const read = await callTool(app, 'get_reply', { job_id: jobId });
    expect(read.rpc.result?.structuredContent?.reply).toBe(winner);
  });

  it('rejects an overlapping read and submit after the TTL', async () => {
    let now = 1_000_000;
    const { app } = testApp({
      now: () => now,
      config: { waitSeconds: 0, jobTtlSeconds: 60 },
      fetchImpl: async () => new Response('awake', { status: 200 }),
    });
    const asked = await callTool(app, 'ask_bot', { message: 'expire' });
    const jobId = String(asked.rpc.result?.structuredContent?.job_id);
    now += 60_000;
    const [read, late] = await Promise.all([
      callTool(app, 'get_reply', { job_id: jobId }),
      postJson(app, '/api/reply', { job_id: jobId, reply: 'too late' }, { authorization: `Bearer ${REPLY_SECRET}` }),
    ]);
    expect(toolText(read.rpc)).toBe('not_found');
    expect(late.status).toBe(404);
  });

  it('lets one atomic completion win when two Upstash writes overlap', async () => {
    const saved = new Map<string, string>();
    const fetchImpl: typeof fetch = async (_input, init) => {
      const command = JSON.parse(String(init?.body)) as string[];
      if (command[0] === 'SET' && command.includes('NX')) {
        const key = command[1] ?? '';
        if (saved.has(key)) return Response.json({ result: null });
        saved.set(key, command[2] ?? '');
        return Response.json({ result: 'OK' });
      }
      if (command[0] === 'GET') return Response.json({ result: saved.get(command[1] ?? '') ?? null });
      if (command[0] === 'EVAL' && String(command[1]).includes('KEEPTTL')) {
        const key = command[3] ?? '';
        const next = command[4] ?? '';
        const current = saved.get(key);
        if (current === undefined) return Response.json({ result: 'missing' });
        const parsed = JSON.parse(current) as { status?: string };
        if (parsed.status !== 'pending') return Response.json({ result: 'not_pending' });
        saved.set(key, next);
        return Response.json({ result: 'updated' });
      }
      return Response.json({ result: null });
    };
    const store = new UpstashJobStore('https://redis.example', 'secret-token-value', fetchImpl, () => 0);
    const pending = { status: 'pending' as const, caller: 'claude', createdAt: 0 };
    expect(await store.create('job-1', pending, 60)).toBe(true);
    const [left, right] = await Promise.all([
      store.complete('job-1', { ...pending, status: 'done', reply: 'alpha-answer' }, 60),
      store.complete('job-1', { ...pending, status: 'done', reply: 'beta-answer' }, 60),
    ]);
    expect([left, right].sort()).toEqual(['not_pending', 'updated']);
    const stored = await store.get('job-1');
    expect(stored?.reply === 'alpha-answer' || stored?.reply === 'beta-answer').toBe(true);
  });
});

describe('stores that are not atomic', () => {
  it('refuses a live in-memory store before calling the webhook', async () => {
    let calls = 0;
    const { app } = testApp({
      runtime: 'live',
      fetchImpl: async () => {
        calls += 1;
        return new Response('awake', { status: 200 });
      },
    });
    const results = await Promise.all([
      callTool(app, 'ask_bot', { message: 'one' }),
      callTool(app, 'ask_bot', { message: 'two' }),
    ]);
    expect(calls).toBe(0);
    expect(results.every((result) => toolText(result.rpc) === 'store_not_atomic')).toBe(true);
  });

  it('refuses Workers KV without writing or calling the webhook', async () => {
    const puts: string[] = [];
    const kv = {
      async get(): Promise<string | null> {
        return null;
      },
      async put(key: string): Promise<void> {
        puts.push(key);
      },
      async delete(): Promise<void> {},
    };
    let calls = 0;
    const { app } = testApp({
      store: new KvJobStore(kv),
      runtime: 'live',
      fetchImpl: async () => {
        calls += 1;
        return new Response('awake', { status: 200 });
      },
    });
    const asked = await callTool(app, 'ask_bot', { message: 'question' });
    expect(toolText(asked.rpc)).toBe('store_not_atomic');
    const submitted = await postJson(
      app,
      '/api/reply',
      { job_id: '00000000-0000-4000-8000-000000000001', reply: 'nope' },
      { authorization: `Bearer ${REPLY_SECRET}` },
    );
    expect(submitted.status).toBe(503);
    expect(submitted.json).toEqual({ error: 'store_not_atomic' });
    expect(calls).toBe(0);
    expect(puts).toEqual([]);
  });
});
