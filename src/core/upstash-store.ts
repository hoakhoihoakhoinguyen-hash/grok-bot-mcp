import { parseJobRecord } from './job-record';
import type { CompleteResult, InflightReservation, JobRecord, JobStore } from './types';

const CONSUME_RATE = [
  "local current = redis.call('INCR', KEYS[1])",
  'if current == 1 then redis.call(\'EXPIRE\', KEYS[1], ARGV[1]) end',
  'if current > tonumber(ARGV[2]) then return 0 end',
  'return 1',
].join('\n');

/** One round trip. SET runs only while status is pending, and KEEPTTL leaves the original expiry alone. */
const COMPLETE_IF_PENDING = [
  "local raw = redis.call('GET', KEYS[1])",
  'if not raw then return "missing" end',
  'local current = cjson.decode(raw)',
  'if current["status"] ~= "pending" then return "not_pending" end',
  "redis.call('SET', KEYS[1], ARGV[1], 'KEEPTTL')",
  'return "updated"',
].join('\n');

export class UpstashJobStore implements JobStore {
  readonly safety = 'atomic' as const;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    _now: () => number = () => Date.now(),
    private readonly keyPrefix = 'grok-bot-mcp:job:',
  ) {}

  async create(jobId: string, job: JobRecord, ttlSeconds: number): Promise<boolean> {
    const result = await this.command(['SET', this.key(jobId), JSON.stringify(job), 'EX', String(ttlSeconds), 'NX']);
    return result === 'OK';
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const result = await this.command(['GET', this.key(jobId)]);
    if (typeof result !== 'string') return null;
    return parseJobRecord(result);
  }

  async complete(jobId: string, job: JobRecord, _ttlSeconds: number): Promise<CompleteResult> {
    const result = await this.command(['EVAL', COMPLETE_IF_PENDING, '1', this.key(jobId), JSON.stringify(job)]);
    switch (result) {
      case 'missing':
      case 'not_pending':
      case 'updated':
        return result;
      default:
        throw new Error('job store command failed');
    }
  }

  private key(jobId: string): string {
    return `${this.keyPrefix}${jobId}`;
  }

  async reserveInflight(caller: string, jobId: string, ttlSeconds: number): Promise<InflightReservation> {
    const key = `${this.keyPrefix}inflight:${caller}`;
    const set = await this.command(['SET', key, jobId, 'EX', String(ttlSeconds), 'NX']);
    if (set === 'OK') return { reserved: true };
    const existing = await this.command(['GET', key]);
    return { reserved: false, ...(typeof existing === 'string' ? { jobId: existing } : {}) };
  }

  async releaseInflight(caller: string, jobId: string): Promise<void> {
    const key = `${this.keyPrefix}inflight:${caller}`;
    const existing = await this.command(['GET', key]);
    if (existing === jobId) await this.command(['DEL', key]);
  }

  async consumeRate(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    const result = await this.command([
      'EVAL',
      CONSUME_RATE,
      '1',
      `${this.keyPrefix}rate:${bucket}`,
      String(windowSeconds),
      String(limit),
    ]);
    return result === 1;
  }

  async readIdempotency(caller: string, keyHash: string): Promise<string | null> {
    const result = await this.command(['GET', this.idemKey(caller, keyHash)]);
    return typeof result === 'string' ? result : null;
  }

  async writeIdempotency(caller: string, keyHash: string, jobId: string, ttlSeconds: number): Promise<void> {
    await this.command(['SET', this.idemKey(caller, keyHash), jobId, 'EX', String(ttlSeconds)]);
  }

  async deleteIdempotency(caller: string, keyHash: string): Promise<void> {
    await this.command(['DEL', this.idemKey(caller, keyHash)]);
  }

  private idemKey(caller: string, keyHash: string): string {
    return `${this.keyPrefix}idem:${caller}:${keyHash}`;
  }

  private async command(args: string[]): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(args),
        redirect: 'manual',
      });
    } catch {
      throw new Error('job store request failed');
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('job store request failed');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('job store returned invalid json');
    }
    if (!payload || typeof payload !== 'object' || !('result' in payload)) {
      throw new Error('job store returned an unexpected response');
    }
    const body = payload as { result?: unknown; error?: unknown };
    if (body.error) throw new Error('job store command failed');
    return body.result ?? null;
  }
}
