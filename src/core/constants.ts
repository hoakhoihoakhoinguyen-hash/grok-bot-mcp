export const SERVER_NAME = 'grok-bot-mcp';
export const SERVER_VERSION = '0.2.0';

export const DEFAULT_WAIT_SECONDS = 0;
export const MAX_WAIT_SECONDS = 5;
export const DEFAULT_JOB_TTL_SECONDS = 15 * 60;
export const MAX_JOB_TTL_SECONDS = 60 * 60;
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024;
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 8_000;
export const DEFAULT_POLL_INTERVAL_MS = 200;

export const MAX_REPLY_BYTES = 64 * 1024;
export const MAX_REPLY_BODY_BYTES = 128 * 1024;
export const MAX_THREAD_ID_CHARS = 256;
export const MAX_KEY_NAME_CHARS = 64;
export const MIN_KV_TTL_SECONDS = 60;
export const MIN_SECRET_CHARS = 16;

export const MAX_INFLIGHT_PER_CALLER = 1;
export const ASK_ATTEMPT_LIMIT = 6;
export const ASK_WINDOW_SECONDS = 600;
export const READ_ATTEMPT_LIMIT = 12;
export const READ_WINDOW_SECONDS = 600;
export const SUBMIT_ATTEMPT_LIMIT = 6;
export const SUBMIT_WINDOW_SECONDS = 600;

export const WEBHOOK_TIMEOUT_MS = DEFAULT_WEBHOOK_TIMEOUT_MS;
