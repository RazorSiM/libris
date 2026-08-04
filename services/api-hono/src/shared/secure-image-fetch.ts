import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, SocketAddress } from "node:net";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface SecureImageFetchDependencies {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  request(
    url: URL,
    address: ResolvedAddress,
    timeoutMs: number,
    maxBytes: number,
  ): Promise<RawHttpResponse>;
}

export interface SecureImageFetchOptions {
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  /** Exact HTTP(S) origins permitted to resolve to otherwise blocked addresses. */
  allowedOrigins?: readonly string[];
}

export interface SecureImageResult {
  data: Buffer;
  contentType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  finalUrl: string;
}

const blockedAddresses = new BlockList();

// Public cover URLs must not become a path into the host or its surrounding
// network. Keep these ranges aligned with the IANA special-purpose registries;
// transition prefixes that can encode another address are blocked as a unit.
// Trusted private origins belong in LIBRIS_COVER_FETCH_ALLOWLIST instead.
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

blockedAddresses.addAddress("::", "ipv6");
blockedAddresses.addAddress("::1", "ipv6");
for (const [network, prefix] of [
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function normalizeAddress(address: string): { address: string; family: 4 | 6 } | null {
  const bareAddress = address.startsWith("[") ? address.slice(1, -1) : address;
  const family = isIP(bareAddress);
  if (family === 4) {
    const parsed = SocketAddress.parse(`${bareAddress}:0`);
    return parsed ? { address: parsed.address, family } : null;
  }
  if (family === 6) {
    const parsed = SocketAddress.parse(`[${bareAddress}]:0`);
    return parsed ? { address: parsed.address, family } : null;
  }
  return null;
}

export function isBlockedAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  if (!normalized) return true;
  return blockedAddresses.check(normalized.address, normalized.family === 4 ? "ipv4" : "ipv6");
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  const literal = normalizeAddress(hostname);
  if (literal) return [literal];
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

function defaultRequest(
  url: URL,
  pinnedAddress: ResolvedAddress,
  timeoutMs: number,
  maxBytes: number,
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const originalHostname = url.hostname.startsWith("[")
      ? url.hostname.slice(1, -1)
      : url.hostname;
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: pinnedAddress.address,
        family: pinnedAddress.family,
        port: url.port || undefined,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: {
          Host: url.host,
          Accept: "image/jpeg,image/png,image/webp,image/gif",
        },
        servername: isIP(originalHostname) ? undefined : originalHostname,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers[name.toLowerCase()] = String(value);
        }

        if (REDIRECT_STATUSES.has(response.statusCode ?? 0)) {
          response.resume();
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.alloc(0) });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new Error(`Image response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const defaultDependencies: SecureImageFetchDependencies = {
  resolve: defaultResolve,
  request: defaultRequest,
};

function parseHttpUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new Error(`Invalid cover URL: ${String(value)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("Cover URLs must not contain credentials");
  }
  return url;
}

async function resolvePublicAddress(
  url: URL,
  dependencies: SecureImageFetchDependencies,
  allowedOrigins: ReadonlySet<string>,
): Promise<ResolvedAddress> {
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const literal = normalizeAddress(hostname);
  const answers = literal ? [literal] : await dependencies.resolve(hostname);
  if (answers.length === 0) throw new Error(`Cannot resolve cover URL hostname: ${hostname}`);
  for (const answer of answers) {
    if (isBlockedAddress(answer.address)) {
      if (allowedOrigins.has(url.origin)) continue;
      throw new Error(`Cover URL hostname ${hostname} resolves to blocked IP: ${answer.address}`);
    }
  }
  return answers[0]!;
}

function detectImageType(data: Buffer): SecureImageResult["contentType"] | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  const prefix = data.subarray(0, 6).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return "image/gif";
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function fetchExternalImage(
  initialUrl: string,
  options: SecureImageFetchOptions = {},
  dependencies: SecureImageFetchDependencies = defaultDependencies,
): Promise<SecureImageResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  let url = parseHttpUrl(initialUrl);

  for (let hop = 0; ; hop++) {
    const address = await resolvePublicAddress(url, dependencies, allowedOrigins);
    const response = await dependencies.request(url, address, timeoutMs, maxBytes);

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.location;
      if (!location) throw new Error("Cover redirect is missing a Location header");
      if (hop >= maxRedirects) throw new Error("Cover redirect limit exceeded");
      url = parseHttpUrl(new URL(location, url));
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Cover request failed with HTTP ${response.status}`);
    }
    if (response.body.length > maxBytes) {
      throw new Error(`Image response exceeds ${maxBytes} bytes`);
    }

    const declaredType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (!declaredType?.startsWith("image/")) {
      throw new Error("Cover response has a missing or invalid Content-Type");
    }
    const detectedType = detectImageType(response.body);
    if (!detectedType) throw new Error("Cover response has an invalid image signature");
    if (declaredType !== detectedType) {
      throw new Error(`Cover Content-Type ${declaredType} does not match ${detectedType} bytes`);
    }

    return { data: response.body, contentType: detectedType, finalUrl: url.href };
  }
}

export async function assertNotInternalUrl(url: string): Promise<void> {
  await resolvePublicAddress(parseHttpUrl(url), defaultDependencies, new Set());
}
