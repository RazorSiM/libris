import { describe, expect, it } from "vite-plus/test";
import { admin } from "better-auth/plugins";
import {
  ADMIN_ENDPOINT_EFFECTS,
  ADMIN_ENDPOINT_PREFIX,
  reducesAdminAuthority,
} from "./last-admin.js";

/**
 * The classification half of the last-admin guard (59m.12).
 *
 * The invariant itself — the row lock, the 409, the "another admin remains"
 * case — is exercised over real HTTP in routes/api/auth-handler.test.ts. What
 * lives here is the question that guard got wrong: given a request, is this an
 * operation that removes an active admin? The old code answered that with a
 * hardcoded list of three paths and a top-level `body.role` read, so
 * /admin/update-user with `{"data":{"role":"user"}}` answered "no".
 */

describe("reducesAdminAuthority", () => {
  describe("/admin/set-role", () => {
    it("treats a demotion as authority-reducing", () => {
      expect(reducesAdminAuthority("/admin/set-role", { userId: "u1", role: "user" })).toBe(true);
    });

    it("lets a promotion through", () => {
      expect(reducesAdminAuthority("/admin/set-role", { userId: "u1", role: "admin" })).toBe(false);
    });

    it("understands the array and comma-joined shapes Better Auth accepts", () => {
      expect(reducesAdminAuthority("/admin/set-role", { userId: "u1", role: ["admin"] })).toBe(
        false,
      );
      expect(reducesAdminAuthority("/admin/set-role", { userId: "u1", role: "admin,user" })).toBe(
        false,
      );
      expect(reducesAdminAuthority("/admin/set-role", { userId: "u1", role: ["user"] })).toBe(true);
    });
  });

  describe("/admin/update-user", () => {
    // These four are the regression. Against the pre-59m.12 middleware the path
    // was not registered at all, and even if it had been, `body.role` was
    // undefined so `removesAdminRole(undefined)` passed the request straight
    // through to Better Auth's writer.
    it("sees a demotion nested under data.role", () => {
      expect(
        reducesAdminAuthority("/admin/update-user", { userId: "u1", data: { role: "user" } }),
      ).toBe(true);
    });

    it("sees a ban nested under data.banned", () => {
      expect(
        reducesAdminAuthority("/admin/update-user", { userId: "u1", data: { banned: true } }),
      ).toBe(true);
    });

    it("lets a promotion nested under data.role through", () => {
      expect(
        reducesAdminAuthority("/admin/update-user", { userId: "u1", data: { role: "admin" } }),
      ).toBe(false);
    });

    it("lets an unrelated profile edit through", () => {
      expect(
        reducesAdminAuthority("/admin/update-user", { userId: "u1", data: { name: "Renamed" } }),
      ).toBe(false);
      expect(
        reducesAdminAuthority("/admin/update-user", { userId: "u1", data: { banned: false } }),
      ).toBe(false);
    });
  });

  describe("endpoints whose effect does not depend on the body", () => {
    it("guards ban-user and remove-user unconditionally", () => {
      // Neither carries a field that could say "actually, don't".
      expect(reducesAdminAuthority("/admin/ban-user", { userId: "u1" })).toBe(true);
      expect(reducesAdminAuthority("/admin/remove-user", { userId: "u1" })).toBe(true);
    });

    it("does not guard the endpoints that cannot shrink the admin set", () => {
      // Over-guarding is its own outage: the sole admin must still be able to
      // change their password, end their sessions, and be unbanned.
      expect(reducesAdminAuthority("/admin/set-user-password", { userId: "u1" })).toBe(false);
      expect(reducesAdminAuthority("/admin/revoke-user-sessions", { userId: "u1" })).toBe(false);
      expect(reducesAdminAuthority("/admin/unban-user", { userId: "u1" })).toBe(false);
      expect(reducesAdminAuthority("/admin/impersonate-user", { userId: "u1" })).toBe(false);
      expect(reducesAdminAuthority("/admin/list-users", {})).toBe(false);
    });

    it("does not mistake create-user's role field for a demotion", () => {
      // createUser puts `role` at the top level, but it has no userId to aim at
      // an existing account — it only ever adds one.
      expect(reducesAdminAuthority("/admin/create-user", { role: "user" })).toBe(false);
    });
  });

  it("fails safe for an endpoint it has never heard of", () => {
    // A Better Auth upgrade that adds a role- or ban-writing endpoint is
    // covered on the day it ships, not on the day someone notices.
    expect(
      reducesAdminAuthority("/admin/some-future-endpoint", { userId: "u1", role: "user" }),
    ).toBe(true);
    expect(
      reducesAdminAuthority("/admin/some-future-endpoint", {
        userId: "u1",
        data: { banned: true },
      }),
    ).toBe(true);
    expect(reducesAdminAuthority("/admin/some-future-endpoint", { userId: "u1" })).toBe(false);
  });
});

describe("the effects table covers the installed admin plugin", () => {
  const endpoints = Object.values(
    admin().endpoints as Record<string, { path: string; options?: { method?: unknown } }>,
  );

  it("enumerates a plausible number of endpoints", () => {
    // Cheap canary: if the shape of `admin().endpoints` ever changes, the
    // exhaustiveness check below would pass vacuously over an empty list.
    expect(endpoints.length).toBeGreaterThan(10);
  });

  it("classifies every endpoint the plugin exposes", () => {
    // THE durability assertion for 59m.12. Upgrading better-auth to a version
    // that adds an admin endpoint fails right here until someone decides
    // whether it can remove an admin. The previous design — three paths listed
    // in app.ts — had no equivalent, which is how /admin/update-user was missed
    // for an entire release.
    const unclassified = endpoints
      .map(({ path }) => path)
      .filter((path) => !(path in ADMIN_ENDPOINT_EFFECTS));

    expect(unclassified).toEqual([]);
  });

  it("does not classify endpoints that no longer exist", () => {
    // The other direction: a stale entry is a comment that lies.
    const live = new Set(endpoints.map(({ path }) => path));
    expect(Object.keys(ADMIN_ENDPOINT_EFFECTS).filter((path) => !live.has(path))).toEqual([]);
  });

  it("is reachable at the prefix app.ts mounts the middleware on", () => {
    for (const { path } of endpoints) {
      expect(`/api/auth${path}`.startsWith(ADMIN_ENDPOINT_PREFIX), path).toBe(true);
    }
  });
});
