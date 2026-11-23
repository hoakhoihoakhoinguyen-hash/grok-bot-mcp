import {
  DEFAULT_JOB_TTL_SECONDS,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_SECONDS,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  MAX_JOB_TTL_SECONDS,
  MAX_WAIT_SECONDS,
  MIN_KV_TTL_SECONDS,
  MIN_SECRET_CHARS,
} from './constants';
import { parseApiKeys } from './auth';
import type { AppConfig } from './types';
import { parseHostAllowlist, validatePublicHttps } from './url-policy';

export type EnvMap = Record<string, string | undefined>;

export function configFromEnv(env: EnvMap): AppConfig {
  return {
    webhookUrl: clean(env.GROK_BOT_WEBHOOK_URL),
    webhookKey: clean(env.GROK_BOT_WEBHOOK_KEY),
    replySecret: clean(env.REPLY_SECRET),
    apiKeys: checkedKeys(env),
    webhookAllowHosts: parseHostAllowlist(env.WEBHOOK_HOST_ALLOWLIST),
    publicBaseUrl: optionalPublicHttps(env.PUBLIC_BASE_URL),
    waitSeconds: integerEnv(env.WAIT_SECONDS, DEFAULT_WAIT_SECONDS, 0, MAX_WAIT_SECONDS),
    jobTtlSeconds: integerEnv(env.JOB_TTL_SECONDS, DEFAULT_JOB_TTL_SECONDS, MIN_KV_TTL_SECONDS, MAX_JOB_TTL_SECONDS),
    maxMessageBytes: integerEnv(env.MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES, 1, 64 * 1024),
    webhookTimeoutMs: integerEnv(env.WEBHOOK_TIMEOUT_MS, DEFAULT_WEBHOOK_TIMEOUT_MS, 1000, 30_000),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
}

export interface UpstashCredentials {
  url: string;
  token: string;
}

export function readUpstash(env: EnvMap): UpstashCredentials | null {
  const upstashUrl = clean(env.UPSTASH_REDIS_REST_URL);
  const upstashToken = clean(env.UPSTASH_REDIS_REST_TOKEN);
  if (upstashUrl || upstashToken) {
    if (!upstashUrl || !upstashToken) {
      throw new Error('Incomplete Upstash Redis REST configuration. Set both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
    }
    return { url: requirePublicHttps(stripTrailingSlash(upstashUrl), 'UPSTASH_REDIS_REST_URL'), token: upstashToken };
  }

  const kvUrl = clean(env.KV_REST_API_URL);
  const kvToken = clean(env.KV_REST_API_TOKEN);
  if (kvUrl || kvToken) {
    if (!kvUrl || !kvToken) {
      throw new Error('Incomplete Vercel KV REST configuration. Set both KV_REST_API_URL and KV_REST_API_TOKEN.');
    }
    return { url: requirePublicHttps(stripTrailingSlash(kvUrl), 'KV_REST_API_URL'), token: kvToken };
  }

  return null;
}

function checkedKeys(env: EnvMap) {
  const replySecret = clean(env.REPLY_SECRET);
  const keys = parseApiKeys(env.MCP_API_KEY);
  if (replySecret && replySecret.length < MIN_SECRET_CHARS) {
    throw new Error(`REPLY_SECRET must be at least ${MIN_SECRET_CHARS} characters`);
  }
  for (const key of keys) {
    if (key.secret.length < MIN_SECRET_CHARS) {
      throw new Error(`MCP_API_KEY secrets must be at least ${MIN_SECRET_CHARS} characters`);
    }
    if (replySecret && key.secret === replySecret) {
      throw new Error('REPLY_SECRET must be different from every MCP_API_KEY secret');
    }
  }
  return keys;
}

function optionalPublicHttps(value: string | undefined): string | undefined {
  const cleaned = stripTrailingSlash(clean(value));
  if (!cleaned) return undefined;
  return requirePublicHttps(cleaned, 'PUBLIC_BASE_URL');
}

function requirePublicHttps(value: string, name: string): string {
  const decision = validatePublicHttps(value);
  if (!decision.ok) throw new Error(`${name} must be a public https URL without userinfo, query, or a non-443 port`);
  return decision.href.replace(/\/+$/, '');
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stripTrailingSlash(value: string): string;
function stripTrailingSlash(value: string | undefined): string | undefined;
function stripTrailingSlash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\/+$/, '');
}

function integerEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
