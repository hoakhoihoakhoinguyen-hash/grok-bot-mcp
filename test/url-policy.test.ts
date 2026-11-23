import { describe, expect, it } from 'vitest';
import { configFromEnv, readUpstash } from '../src/core/config';
import { parseHostAllowlist, validateAllowlistedHttps, validatePublicHttps } from '../src/core/url-policy';

describe('url policy', () => {
  it('accepts only an exact public https host on the webhook allowlist', () => {
    expect(parseHostAllowlist(' Bot.Example ')).toEqual(['bot.example']);
    expect(validateAllowlistedHttps('https://bot.example/webhook', ['bot.example']).ok).toBe(true);
    expect(validateAllowlistedHttps('https://bot.example.evil.com/webhook', ['bot.example']).ok).toBe(false);
    expect(validateAllowlistedHttps('https://user:secret@bot.example/webhook', ['bot.example']).ok).toBe(false);
    expect(validateAllowlistedHttps('https://bot.example/webhook?token=secret', ['bot.example']).ok).toBe(false);
    expect(validateAllowlistedHttps('http://127.0.0.1/hook', ['bot.example']).ok).toBe(false);
    expect(validatePublicHttps('https://127.0.0.1/').ok).toBe(false);
    expect(validatePublicHttps('https://10.1.2.3/').ok).toBe(false);
    expect(() => parseHostAllowlist('169.254.169.254')).toThrow(/WEBHOOK_HOST_ALLOWLIST/);
    expect(() => parseHostAllowlist('*')).toThrow(/WEBHOOK_HOST_ALLOWLIST/);
  });

  it('rejects overlapping or short secrets and private storage URLs', () => {
    expect(() =>
      configFromEnv({
        REPLY_SECRET: 'same-secret-value',
        MCP_API_KEY: 'claude:same-secret-value',
        PUBLIC_BASE_URL: 'https://mcp.example',
      }),
    ).toThrow(/different/);
    expect(() => configFromEnv({ REPLY_SECRET: 'short-secret' })).toThrow(/REPLY_SECRET/);
    expect(() => readUpstash({ UPSTASH_REDIS_REST_URL: 'http://redis.example', UPSTASH_REDIS_REST_TOKEN: 'token-value' })).toThrow(
      /UPSTASH_REDIS_REST_URL/,
    );
    expect(() => readUpstash({ UPSTASH_REDIS_REST_URL: 'https://127.0.0.1', UPSTASH_REDIS_REST_TOKEN: 'token-value' })).toThrow(
      /UPSTASH_REDIS_REST_URL/,
    );
  });
});
