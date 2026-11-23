import { parseJobRecord } from './job-record';
import type { CompleteResult, InflightReservation, JobRecord, JobStore } from './types';

interface Entry {
  raw: string;
  expiresAt: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Entry>();
  private readonly inflight = new Map<string, { jobId: string; expiresAt: number }>();
  private readonly rates = new Map<string, Counter>();
  private readonly idempotency = new Map<string, { jobId: string; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async create(jobId: string, job: JobRecord, ttlSeconds: number): Promise<boolean> {
    if (this.read(jobId)) return false;
    this.jobs.set(jobId, {
      raw: JSON.stringify(job),
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async get(jobId: string): Promise<JobRecord | null> {
    return this.read(jobId);
  }

  async complete(jobId: string, job: JobRecord, _ttlSeconds: number): Promise<CompleteResult> {
    const current = this.read(jobId);
    if (!current) return 'missing';
    if (current.status !== 'pending') return 'not_pending';
    const existing = this.jobs.get(jobId);
    if (!existing) return 'missing';
    if (existing.expiresAt - this.now() <= 0) {
      this.jobs.delete(jobId);
      return 'missing';
    }
    this.jobs.set(jobId, { raw: JSON.stringify(job), expiresAt: existing.expiresAt });
    return 'updated';
  }

  async reserveInflight(caller: string, jobId: string, ttlSeconds: number): Promise<InflightReservation> {
    const current = this.readInflight(caller);
    if (current) return { reserved: false, jobId: current };
    this.inflight.set(caller, { jobId, expiresAt: this.now() + ttlSeconds * 1000 });
    return { reserved: true };
  }

  async releaseInflight(caller: string, jobId: string): Promise<void> {
    const current = this.inflight.get(caller);
    if (current?.jobId === jobId) this.inflight.delete(caller);
  }

  async consumeRate(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    const now = this.now();
    const current = this.rates.get(bucket);
    if (!current || now >= current.resetAt) {
      this.rates.set(bucket, { count: 1, resetAt: now + windowSeconds * 1000 });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  async readIdempotency(caller: string, keyHash: string): Promise<string | null> {
    const entry = this.idempotency.get(this.idemKey(caller, keyHash));
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.idempotency.delete(this.idemKey(caller, keyHash));
      return null;
    }
    return entry.jobId;
  }

  async writeIdempotency(caller: string, keyHash: string, jobId: string, ttlSeconds: number): Promise<void> {
    this.idempotency.set(this.idemKey(caller, keyHash), {
      jobId,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async deleteIdempotency(caller: string, keyHash: string): Promise<void> {
    this.idempotency.delete(this.idemKey(caller, keyHash));
  }

  private readInflight(caller: string): string | null {
    const entry = this.inflight.get(caller);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.inflight.delete(caller);
      return null;
    }
    return entry.jobId;
  }

  private idemKey(caller: string, keyHash: string): string {
    return `${caller}:${keyHash}`;
  }

  private read(jobId: string): JobRecord | null {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.jobs.delete(jobId);
      return null;
    }
    return parseJobRecord(entry.raw);
  }
}
