import { resolve4, resolve6 } from "node:dns/promises";

/**
 * Private/internal IPv4 ranges that must be blocked to prevent SSRF.
 * Each entry: [network address as 32-bit integer, subnet mask as 32-bit integer]
 */
const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0x7f000000, 0xff000000], // 127.0.0.0/8
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
  [0x00000000, 0xff000000], // 0.0.0.0/8
];

/**
 * Blocked IPv6 prefixes (checked as string prefixes after normalization).
 */
const BLOCKED_IPV6_PREFIXES = ["::1", "fc", "fd", "fe80"];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  // eslint-disable-next-line no-bitwise
  return ((+parts[0]! << 24) | (+parts[1]! << 16) | (+parts[2]! << 8) | +parts[3]!) >>> 0;
}

function isBlockedIPv4(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some(
    // eslint-disable-next-line no-bitwise
    ([network, mask]) => (addr & mask) >>> 0 === network,
  );
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 address.
 * Handles both dotted notation (::ffff:192.168.1.1, from DNS) and
 * hex notation (::ffff:c0a8:101, from URL parser normalization).
 */
function extractMappedIPv4(ip: string): string | null {
  // Dotted notation: ::ffff:X.X.X.X
  const dotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1]!;

  // Hex notation: ::ffff:XXXX:XXXX
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    // eslint-disable-next-line no-bitwise
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true;

  // IPv4-mapped IPv6 — extract and check the embedded IPv4 address
  const mappedV4 = extractMappedIPv4(normalized);
  if (mappedV4) return isBlockedIPv4(mappedV4);

  return BLOCKED_IPV6_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Validates that a URL does not resolve to an internal/private IP address.
 * Throws an error if the URL targets a blocked address range.
 *
 * Must be called before fetching any externally-provided URL to prevent SSRF.
 */
export async function assertNotInternalUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid cover URL: ${url}`);
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // Check if hostname is already an IPv4 literal
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    if (isBlockedIPv4(hostname)) {
      throw new Error(`Blocked internal IP in cover URL: ${hostname}`);
    }
    return;
  }

  // Check if hostname is an IPv6 literal (URL parser may keep brackets)
  const bareHost = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (bareHost.includes(":")) {
    if (isBlockedIPv6(bareHost)) {
      throw new Error(`Blocked internal IPv6 in cover URL: ${bareHost}`);
    }
    return;
  }

  // Resolve hostname to IPs and check all of them
  const ipv4s = await resolve4(hostname).catch(() => [] as string[]);
  const ipv6s = await resolve6(hostname).catch(() => [] as string[]);

  if (ipv4s.length === 0 && ipv6s.length === 0) {
    throw new Error(`Cannot resolve cover URL hostname: ${hostname}`);
  }

  for (const ip of ipv4s) {
    if (isBlockedIPv4(ip)) {
      throw new Error(`Cover URL hostname ${hostname} resolves to blocked IP: ${ip}`);
    }
  }

  for (const ip of ipv6s) {
    if (isBlockedIPv6(ip)) {
      throw new Error(`Cover URL hostname ${hostname} resolves to blocked IPv6: ${ip}`);
    }
  }
}
