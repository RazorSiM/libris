import { describe, expect, it } from "vite-plus/test";
import { parseEnv, parseRedisUrl } from "./env";

/**
 * BETTER_AUTH_SECRET is a *required* variable — a deliberate breaking change for
 * deployments, with no fallback to API_SECRET_KEY. It signs session cookies, so
 * a missing, published or low-entropy value has to stop the process at boot
 * rather than surface later as forgeable sessions.
 */

/** A 32-character secret with real character diversity. */
const GOOD_BETTER_AUTH_SECRET = "Jq7xW2pL9vRz4Kt1Nb8Hc3Ye6Ma0Sd5F";

const VALID_ENV = {
  NODE_ENV: "production",
  POSTGRES_HOST: "localhost",
  POSTGRES_USER: "libris",
  POSTGRES_PASSWORD: "pw",
  POSTGRES_DB: "libris",
  REDIS_HOST: "127.0.0.1",
  LIBRIS_INBOX_PATH: "/tmp/inbox",
  LIBRIS_LIBRARY_PATH: "/tmp/library",
  API_SECRET_KEY: "0123456789abcdef".repeat(2),
  BETTER_AUTH_SECRET: GOOD_BETTER_AUTH_SECRET,
  // Required in production — see the BETTER_AUTH_URL block below.
  BETTER_AUTH_URL: "https://libris.example.com",
};

describe("parseEnv", () => {
  it("requires NODE_ENV so a missing value cannot disable production safeguards", () => {
    const { NODE_ENV: _omitted, ...withoutNodeEnv } = VALID_ENV;

    expect(() => parseEnv(withoutNodeEnv)).toThrow(/NODE_ENV/);
  });

  it("accepts a complete environment", () => {
    const env = parseEnv(VALID_ENV);

    expect(env.BETTER_AUTH_SECRET).toBe(GOOD_BETTER_AUTH_SECRET);
    expect(env.DATABASE_URL).toContain("localhost");
    expect(env.LIBRIS_COOKIE_SECURE).toBe("1");
    expect(env.LIBRIS_HTTP_HEADERS_TIMEOUT_MS).toBe(10_000);
    expect(env.LIBRIS_HTTP_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(env.LIBRIS_HTTP_IDLE_TIMEOUT_MS).toBe(30_000);
  });

  it("allows secure cookies to be disabled independently of NODE_ENV", () => {
    expect(parseEnv({ ...VALID_ENV, LIBRIS_COOKIE_SECURE: "0" }).LIBRIS_COOKIE_SECURE).toBe("0");
  });

  describe("LIBRIS_COVER_FETCH_ALLOWLIST", () => {
    it("defaults to no private-network exceptions", () => {
      expect(parseEnv(VALID_ENV).LIBRIS_COVER_FETCH_ALLOWLIST).toEqual([]);
    });

    it("parses exact HTTP(S) origins", () => {
      const env = parseEnv({
        ...VALID_ENV,
        LIBRIS_COVER_FETCH_ALLOWLIST: "http://covers.lan:8080, https://covers.example.com",
      });

      expect(env.LIBRIS_COVER_FETCH_ALLOWLIST).toEqual([
        "http://covers.lan:8080",
        "https://covers.example.com",
      ]);
    });

    it("rejects paths and non-HTTP schemes", () => {
      expect(() =>
        parseEnv({ ...VALID_ENV, LIBRIS_COVER_FETCH_ALLOWLIST: "http://covers.lan/path" }),
      ).toThrow(/allowlist/i);
      expect(() =>
        parseEnv({ ...VALID_ENV, LIBRIS_COVER_FETCH_ALLOWLIST: "file:///covers" }),
      ).toThrow(/allowlist/i);
    });
  });

  describe("trusted proxies", () => {
    it("requires an explicit proxy IP or CIDR when forwarded headers are enabled", () => {
      expect(() => parseEnv({ ...VALID_ENV, TRUST_PROXY_HEADERS: "1" })).toThrow(
        /LIBRIS_TRUSTED_PROXIES/,
      );
    });

    it("accepts validated IPv4 and IPv6 proxy networks", () => {
      const env = parseEnv({
        ...VALID_ENV,
        TRUST_PROXY_HEADERS: "1",
        LIBRIS_TRUSTED_PROXIES: "10.0.0.0/24, 2001:db8::/48",
      });
      expect(env.LIBRIS_TRUSTED_PROXIES).toEqual(["10.0.0.0/24", "2001:db8::/48"]);
    });

    it("rejects malformed proxy networks", () => {
      expect(() => parseEnv({ ...VALID_ENV, LIBRIS_TRUSTED_PROXIES: "10.0.0.0/99" })).toThrow(
        /Invalid trusted-proxy/,
      );
    });
  });

  describe("BETTER_AUTH_SECRET", () => {
    it("is required", () => {
      const { BETTER_AUTH_SECRET: _omitted, ...withoutSecret } = VALID_ENV;

      expect(() => parseEnv(withoutSecret)).toThrow(/BETTER_AUTH_SECRET/);
    });

    it("rejects a secret shorter than 32 characters", () => {
      expect(() => parseEnv({ ...VALID_ENV, BETTER_AUTH_SECRET: "b".repeat(31) })).toThrow(
        /BETTER_AUTH_SECRET/,
      );
    });

    it("accepts exactly 32 characters", () => {
      expect(GOOD_BETTER_AUTH_SECRET).toHaveLength(32);

      expect(parseEnv({ ...VALID_ENV }).BETTER_AUTH_SECRET).toBe(GOOD_BETTER_AUTH_SECRET);
    });

    it("rejects the placeholder that used to ship in .env.example", () => {
      // The published placeholder was 46 characters, so `min(32)` passed it
      // and every install that copied .env.example without editing this line
      // signed its sessions with a secret published in a public repository.
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          BETTER_AUTH_SECRET: "change-me-generate-with-openssl-rand-base64-32",
        }),
      ).toThrow(/placeholder/i);
    });

    it("rejects a long single-character string", () => {
      // The suite used to bless "b".repeat(32) as a valid secret.
      expect(() => parseEnv({ ...VALID_ENV, BETTER_AUTH_SECRET: "b".repeat(32) })).toThrow(
        /diversity/i,
      );
    });

    it("rejects API_SECRET_KEY's placeholder here too", () => {
      // One shared blocklist: a leaked placeholder is public whichever variable
      // it was written next to.
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          BETTER_AUTH_SECRET: "change-me-generate-with-openssl-rand-hex-32",
        }),
      ).toThrow(/placeholder/i);
    });

    it("does not fall back to API_SECRET_KEY", () => {
      // Reusing the old secret would keep signing sessions with a key that has
      // been sitting in these deployments for a long time, and would couple two
      // unrelated rotations together.
      const { BETTER_AUTH_SECRET: _omitted, ...withoutSecret } = VALID_ENV;

      expect(() => parseEnv(withoutSecret)).toThrow();
    });
  });

  describe("BETTER_AUTH_URL", () => {
    it("is required in production", () => {
      // Better Auth does NOT read x-forwarded-proto unless
      // advanced.trustedProxyHeaders is set, so with no baseURL it derives the
      // container's plain-http socket origin, makes that the only trusted
      // origin, and answers every browser request carrying `Origin: https://…`
      // with 403 INVALID_ORIGIN. Nobody can sign in. Refuse to boot instead.
      const { BETTER_AUTH_URL: _omitted, ...withoutUrl } = VALID_ENV;

      expect(() => parseEnv(withoutUrl)).toThrow(/BETTER_AUTH_URL/);
      expect(() => parseEnv({ ...VALID_ENV, BETTER_AUTH_URL: "" })).toThrow(/BETTER_AUTH_URL/);
    });

    it("names the value to set in the failure message", () => {
      const { BETTER_AUTH_URL: _omitted, ...withoutUrl } = VALID_ENV;

      expect(() => parseEnv(withoutUrl)).toThrow(/https:\/\/libris\.example\.com/);
    });

    it("stays optional outside production, where the request origin is correct", () => {
      const env = parseEnv({ ...VALID_ENV, NODE_ENV: "development", BETTER_AUTH_URL: "" });

      expect(env.BETTER_AUTH_URL).toBe("");
    });

    it("is used when provided", () => {
      const env = parseEnv({ ...VALID_ENV, BETTER_AUTH_URL: "https://libris.example.com" });

      expect(env.BETTER_AUTH_URL).toBe("https://libris.example.com");
    });

    it("rejects a value that is not a bare http(s) origin", () => {
      // Better Auth appends its own /api/auth basePath, so a value carrying a
      // path silently produces the wrong cookie and redirect origin rather
      // than an error.
      for (const value of [
        "libris.example.com",
        "https://libris.example.com/api/auth",
        "ftp://libris.example.com",
        "https://user:pw@libris.example.com",
        "https://libris.example.com/?x=1",
      ]) {
        expect(() => parseEnv({ ...VALID_ENV, BETTER_AUTH_URL: value }), value).toThrow(
          /BETTER_AUTH_URL/,
        );
      }
    });

    it("accepts a trailing slash and an explicit port", () => {
      expect(
        parseEnv({ ...VALID_ENV, BETTER_AUTH_URL: "https://libris.example.com/" }),
      ).toBeTruthy();
      expect(parseEnv({ ...VALID_ENV, BETTER_AUTH_URL: "http://192.168.1.10:3000" })).toBeTruthy();
    });
  });

  it("still requires API_SECRET_KEY, which encrypts stored third-party tokens", () => {
    const { API_SECRET_KEY: _omitted, ...withoutApiSecret } = VALID_ENV;

    expect(() => parseEnv(withoutApiSecret)).toThrow(/API_SECRET_KEY/);
  });

  it("rejects published and low-diversity API secret values", () => {
    expect(() =>
      parseEnv({
        ...VALID_ENV,
        API_SECRET_KEY: "change-me-generate-with-openssl-rand-hex-32",
      }),
    ).toThrow(/placeholder/i);
    expect(() => parseEnv({ ...VALID_ENV, API_SECRET_KEY: "a".repeat(32) })).toThrow(/diversity/i);
  });
});

describe("parseRedisUrl", () => {
  it("parses a plain redis:// URL", () => {
    const result = parseRedisUrl("redis://localhost:6379");
    expect(result).toEqual({
      host: "localhost",
      port: 6379,
      password: undefined,
    });
    expect(result).not.toHaveProperty("tls");
  });

  it("parses host, port, and password", () => {
    const result = parseRedisUrl("redis://:s3cret@myhost:6380");
    expect(result).toEqual({
      host: "myhost",
      port: 6380,
      password: "s3cret",
    });
  });

  it("defaults port to 6379 when omitted", () => {
    const result = parseRedisUrl("redis://localhost");
    expect(result.port).toBe(6379);
  });

  it("includes tls: true for rediss:// URLs", () => {
    const result = parseRedisUrl("rediss://prod-host:6380");
    expect(result).toEqual({
      host: "prod-host",
      port: 6380,
      password: undefined,
      tls: {},
    });
  });

  it("includes tls and password for rediss:// with auth", () => {
    const result = parseRedisUrl("rediss://:token@secure.redis.io:6379");
    expect(result).toEqual({
      host: "secure.redis.io",
      port: 6379,
      password: "token",
      tls: {},
    });
  });
});
