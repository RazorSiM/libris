import { describe, expect, it } from "vite-plus/test";
import { roleHasAdmin } from "./auth.js";

describe("roleHasAdmin", () => {
  it.each(["admin", "admin,user", "user,admin", " user , admin "])(
    "recognizes admin in %j",
    (role) => {
      expect(roleHasAdmin(role)).toBe(true);
    },
  );

  it.each([undefined, null, "", "user", "administrator", "not-admin", "user,superadmin"])(
    "rejects %j",
    (role) => {
      expect(roleHasAdmin(role)).toBe(false);
    },
  );

  it("recognizes admin in array form", () => {
    expect(roleHasAdmin(["user", "admin"])).toBe(true);
    expect(roleHasAdmin(["admin", "user"])).toBe(true);
    expect(roleHasAdmin(["user"])).toBe(false);
    expect(roleHasAdmin([])).toBe(false);
  });
});
