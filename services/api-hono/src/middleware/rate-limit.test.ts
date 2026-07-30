import { describe, expect, it } from "vite-plus/test";
import { resolveRateLimitTiers } from "./rate-limit.js";

describe("resolveRateLimitTiers", () => {
  it("places OPDS routes in the general tier (browsing, not credential probing)", () => {
    expect(resolveRateLimitTiers("/opds", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/opds/books", "GET")).toEqual(["general"]);
  });

  it("applies auth throttling to KoSync auth routes only", () => {
    expect(resolveRateLimitTiers("/kosync/users/auth", "GET")).toEqual(["auth"]);
    expect(resolveRateLimitTiers("/kosync/users/auth", "POST")).toEqual(["auth"]);
    expect(resolveRateLimitTiers("/kosync/syncs/progress", "PUT")).toEqual(["general"]);
  });

  it("applies auth tier only to credential-input endpoints", () => {
    expect(resolveRateLimitTiers("/api/auth/login", "POST")).toEqual(["auth"]);
    expect(resolveRateLimitTiers("/api/books", "GET")).toEqual(["general"]);
  });

  it("places read-only and session-management auth endpoints in general", () => {
    expect(resolveRateLimitTiers("/api/auth/keys", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/api/auth/keys/abc123", "DELETE")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/api/auth/session", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/api/auth/logout", "POST")).toEqual(["general"]);
  });

  it("keeps key creation endpoints in both strict and auth tiers", () => {
    expect(resolveRateLimitTiers("/api/auth/setup", "POST")).toEqual(["keyCreation", "auth"]);
    expect(resolveRateLimitTiers("/api/auth/keys", "POST")).toEqual(["keyCreation", "auth"]);
  });
});
