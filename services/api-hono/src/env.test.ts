import { describe, expect, it } from "vite-plus/test";
import { parseEnv, parseRedisUrl } from "./env";

/**
 * BETTER_AUTH_SECRET is a new *required* variable — a deliberate breaking change
 * for deployments, with no fallback to API_SECRET_KEY. It signs session cookies,
 * so a missing or weak value has to stop the process at boot rather than surface
 * later as forgeable sessions.
 */
const VALID_ENV = {
  NODE_ENV: "production",
  POSTGRES_HOST: "localhost",
  POSTGRES_USER: "libris",
  POSTGRES_PASSWORD: "pw",
  POSTGRES_DB: "libris",
  REDIS_HOST: "127.0.0.1",
  LIBRIS_INBOX_PATH: "/tmp/inbox",
  LIBRIS_LIBRARY_PATH: "/tmp/library",
  API_SECRET_KEY: "a".repeat(32),
  BETTER_AUTH_SECRET: "b".repeat(32),
};

describe("parseEnv", () => {
  it("requires NODE_ENV so a missing value cannot disable production safeguards", () => {
    const { NODE_ENV: _omitted, ...withoutNodeEnv } = VALID_ENV;

    expect(() => parseEnv(withoutNodeEnv)).toThrow(/NODE_ENV/);
  });

  it("accepts a complete environment", () => {
    const env = parseEnv(VALID_ENV);

    expect(env.BETTER_AUTH_SECRET).toBe("b".repeat(32));
    expect(env.DATABASE_URL).toContain("localhost");
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
      const env = parseEnv({ ...VALID_ENV, BETTER_AUTH_SECRET: "b".repeat(32) });

      expect(env.BETTER_AUTH_SECRET).toBe("b".repeat(32));
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
    it("defaults to empty so Better Auth infers the origin from the request", () => {
      // Production sits behind Traefik on https while the container listens on
      // http, so any hardcoded default would be wrong more often than right.
      expect(parseEnv(VALID_ENV).BETTER_AUTH_URL).toBe("");
    });

    it("is used when provided", () => {
      const env = parseEnv({ ...VALID_ENV, BETTER_AUTH_URL: "https://libris.example.com" });

      expect(env.BETTER_AUTH_URL).toBe("https://libris.example.com");
    });
  });

  it("still requires API_SECRET_KEY, which encrypts stored third-party tokens", () => {
    const { API_SECRET_KEY: _omitted, ...withoutApiSecret } = VALID_ENV;

    expect(() => parseEnv(withoutApiSecret)).toThrow(/API_SECRET_KEY/);
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
