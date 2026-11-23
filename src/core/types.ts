export type JobStatus = 'pending' | 'done' | 'error';

export interface JobRecord {
  status: JobStatus;
  caller: string;
  createdAt: number;
  reply?: string;
  error?: string;
}

export type CompleteResult = 'updated' | 'missing' | 'not_pending';

export type InflightReservation = { reserved: true } | { reserved: false; jobId?: string };

export interface JobStore {
  create(jobId: string, job: JobRecord, ttlSeconds: number): Promise<boolean>;
  get(jobId: string): Promise<JobRecord | null>;
  complete(jobId: string, job: JobRecord, ttlSeconds: number): Promise<CompleteResult>;
  reserveInflight(caller: string, jobId: string, ttlSeconds: number): Promise<InflightReservation>;
  releaseInflight(caller: string, jobId: string): Promise<void>;
  consumeRate(bucket: string, limit: number, windowSeconds: number): Promise<boolean>;
  readIdempotency(caller: string, keyHash: string): Promise<string | null>;
  writeIdempotency(caller: string, keyHash: string, jobId: string, ttlSeconds: number): Promise<void>;
  deleteIdempotency(caller: string, keyHash: string): Promise<void>;
}

export interface NamedKey {
  name: string;
  secret: string;
}

export interface AppConfig {
  webhookUrl: string | undefined;
  webhookKey: string | undefined;
  webhookAllowHosts: string[];
  replySecret: string | undefined;
  apiKeys: NamedKey[];
  publicBaseUrl: string | undefined;
  waitSeconds: number;
  jobTtlSeconds: number;
  maxMessageBytes: number;
  webhookTimeoutMs: number;
  pollIntervalMs: number;
}

export type LogFields = Record<string, string | number | boolean>;

export type LogFn = (event: string, fields: LogFields) => void;

export interface AppDeps {
  config: AppConfig;
  store: JobStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: LogFn;
}
