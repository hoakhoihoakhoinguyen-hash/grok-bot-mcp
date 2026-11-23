export type UrlRejection = 'invalid_url' | 'https_required' | 'host_not_allowed';

export type UrlDecision = { ok: true; href: string; host: string } | { ok: false; reason: UrlRejection };

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function parseHostAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const hosts: string[] = [];
  for (const part of raw.split(',')) {
    const host = normalizeHost(part);
    if (!host) continue;
    if (!HOSTNAME.test(host) || isBlockedHost(host)) {
      throw new Error('WEBHOOK_HOST_ALLOWLIST has an invalid hostname');
    }
    hosts.push(host);
  }
  return [...new Set(hosts)];
}

export function validatePublicHttps(value: string | undefined): UrlDecision {
  return validateHttps(value, { allowHosts: null });
}

export function validateAllowlistedHttps(value: string | undefined, allowHosts: readonly string[]): UrlDecision {
  if (allowHosts.length === 0) return { ok: false, reason: 'host_not_allowed' };
  return validateHttps(value, { allowHosts });
}

function validateHttps(value: string | undefined, options: { allowHosts: readonly string[] | null }): UrlDecision {
  if (!value) return { ok: false, reason: 'invalid_url' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'https_required' };
  if (url.username || url.password || url.search || url.hash) return { ok: false, reason: 'invalid_url' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'invalid_url' };
  const host = normalizeHost(url.hostname);
  if (!host || isBlockedHost(host) || !HOSTNAME.test(host)) return { ok: false, reason: 'invalid_url' };
  if (options.allowHosts && !options.allowHosts.includes(host)) return { ok: false, reason: 'host_not_allowed' };
  return { ok: true, href: url.href, host };
}

export function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

export function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.endsWith('.internal') || host.endsWith('.home.arpa') || host === 'metadata.google.internal') return true;
  if (host.includes(':') || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  const ipv4 = ipv4ToInt(host);
  if (ipv4 === null) return false;
  return isBlockedIpv4(ipv4);
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => (/^[0-9]{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (nums.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  const a = nums[0] ?? 0;
  const b = nums[1] ?? 0;
  const c = nums[2] ?? 0;
  const d = nums[3] ?? 0;
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function isBlockedIpv4(ip: number): boolean {
  const a = ip >>> 24;
  const b = (ip >>> 16) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}
