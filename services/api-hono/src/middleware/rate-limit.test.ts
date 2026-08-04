import { describe, expect, it } from "vite-plus/test";
import { resolveRateLimitTiers } from "./rate-limit.js";

describe("resolveRateLimitTiers", () => {
  it("stands aside for the whole /api/auth/ prefix", () => {
    // Better Auth limits its own endpoints, and far more tightly than any tier
    // here. Two limiters on one route means two budgets and a 429 that neither
    // one accounts for.
    for (const [path, method] of [
      ["/api/auth/sign-in/email", "POST"],
      ["/api/auth/change-password", "POST"],
      ["/api/auth/get-session", "GET"],
      ["/api/auth/admin/list-users", "GET"],
      ["/api/auth/some/plugin/added/later", "POST"],
    ] as const) {
      expect(resolveRateLimitTiers(path, method), path).toEqual([]);
    }
  });

  it("does not let the /api/auth/ exemption leak onto a sibling path", () => {
    expect(resolveRateLimitTiers("/api/authors", "GET")).toEqual(["general"]);
  });

  it("places OPDS routes in the general tier (browsing, not credential probing)", () => {
    expect(resolveRateLimitTiers("/opds", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/opds/books", "GET")).toEqual(["general"]);
  });

  it("throttles the KoSync credential check, which Better Auth does not cover", () => {
    // KOReader speaks its own protocol on its own prefix, so this is the only
    // credential check left outside Better Auth's reach.
    expect(resolveRateLimitTiers("/kosync/users/auth", "GET")).toEqual(["auth"]);
    expect(resolveRateLimitTiers("/kosync/users/auth", "POST")).toEqual(["auth"]);
    expect(resolveRateLimitTiers("/kosync/syncs/progress", "PUT")).toEqual(["general"]);
  });

  it("puts credential creation in both the strict and the auth tier", () => {
    // /api/setup is public by necessity and hashes a password before it can
    // 409; /api/app-passwords needs a session but still costs a hash a call.
    expect(resolveRateLimitTiers("/api/setup", "POST")).toEqual(["keyCreation", "auth"]);
    expect(resolveRateLimitTiers("/api/app-passwords", "POST")).toEqual(["keyCreation", "auth"]);
  });

  it("leaves reading and revoking credentials in the general tier", () => {
    // Listing or deleting your own app passwords probes nothing.
    expect(resolveRateLimitTiers("/api/app-passwords", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/api/app-passwords/abc123", "DELETE")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/api/setup", "GET")).toEqual(["general"]);
  });

  it("puts ordinary library traffic in the general tier", () => {
    expect(resolveRateLimitTiers("/api/health", "GET")).toEqual([]);
    expect(resolveRateLimitTiers("/api/books", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/api/library", "GET")).toEqual(["general"]);
  });

  it("rate-limits static and unknown paths by default", () => {
    expect(resolveRateLimitTiers("/", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/assets/app.js", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/future-server-namespace", "POST")).toEqual(["general"]);
  });
});
