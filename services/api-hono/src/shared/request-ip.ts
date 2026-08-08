import { BlockList, isIP, SocketAddress } from "node:net";
import { createHash } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppVariables } from "../context.js";

type AppContext = Context<{ Variables: AppVariables }>;

const INTERNAL_CLIENT_IP_HEADER = "x-libris-client-ip";
const trustedProxyCache = new Map<string, BlockList>();

function stripAddressDecorations(address: string): string {
  const unbracketed =
    address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  return unbracketed.split("%")[0] ?? unbracketed;
}

/** `::ffff:a.b.c.d` — the canonical spelling SocketAddress gives every mapped form. */
const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export function normalizeIpAddress(address: string): string | null {
  const bare = stripAddressDecorations(address.trim());
  const family = isIP(bare);
  if (family === 4) return SocketAddress.parse(`${bare}:0`)?.address ?? null;
  if (family !== 6) return null;

  const canonical = SocketAddress.parse(`[${bare}]:0`)?.address ?? null;
  if (!canonical) return null;

  // `serve({ port })` listens on :: with no host, so a dual-stack kernel hands
  // every IPv4 peer over as an IPv4-mapped address. Unwrap it here, once, so
  // that every consumer — rate-limit buckets, access logs, the Better Auth
  // client-IP header, trusted-proxy CIDR matching — sees the same dotted quad
  // a single-stack listener would have produced. Without this, isIP() reports
  // 6 and getIpRateLimitKey() aggregates the entire IPv4 internet into the
  // single 0:0:0:0::/64 bucket.
  const embedded = IPV4_MAPPED.exec(canonical)?.[1];
  if (embedded && isIP(embedded) === 4) {
    return SocketAddress.parse(`${embedded}:0`)?.address ?? canonical;
  }
  return canonical;
}

export function isValidProxyCidr(value: string): boolean {
  const [address, prefixText, ...extra] = value.split("/");
  if (!address || extra.length > 0) return false;
  const normalized = normalizeIpAddress(address);
  if (!normalized) return false;
  const family = isIP(normalized);
  if (prefixText === undefined) return true;
  if (!/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  if (prefix < 0 || prefix > (family === 4 ? 32 : 128)) return false;
  try {
    const probe = new BlockList();
    probe.addSubnet(normalized, prefix, family === 4 ? "ipv4" : "ipv6");
    return true;
  } catch {
    return false;
  }
}

function getTrustedProxyBlockList(entries: readonly string[]): BlockList {
  const cacheKey = entries.join(",");
  const cached = trustedProxyCache.get(cacheKey);
  if (cached) return cached;

  const blockList = new BlockList();
  for (const entry of entries) {
    const [rawAddress, rawPrefix] = entry.split("/");
    const address = normalizeIpAddress(rawAddress ?? "");
    if (!address) continue;
    const family = isIP(address);
    const type = family === 4 ? "ipv4" : "ipv6";
    const prefix = rawPrefix === undefined ? (family === 4 ? 32 : 128) : Number(rawPrefix);
    blockList.addSubnet(address, prefix, type);
  }
  trustedProxyCache.set(cacheKey, blockList);
  return blockList;
}

function isTrustedProxy(address: string, entries: readonly string[]): boolean {
  const normalized = normalizeIpAddress(address);
  if (!normalized || entries.length === 0) return false;
  return getTrustedProxyBlockList(entries).check(
    normalized,
    isIP(normalized) === 4 ? "ipv4" : "ipv6",
  );
}

function getConnectionIp(c: AppContext): string | null {
  try {
    const address = getConnInfo(c).remote.address;
    return address ? normalizeIpAddress(address) : null;
  } catch {
    return null;
  }
}

function resolveForwardedIp(
  c: AppContext,
  peerIp: string,
  trustedProxies: readonly string[],
): string {
  if (!isTrustedProxy(peerIp, trustedProxies)) return peerIp;

  const forwardedFor = c.req.header("x-forwarded-for");
  if (forwardedFor) {
    const chain = forwardedFor.split(",").map((entry) => normalizeIpAddress(entry));
    if (chain.some((entry) => entry === null)) return peerIp;
    for (let index = chain.length - 1; index >= 0; index--) {
      const hop = chain[index];
      if (hop && !isTrustedProxy(hop, trustedProxies)) return hop;
    }
    return peerIp;
  }

  const realIp = normalizeIpAddress(c.req.header("x-real-ip") ?? "");
  return realIp ?? peerIp;
}

export function getRequestIp(c: AppContext): string {
  const env = c.get("env");
  const peerIp = getConnectionIp(c);
  if (!peerIp) {
    // Hono's in-memory app.request() adapter has no socket. Production traffic
    // through @hono/node-server always does; tests get a deterministic local
    // identity while a real unidentifiable request fails closed.
    if (env.NODE_ENV === "test") return "127.0.0.1";
    throw new HTTPException(400, { message: "Unable to determine client address" });
  }
  if (env.TRUST_PROXY_HEADERS !== "1") return peerIp;
  return resolveForwardedIp(c, peerIp, env.LIBRIS_TRUSTED_PROXIES);
}

function expandIpv6(address: string): number[] | null {
  let value = address;
  const ipv4Match = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const bytes = ipv4Match[1]!.split(".").map(Number);
    if (bytes.length !== 4 || bytes.some((byte) => byte < 0 || byte > 255)) return null;
    value =
      value.slice(0, -ipv4Match[1]!.length) +
      `${((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)}:${((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

/** Aggregate IPv6 callers by their routinely delegated /64 network. */
export function getIpRateLimitKey(address: string): string {
  const normalized = normalizeIpAddress(address);
  if (!normalized || isIP(normalized) === 4) return normalized ?? address;
  const parts = expandIpv6(normalized);
  if (!parts) return normalized;
  return `${parts
    .slice(0, 4)
    .map((part) => part.toString(16))
    .join(":")}::/64`;
}

export function getCredentialRateLimitKey(identifier: string): string {
  return `credential:${createHash("sha256").update(identifier.trim().toLowerCase()).digest("hex")}`;
}

/**
 * The headers to hand Better Auth for this request — the ONLY supported way.
 *
 * lib/auth.ts configures `advanced.ipAddress.ipAddressHeaders` to a single
 * private header, on the invariant that no Request reaching Better Auth ever
 * carries a client-supplied value for it. That invariant used to be held by
 * three independent open-coded copies of "copy the headers, overwrite the
 * private one", one per call site — and libris-59m.42 was exactly one of those
 * copies being missing, so `lastAdminMiddleware` handed Better Auth whatever
 * address the client claimed.
 *
 * A helper that takes the Context is what makes the safe form the SHORTEST form
 * to write: there is nothing to remember to pass, and the raw-headers spelling
 * is now strictly more typing than the correct one. The private
 * header-rewriting primitive is deliberately NOT exported, so the compiler —
 * not a convention — is what stops a fourth copy appearing.
 * `request-ip.test.ts` pins the remaining call-site rules that types cannot
 * express.
 *
 * The header is DELETED rather than left alone when `clientIp` is unset (a
 * request stack assembled without `clientIpMiddleware`, which only happens in
 * tests): absent means Better Auth records no address, whereas passing the
 * client's own value through would be recording a forged one.
 */
export function sessionHeaders(c: AppContext): Headers {
  const trusted = new Headers(c.req.raw.headers);
  const clientIp = c.get("clientIp");
  if (clientIp) trusted.set(INTERNAL_CLIENT_IP_HEADER, clientIp);
  else trusted.delete(INTERNAL_CLIENT_IP_HEADER);
  return trusted;
}

export const betterAuthClientIpHeader = INTERNAL_CLIENT_IP_HEADER;
