import { describe, expect, it } from "vite-plus/test";
import { parseRedisUrl } from "./env";

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
