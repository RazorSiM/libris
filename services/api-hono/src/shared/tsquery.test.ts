import { describe, expect, it } from "vite-plus/test";
import { buildPrefixTsquery } from "./tsquery.js";

describe("buildPrefixTsquery", () => {
  it("prefix-matches only the final word", () => {
    expect(buildPrefixTsquery("pride prejudice")).toBe("pride & prejudice:*");
  });

  it("keeps an apostrophe word as one lexeme for the stemmer", () => {
    // Dropping the apostrophe instead of splitting keeps this a single word:
    // `children's:*` finds "children", while `children & s:*` would not.
    expect(buildPrefixTsquery("children's")).toBe("childrens:*");
    expect(buildPrefixTsquery("o’brien")).toBe("obrien:*");
  });

  it("returns null when only syntax characters remain", () => {
    for (const input of ["", "   ", "'", "''", '"', "\\", "&", "&&", "()", ":*", "-", "**"]) {
      expect(buildPrefixTsquery(input), JSON.stringify(input)).toBeNull();
    }
  });

  it("turns operator runs into separators instead of a syntax error", () => {
    // The original bug: this built `foo & ':*` and Postgres raised
    // `syntax error in tsquery`, which surfaced as a 500 from every search
    // endpoint that shared the sanitizer.
    expect(buildPrefixTsquery("foo&'")).toBe("foo:*");
    expect(buildPrefixTsquery("'foo' bar'")).toBe("foo & bar:*");
    expect(buildPrefixTsquery('foo" & bar\\')).toBe("foo & bar:*");
    expect(buildPrefixTsquery("foo-bar")).toBe("foo & bar:*");
  });
});
