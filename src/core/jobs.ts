import { ASK_ATTEMPT_LIMIT, ASK_WINDOW_SECONDS, MAX_REPLY_BYTES, MAX_THREAD_ID_CHARS, READ_ATTEMPT_LIMIT, READ_WINDOW_SECONDS } from './constants';
import { isJobId, utf8ByteLength } from './http';
import type { AppDeps, JobRecord, JobStatus } from './types';
import { validateAllowlistedHttps } from './url-policy';
import { postWebhook } from './webhook';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export interface PublicJob {
  job_id: string;
  status: JobStatus | 'not_found';
  reply?: string;
  error?: string;
}

export type AskOutcome =
  | { kind: 'result'; job: PublicJob }
  | { kind: 'tool_error'; message: string };

export async function askBot(
  deps: AppDeps,
  input: { message: string; threadId?: string; caller: string; idempotencyKey?: string },
): Promise<AskOutcome> {
  const bytes = utf8ByteLength(input.message);
  if (bytes > deps.config.maxMessageBytes) return { kind: 'tool_error', message: 'message_too_large' };
  if (input.message.trim().length === 0) return { kind: 'tool_error', message: 'message_empty' };
  if (input.threadId !== undefined && input.threadId.length > MAX_THREAD_ID_CHARS) {
    return { kind: 'tool_error', message: 'thread_id_invalid' };
  }
  if (input.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    return { kind: 'tool_error', message: 'idempotency_invalid' };
  }

  const missing = missingAskConfig(deps);
  if (missing) return { kind: 'tool_error', message: missing };
  const webhookUrl = validateAllowlistedHttps(deps.config.webhookUrl, deps.config.webhookAllowHosts);
  if (!webhookUrl.ok) return { kind: 'tool_error', message: 'webhook_url_rejected' };

  const allowed = await deps.store.consumeRate(`ask:${input.caller}`, ASK_ATTEMPT_LIMIT, ASK_WINDOW_SECONDS);
  if (!allowed) {
    deps.log?.('rate_limited', { caller: input.caller });
    return { kind: 'tool_error', message: 'rate_limited' };
  }

  const idemHash = input.idempotencyKey ? await digestKey(`${input.caller}:${input.idempotencyKey}`) : undefined;
  if (idemHash) {
    const existingId = await deps.store.readIdempotency(input.caller, idemHash);
    if (existingId && isJobId(existingId)) {
      const stored = await deps.store.get(existingId);
      if (stored && stored.caller === input.caller) return { kind: 'result', job: toPublic(existingId, stored) };
      await deps.store.deleteIdempotency(input.caller, idemHash);
    }
  }

  const now = deps.now ?? Date.now;
  const jobId = crypto.randomUUID();
  const reservation = await deps.store.reserveInflight(input.caller, jobId, deps.config.jobTtlSeconds);
  if (!reservation.reserved) {
    const currentId = reservation.jobId ?? jobId;
    deps.log?.('inflight', { caller: input.caller, job_id: currentId });
    return { kind: 'result', job: { job_id: currentId, status: 'pending', error: 'inflight' } };
  }

  const record: JobRecord = { status: 'pending', caller: input.caller, createdAt: now() };
  const created = await deps.store.create(jobId, record, deps.config.jobTtlSeconds);
  if (!created) {
    await deps.store.releaseInflight(input.caller, jobId);
    return { kind: 'tool_error', message: 'store_failed' };
  }
  if (idemHash) await deps.store.writeIdempotency(input.caller, idemHash, jobId, deps.config.jobTtlSeconds);

  deps.log?.('ask_bot', { caller: input.caller, job_id: jobId, bytes });

  const webhook = await postWebhook(
    deps.fetchImpl ?? fetch,
    webhookUrl.href,
    deps.config.webhookKey as string,
    {
      job_id: jobId,
      thread_id: input.threadId ?? null,
      caller: input.caller,
      message: input.message,
    },
    deps.config.webhookTimeoutMs,
  );

  if (!webhook.ok) {
    await deps.store.complete(
      jobId,
      { ...record, status: 'error', error: 'webhook_failed' },
      deps.config.jobTtlSeconds,
    );
    await deps.store.releaseInflight(input.caller, jobId);
    if (idemHash) await deps.store.deleteIdempotency(input.caller, idemHash);
    deps.log?.('webhook_failed', { job_id: jobId, status: webhook.status ?? 0 });
    return { kind: 'tool_error', message: 'webhook_failed' };
  }

  return { kind: 'result', job: await waitForJob(deps, jobId, input.caller) };
}

export async function getReply(deps: AppDeps, jobId: string, caller: string): Promise<PublicJob> {
  const allowed = await deps.store.consumeRate(`read:${caller}`, READ_ATTEMPT_LIMIT, READ_WINDOW_SECONDS);
  if (!allowed) {
    deps.log?.('rate_limited', { caller });
    return { job_id: jobId, status: 'not_found', error: 'rate_limited' };
  }
  if (!isJobId(jobId)) return { job_id: jobId, status: 'not_found' };
  const job = await deps.store.get(jobId);
  if (!job || job.caller !== caller) return { job_id: jobId, status: 'not_found' };
  return toPublic(jobId, job);
}

export interface ReplyUpdate {
  jobId: string;
  reply?: string;
  error?: string;
}

export type ReplyBodyError = 'invalid' | 'oversized';

export function parseReplyBody(value: unknown): ReplyUpdate | ReplyBodyError {
  if (!value || typeof value !== 'object') return 'invalid';
  const body = value as Record<string, unknown>;
  if (typeof body.job_id !== 'string' || !isJobId(body.job_id)) return 'invalid';
  const hasReply = Object.prototype.hasOwnProperty.call(body, 'reply');
  const hasError = Object.prototype.hasOwnProperty.call(body, 'error');
  if (hasReply === hasError) return 'invalid';
  if (hasReply) {
    if (typeof body.reply !== 'string') return 'invalid';
    if (utf8ByteLength(body.reply) > MAX_REPLY_BYTES) return 'oversized';
    return { jobId: body.job_id, reply: body.reply };
  }
  if (typeof body.error !== 'string') return 'invalid';
  if (utf8ByteLength(body.error) > MAX_REPLY_BYTES) return 'oversized';
  return { jobId: body.job_id, error: body.error };
}

function missingAskConfig(deps: AppDeps): string | null {
  if (!deps.config.webhookUrl || !deps.config.webhookKey || !deps.config.replySecret) return 'server_misconfigured';
  if (deps.config.webhookAllowHosts.length === 0) return 'server_misconfigured';
  return null;
}

async function digestKey(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

async function waitForJob(deps: AppDeps, jobId: string, caller: string): Promise<PublicJob> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + deps.config.waitSeconds * 1000;
  const maxPolls = Math.max(1, Math.ceil((deps.config.waitSeconds * 1000) / deps.config.pollIntervalMs) + 1);

  for (let poll = 0; poll < maxPolls; poll += 1) {
    const job = await deps.store.get(jobId);
    if (!job || job.caller !== caller) {
      return { job_id: jobId, status: 'not_found', error: 'job expired before a reply arrived' };
    }
    if (job.status !== 'pending') return toPublic(jobId, job);
    const remaining = deadline - now();
    if (remaining <= 0) return toPublic(jobId, job);
    await sleep(Math.min(deps.config.pollIntervalMs, remaining));
  }

  const last = await deps.store.get(jobId);
  if (!last || last.caller !== caller) {
    return { job_id: jobId, status: 'not_found', error: 'job expired before a reply arrived' };
  }
  return toPublic(jobId, last);
}

function toPublic(jobId: string, job: JobRecord): PublicJob {
  const result: PublicJob = { job_id: jobId, status: job.status };
  if (job.reply !== undefined) result.reply = job.reply;
  if (job.error !== undefined) result.error = job.error;
  return result;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
