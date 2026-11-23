export function validateBridgeUrl(value: string): { ok: true; href: string } | { ok: false };

export function encodeFrame(message: unknown): Buffer;

export function takeFrame(
  buffer: Buffer,
): { message: { id?: unknown; [key: string]: unknown }; rest: Buffer } | { error: string } | null;

export function parseRpcBody(text: string): unknown;

export function forwardRpc(options: {
  fetchImpl: typeof fetch;
  url: string;
  secret: string;
  timeoutMs: number;
  message: unknown;
}): Promise<{ ok: true; message: unknown } | { ok: false; reason: string }>;
