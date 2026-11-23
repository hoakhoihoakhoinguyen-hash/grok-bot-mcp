import { describe, expect, it } from 'vitest';
import { ASK_ATTEMPT_LIMIT } from '../src/core/constants';
import { CLAUDE_SECRET, REPLY_SECRET, callTool, postJson, rpc, testApp, toolText } from './helpers';

describe('single-round limits', () => {
  it('does not wake the bot a second time while a job is in flight', async () => {
    let calls = 0;
    const { app } = testApp({
      config: { waitSeconds: 0 },
      fetchImpl: async () => {
        calls += 1;
        return new Response('awake', { status: 200 });
      },
    });
    const first = await callTool(app, 'ask_bot', { message: 'one question' });
    const second = await callTool(app, 'ask_bot', { message: 'another question' });
    const jobId = String(first.rpc.result?.structuredContent?.job_id);
    expect(first.rpc.result?.structuredContent).toMatchObject({ status: 'pending', job_id: jobId });
    expect(second.rpc.result?.structuredContent).toMatchObject({ status: 'pending', job_id: jobId, error: 'inflight' });
    expect(toolText(second.rpc)).toBe(`inflight ${jobId}`);
    expect(calls).toBe(1);
  });

  it('reuses the job for the same idempotency key and wakes the webhook once', async () => {
    let calls = 0;
    const { app } = testApp({
      config: { waitSeconds: 0 },
      fetchImpl: async () => {
        calls += 1;
        return new Response('awake', { status: 200 });
      },
    });
    const first = await callTool(app, 'ask_bot', { message: 'same', idempotency_key: 'repeat-01' });
    const second = await callTool(app, 'ask_bot', { message: 'same', idempotency_key: 'repeat-01' });
    expect(second.rpc.result?.structuredContent?.job_id).toBe(first.rpc.result?.structuredContent?.job_id);
    expect(calls).toBe(1);
  });

  it('stops further asks after the hard per-caller limit', async () => {
    let calls = 0;
    const { app } = testApp({
      config: { waitSeconds: 0 },
      fetchImpl: async () => {
        calls += 1;
        return new Response('awake', { status: 200 });
      },
    });
    for (let index = 0; index < ASK_ATTEMPT_LIMIT; index += 1) {
      const asked = await callTool(app, 'ask_bot', { message: `question ${index}` });
      expect(asked.rpc.result?.isError).toBeUndefined();
      const jobId = String(asked.rpc.result?.structuredContent?.job_id);
      const stored = await postJson(
        app,
        '/api/reply',
        { job_id: jobId, reply: 'done' },
        { authorization: `Bearer ${REPLY_SECRET}` },
      );
      expect(stored.status).toBe(200);
    }
    const blocked = await callTool(app, 'ask_bot', { message: 'one more' });
    expect(blocked.rpc.result?.isError).toBe(true);
    expect(toolText(blocked.rpc)).toBe('rate_limited');
    expect(calls).toBe(ASK_ATTEMPT_LIMIT);
  });

  it('rejects webhook URLs that are not https on the allowlist and does not call them', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response('awake', { status: 200 });
    };
    const http = testApp({
      env: { GROK_BOT_WEBHOOK_URL: 'http://bot.example/webhook' },
      config: { waitSeconds: 0 },
      fetchImpl,
    });
    const httpAsked = await callTool(http.app, 'ask_bot', { message: 'hi' });
    expect(toolText(httpAsked.rpc)).toBe('webhook_url_rejected');

    const otherHost = testApp({
      env: { GROK_BOT_WEBHOOK_URL: 'https://evil.example/hook' },
      config: { waitSeconds: 0 },
      fetchImpl,
    });
    const other = await callTool(otherHost.app, 'ask_bot', { message: 'hi' });
    expect(toolText(other.rpc)).toBe('webhook_url_rejected');
    expect(other.text).not.toContain('evil.example');

    const metadata = testApp({
      env: { GROK_BOT_WEBHOOK_URL: 'https://169.254.169.254/latest' },
      config: { waitSeconds: 0 },
      fetchImpl,
    });
    const meta = await callTool(metadata.app, 'ask_bot', { message: 'hi' });
    expect(toolText(meta.rpc)).toBe('webhook_url_rejected');
    expect(meta.text).not.toContain('169.254');
    expect(calls).toBe(0);
  });
});

describe('reply scope', () => {
  it('lets only the reply credential store an answer, once', async () => {
    const { app } = testApp({
      config: { waitSeconds: 0 },
      fetchImpl: async () => new Response('awake', { status: 200 }),
    });
    const asked = await callTool(app, 'ask_bot', { message: 'question' });
    const jobId = String(asked.rpc.result?.structuredContent?.job_id);

    const callerAttempt = await callTool(app, 'submit_reply', { job_id: jobId, reply: 'nope' });
    expect(callerAttempt.rpc.error ?? callerAttempt.rpc.result?.isError).toBeTruthy();
    const callerOnReply = await rpc(app, 'tools/list', {}, CLAUDE_SECRET, 'legacy', '/api/reply-mcp');
    expect(callerOnReply.status).toBe(401);

    const listed = await rpc(app, 'tools/list', {}, REPLY_SECRET, 'legacy', '/api/reply-mcp');
    expect(listed.rpc.result?.tools?.map((tool) => tool.name)).toEqual(['submit_reply']);

    const submitted = await callTool(
      app,
      'submit_reply',
      { job_id: jobId, reply: 'answer text' },
      REPLY_SECRET,
      'legacy',
      '/api/reply-mcp',
    );
    expect(toolText(submitted.rpc)).toBe('stored');
    expect(submitted.text).not.toContain(REPLY_SECRET);

    const again = await callTool(
      app,
      'submit_reply',
      { job_id: jobId, reply: 'replaced' },
      REPLY_SECRET,
      'legacy',
      '/api/reply-mcp',
    );
    expect(toolText(again.rpc)).toBe('already_completed');

    const read = await callTool(app, 'get_reply', { job_id: jobId });
    expect(read.rpc.result?.structuredContent).toMatchObject({ status: 'done', reply: 'answer text' });

    const replyAsAsker = await rpc(app, 'tools/list', {}, REPLY_SECRET);
    expect(replyAsAsker.status).toBe(401);
  });
});
