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

/**
 * Every value that has ever shipped pre-filled in .env.example, for any secret.
 *
 * One shared set rather than one per variable: a placeholder that leaked into
 * the repository is public whichever variable it was written next to, and an
 * operator who pastes the wrong line is exactly the failure this catches.
 */
const KNOWN_SECRET_PLACEHOLDERS = new Set([
  "change-me-generate-with-openssl-rand-hex-32",
  "change-me-generate-with-openssl-rand-base64-32",
]);

/**
 * A required, high-entropy secret.
 *
 * Length alone is not a check: the placeholder that used to ship for
 * BETTER_AUTH_SECRET was 46 characters and passed `min(32)` happily
 * (libris-59m.2). Both secrets now fail for the same reasons with the same
 * message shape, so neither can quietly drift weaker than the other.
 */
function secretSchema(name: string, generateCommand: string) {
  return z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .refine(
      (value) => !KNOWN_SECRET_PLACEHOLDERS.has(value),
      `${name} is a published placeholder; generate one with: ${generateCommand}`,
    )
    .refine(
      (value) => new Set(value).size >= 8,
      `${name} has too little character diversity; generate one with: ${generateCommand}`,
    );
}

const ApiSecretSchema = secretSchema("API_SECRET_KEY", "openssl rand -hex 32");
const BetterAuthSecretSchema = secretSchema("BETTER_AUTH_SECRET", "openssl rand -base64 32");

/**
 * The public origin users reach, e.g. `https://libris.example.com`.
 *
 * A bare origin, not a URL with a path: Better Auth appends its own basePath
 * (`/api/auth`), so a value carrying one produces a subtly wrong cookie and
 * redirect origin rather than an error. Credentials, query and fragment are
 * refused for the same reason.
 */
const BetterAuthUrlSchema = z
  .string()
  .default("")
  .superRefine((value, ctx) => {
    if (!value) return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "BETTER_AUTH_URL must be an absolute http(s) origin, e.g. https://libris.example.com",
      });
      return;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "BETTER_AUTH_URL must be a bare http(s) origin with no path, query or credentials, e.g. https://libris.example.com",
      });
    }
  });

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
  BETTER_AUTH_SECRET: BetterAuthSecretSchema,
  // REQUIRED in production — see the cross-field check below.
  //
  // Better Auth does NOT infer an https origin behind a TLS-terminating proxy.
  // With no baseURL it falls through to `getOrigin(request.url)`, which
  // @hono/node-server builds from the socket, so the container's plain-http
  // origin becomes the ONLY trusted origin and every browser request carrying
  // `Origin: https://...` is answered 403 INVALID_ORIGIN (libris-59m.1).
  // Deriving it from x-forwarded-* would need advanced.trustedProxyHeaders,
  // which makes a client-settable header authoritative for the auth origin.
  // Naming the origin explicitly is the safer answer.
  BETTER_AUTH_URL: BetterAuthUrlSchema,
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
  // Fail at boot rather than at first sign-in: without this the server starts
  // cleanly, serves the SPA, and then 403s every authentication attempt with a
  // message that points at the browser rather than at the missing variable.
  if (raw.NODE_ENV === "production" && !raw.BETTER_AUTH_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_URL"],
      message:
        "BETTER_AUTH_URL must be set in production to the public origin users reach, e.g. https://libris.example.com",
    });
    return z.NEVER;
  }
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
