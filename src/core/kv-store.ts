import { MIN_KV_TTL_SECONDS } from './constants';
import { parseJobRecord, remainingTtlSeconds } from './job-record';
import type { CompleteResult, InflightReservation, JobRecord, JobStore } from './types';

export interface KvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export class KvJobStore implements JobStore {
  constructor(
    private readonly kv: KvBinding,
    private readonly now: () => number = () => Date.now(),
    private readonly keyPrefix = 'job:',
  ) {}

  async create(jobId: string, job: JobRecord, ttlSeconds: number): Promise<boolean> {
    const key = this.key(jobId);
    const existing = await this.kv.get(key);
    if (existing !== null) return false;
    await this.kv.put(key, JSON.stringify(job), { expirationTtl: kvTtl(ttlSeconds) });
    return true;
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const raw = await this.kv.get(this.key(jobId));
    if (raw === null) return null;
    return parseJobRecord(raw);
  }

  /**
   * Workers KV cannot compare-and-set. Two callbacks that both read `pending`
   * can both write, and the later write wins. Job ids are random and the bot
   * replies once, so that race is acceptable. Use Upstash when a second reply
   * must fail instead of replacing the first.
   */
  async complete(jobId: string, job: JobRecord, ttlSeconds: number): Promise<CompleteResult> {
    const current = await this.get(jobId);
    if (!current) return 'missing';
    if (current.status !== 'pending') return 'not_pending';
    const remaining = remainingTtlSeconds(current, this.now(), ttlSeconds);
    if (remaining <= 0) return 'missing';
    await this.kv.put(this.key(jobId), JSON.stringify(job), { expirationTtl: kvTtl(remaining) });
    return 'updated';
  }

  private key(jobId: string): string {
    return `${this.keyPrefix}${jobId}`;
  }

  async reserveInflight(caller: string, jobId: string, ttlSeconds: number): Promise<InflightReservation> {
    const key = `inflight:${caller}`;
    const existing = await this.kv.get(key);
    if (existing) return { reserved: false, jobId: existing };
    await this.kv.put(key, jobId, { expirationTtl: kvTtl(ttlSeconds) });
    return { reserved: true };
  }

  async releaseInflight(caller: string, jobId: string): Promise<void> {
    const key = `inflight:${caller}`;
    const existing = await this.kv.get(key);
    if (existing === jobId) await this.kv.delete(key);
  }

  async consumeRate(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    const key = `rate:${bucket}`;
    const now = this.now();
    const raw = await this.kv.get(key);
    let count = 0;
    let resetAt = now + windowSeconds * 1000;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { count?: number; resetAt?: number };
        if (typeof parsed.resetAt === 'number' && now < parsed.resetAt) {
          count = typeof parsed.count === 'number' ? parsed.count : 0;
          resetAt = parsed.resetAt;
        }
      } catch {
        count = 0;
      }
    }
    if (count >= limit) return false;
    await this.kv.put(key, JSON.stringify({ count: count + 1, resetAt }), { expirationTtl: kvTtl(windowSeconds) });
    return true;
  }

  async readIdempotency(caller: string, keyHash: string): Promise<string | null> {
    const value = await this.kv.get(`idem:${caller}:${keyHash}`);
    return value || null;
  }

  async writeIdempotency(caller: string, keyHash: string, jobId: string, ttlSeconds: number): Promise<void> {
    await this.kv.put(`idem:${caller}:${keyHash}`, jobId, { expirationTtl: kvTtl(ttlSeconds) });
  }

  async deleteIdempotency(caller: string, keyHash: string): Promise<void> {
    await this.kv.delete(`idem:${caller}:${keyHash}`);
  }
}

function kvTtl(seconds: number): number {
  return Math.max(MIN_KV_TTL_SECONDS, seconds);
}
