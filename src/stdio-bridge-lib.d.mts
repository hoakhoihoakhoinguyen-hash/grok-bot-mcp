export function validateBridgeUrl(
  value: string,
  expectedPath?: '/api/mcp' | '/api/reply-mcp',
): { ok: true; href: string } | { ok: false };

export function readPrivateSecretFile(
  filePath: string,
): { ok: true; secret: string } | { ok: false; reason: string };

export function startStdioPump(options: {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}): void;

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
