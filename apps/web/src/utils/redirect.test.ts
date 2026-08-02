import { describe, expect, it } from "vite-plus/test";
import { resolveRedirect } from "./redirect";

describe("resolveRedirect", () => {
  it("returns a same-site path", () => {
    expect(resolveRedirect("/library?author=Wight#top")).toBe("/library?author=Wight#top");
  });

  it("falls back when there is no redirect", () => {
    expect(resolveRedirect(undefined)).toBe("/");
    expect(resolveRedirect(null)).toBe("/");
  });

  it("takes the first value when the query key is repeated", () => {
    expect(resolveRedirect(["/inbox", "/library"])).toBe("/inbox");
  });

  for (const hostile of [
    "https://libris-phish.example",
    "http://libris-phish.example",
    "//libris-phish.example",
    "/\\libris-phish.example",
    "javascript:alert(1)",
    "libris-phish.example",
  ]) {
    it(`refuses to leave the site for ${hostile}`, () => {
      // An open redirect here is a phishing primitive: the victim signs in on
      // the real Libris, then gets handed to a copy that asks them to sign in
      // "again". //host and /\host both escape the origin without a scheme.
      expect(resolveRedirect(hostile)).toBe("/");
    });
  }
});
