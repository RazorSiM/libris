import { describe, expect, it } from "vite-plus/test";
import { roleHasAdmin } from "./roles";

describe("roleHasAdmin", () => {
  it.each(["admin", "admin,user", "user,admin", " user , admin "])(
    "recognizes admin in %j",
    (role) => {
      expect(roleHasAdmin(role)).toBe(true);
    },
  );

  it.each([undefined, null, "", "user", "administrator", "not-admin"])("rejects %j", (role) => {
    expect(roleHasAdmin(role)).toBe(false);
  });

  it("recognizes admin in array form", () => {
    expect(roleHasAdmin(["user", "admin"])).toBe(true);
    expect(roleHasAdmin(["user"])).toBe(false);
  });
});
