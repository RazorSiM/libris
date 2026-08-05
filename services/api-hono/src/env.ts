import { z } from "zod";
import { resolveDatabaseUrl } from "./lib/resolve-database-url";
import { resolveRedisUrl } from "./lib/resolve-redis-url";
import { isValidProxyCidr } from "./shared/request-ip.js";

const CoverFetchAllowlistSchema = z
  .string()
  .default("")
  .transform((value, ctx): string[] => {
    const origins: string[] = [];
    for (const entry of value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)) {
      try {
        const url = new URL(entry);
        if (
          (url.protocol !== "http:" && url.protocol !== "https:") ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        ) {
          throw new Error("not an HTTP(S) origin");
        }
        origins.push(url.origin);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: `Invalid cover-fetch allowlist origin: ${entry}`,
        });
      }
    }
    return origins;
  });

const KNOWN_API_SECRET_PLACEHOLDERS = new Set(["change-me-generate-with-openssl-rand-hex-32"]);

const ApiSecretSchema = z
  .string()
  .min(32, "API_SECRET_KEY must be at least 32 characters")
  .refine(
    (value) => !KNOWN_API_SECRET_PLACEHOLDERS.has(value),
    "API_SECRET_KEY is a published placeholder; generate one with: openssl rand -hex 32",
  )
  .refine(
    (value) => new Set(value).size >= 8,
    "API_SECRET_KEY has too little character diversity; generate one with: openssl rand -hex 32",
  );

const TrustedProxiesSchema = z
  .string()
  .default("")
  .transform((value, ctx): string[] => {
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const entry of entries) {
      if (!isValidProxyCidr(entry)) {
        ctx.addIssue({ code: "custom", message: `Invalid trusted-proxy IP or CIDR: ${entry}` });
      }
    }
    return entries;
  });

const RawEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  PORT: z.coerce.number().default(3000),
  POSTGRES_HOST: z.string().optional(),
  POSTGRES_PORT: z.string().optional(),
  POSTGRES_USER: z.string().optional(),
  POSTGRES_PASSWORD: z.string().optional(),
  POSTGRES_DB: z.string().optional(),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.string().optional(),
  REDIS_USER: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z.string().optional(),
  LIBRIS_INBOX_PATH: z.string().min(1, "LIBRIS_INBOX_PATH is required"),
  LIBRIS_LIBRARY_PATH: z.string().min(1, "LIBRIS_LIBRARY_PATH is required"),
  LIBRIS_COVER_FETCH_ALLOWLIST: CoverFetchAllowlistSchema,
  API_SECRET_KEY: ApiSecretSchema,
  // Signs Better Auth session cookies. Required with no fallback to
  // API_SECRET_KEY: the two rotate independently, and silently reusing a
  // long-lived secret for session signing is worse than failing to boot.
  // Adding this is a breaking change for existing deployments.
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  // Optional. When empty, Better Auth derives its origin from the incoming
  // request, which is what production wants: the container listens on http
  // while Traefik terminates https, so any hardcoded value would be wrong.
  // Set it only when the public URL cannot be inferred.
  BETTER_AUTH_URL: z.string().default(""),
  LIBRIS_COOKIE_SECURE: z.enum(["0", "1"]).default("1"),
  MIGRATIONS_PATH: z.string().default("./migrations"),
  TRUST_PROXY_HEADERS: z.enum(["0", "1"]).default("0"),
  LIBRIS_TRUSTED_PROXIES: TrustedProxiesSchema,
  E2E_TEST: z.string().default(""),
  TEST_ROUTE_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  // Rate limit defaults are sized for LAN/VPN deployments. Tighten if exposing publicly.
  LIBRIS_RATELIMIT_GENERAL_LIMIT: z.coerce.number().int().positive().default(600),
  LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  LIBRIS_RATELIMIT_AUTH_LIMIT: z.coerce.number().int().positive().default(30),
  LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: z.coerce.number().int().positive().default(30),
  LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  LIBRIS_HTTP_HEADERS_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  LIBRIS_HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  LIBRIS_HTTP_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

const EnvSchema = RawEnvSchema.transform((raw, ctx) => {
  if (raw.TRUST_PROXY_HEADERS === "1" && raw.LIBRIS_TRUSTED_PROXIES.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["LIBRIS_TRUSTED_PROXIES"],
      message: "LIBRIS_TRUSTED_PROXIES must contain the reverse proxy IP or CIDR",
    });
    return z.NEVER;
  }
  const databaseUrl = resolveDatabaseUrl(raw);
  if (!databaseUrl) {
    ctx.addIssue({
      code: "custom",
      path: ["POSTGRES_HOST"],
      message:
        "Postgres config missing: set POSTGRES_{HOST,USER,PASSWORD,DB} (POSTGRES_PORT defaults to 5432).",
    });
    return z.NEVER;
  }

  const redisUrl = resolveRedisUrl(raw);
  if (!redisUrl) {
    ctx.addIssue({
      code: "custom",
      path: ["REDIS_HOST"],
      message:
        "Redis config missing: set REDIS_HOST (REDIS_PORT defaults to 6379; set REDIS_TLS=1 for rediss://).",
    });
    return z.NEVER;
  }

  return { ...raw, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl };
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate a raw environment. Exported so the validation rules can be
 * tested directly, without the module-level cache getEnv() keeps.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  return EnvSchema.parse(raw);
}

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = parseEnv(process.env);
  }
  return _env;
}

/** Override env for tests. */
export function __setTestEnv(env: Env): void {
  _env = env;
}

export function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" && { tls: {} }),
  };
}
