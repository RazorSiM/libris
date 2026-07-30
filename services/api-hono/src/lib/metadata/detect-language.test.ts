import { describe, expect, test } from "vite-plus/test";
import { detectLanguageFromText, predictLanguage } from "./detect-language.js";

const ENGLISH =
  "The quick brown fox jumps over the lazy dog. This is a clearly English sentence about programming, history and books.";
const ITALIAN =
  "Questo e un libro molto interessante che parla della storia e della cultura italiana nel corso dei secoli passati.";

describe("detectLanguageFromText", () => {
  test("detects English from a confident, long-enough sample", async () => {
    expect(await detectLanguageFromText(ENGLISH)).toBe("en");
  });

  test("detects Italian", async () => {
    expect(await detectLanguageFromText(ITALIAN)).toBe("it");
  });

  test("returns null for text below the minimum length", async () => {
    expect(await detectLanguageFromText("hi")).toBeNull();
    expect(await detectLanguageFromText("short text")).toBeNull();
  });

  test("returns null for empty or nullish input", async () => {
    expect(await detectLanguageFromText("")).toBeNull();
    expect(await detectLanguageFromText(null)).toBeNull();
    expect(await detectLanguageFromText(undefined)).toBeNull();
  });
});

describe("predictLanguage", () => {
  test("prefers the normalized embedded tag without detecting", async () => {
    expect(await predictLanguage({ language: "en-GB", title: ITALIAN, description: ITALIAN })).toBe(
      "en",
    );
  });

  test("falls back to detection when there is no usable tag", async () => {
    expect(await predictLanguage({ language: null, title: "A Tale", description: ENGLISH })).toBe(
      "en",
    );
  });

  test("prefers body text over the title/description text", async () => {
    // English title + description, but the body prose is Italian -> body wins.
    expect(
      await predictLanguage(
        { language: null, title: "An English Title", description: "An English description." },
        ITALIAN,
      ),
    ).toBe("it");
  });

  test("uses body text when the title/description are too short to detect", async () => {
    expect(await predictLanguage({ language: null, title: "Hi", description: null }, ENGLISH)).toBe(
      "en",
    );
  });

  test("falls back to detection when the tag is unrecognized", async () => {
    expect(
      await predictLanguage({ language: "gibberish", title: "Un racconto", description: ITALIAN }),
    ).toBe("it");
  });

  test("returns null when there is neither a tag nor enough text", async () => {
    expect(await predictLanguage({ language: null, title: "Hi", description: null })).toBeNull();
  });
});
