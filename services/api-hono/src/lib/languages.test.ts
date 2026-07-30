import { describe, expect, test } from "vite-plus/test";
import { LANGUAGES, languageLabel, normalizeLanguage } from "./languages.js";

describe("normalizeLanguage", () => {
  test("passes through canonical ISO 639-1 codes", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("it")).toBe("it");
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(normalizeLanguage("EN")).toBe("en");
    expect(normalizeLanguage("  en  ")).toBe("en");
    expect(normalizeLanguage("ENGLISH")).toBe("en");
  });

  test("maps BCP-47 tags to their primary subtag", () => {
    expect(normalizeLanguage("en-GB")).toBe("en");
    expect(normalizeLanguage("en_US")).toBe("en");
    expect(normalizeLanguage("it-IT")).toBe("it");
    expect(normalizeLanguage("pt-BR")).toBe("pt");
    expect(normalizeLanguage("zh-Hans")).toBe("zh");
  });

  test("maps ISO 639-2/3 codes", () => {
    expect(normalizeLanguage("eng")).toBe("en");
    expect(normalizeLanguage("ita")).toBe("it");
    expect(normalizeLanguage("spa")).toBe("es");
    expect(normalizeLanguage("ger")).toBe("de");
    expect(normalizeLanguage("deu")).toBe("de");
    expect(normalizeLanguage("fre")).toBe("fr");
    expect(normalizeLanguage("fra")).toBe("fr");
  });

  test("maps English names and endonyms", () => {
    expect(normalizeLanguage("English")).toBe("en");
    expect(normalizeLanguage("Italian")).toBe("it");
    expect(normalizeLanguage("italiano")).toBe("it");
    expect(normalizeLanguage("Spanish")).toBe("es");
    expect(normalizeLanguage("espanol")).toBe("es");
    expect(normalizeLanguage("Deutsch")).toBe("de");
    expect(normalizeLanguage("mandarin")).toBe("zh");
  });

  test("covers all the messy production variants", () => {
    // English bucket
    for (const v of ["en", "English", "en-GB"]) expect(normalizeLanguage(v)).toBe("en");
    // Italian bucket
    for (const v of ["it", "it-IT", "Italian"]) expect(normalizeLanguage(v)).toBe("it");
  });

  test("returns null for empty or unrecognized input", () => {
    expect(normalizeLanguage(null)).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
    expect(normalizeLanguage("")).toBeNull();
    expect(normalizeLanguage("   ")).toBeNull();
    expect(normalizeLanguage("klingon")).toBeNull();
    expect(normalizeLanguage("xyz")).toBeNull();
  });

  test("every normalized code exists in LANGUAGES", () => {
    const codes = new Set(LANGUAGES.map((l) => l.code));
    for (const v of ["en-GB", "eng", "English", "ita", "spa", "deu", "zh-Hans"]) {
      const norm = normalizeLanguage(v);
      expect(norm).not.toBeNull();
      expect(codes.has(norm as string)).toBe(true);
    }
  });
});

describe("languageLabel", () => {
  test("returns the English name for a known code", () => {
    expect(languageLabel("en")).toBe("English");
    expect(languageLabel("it")).toBe("Italian");
  });

  test("normalizes the input before labeling", () => {
    expect(languageLabel("EN")).toBe("English");
    expect(languageLabel("en-GB")).toBe("English");
    expect(languageLabel("Italian")).toBe("Italian");
  });

  test("falls back to the uppercased raw value for unknowns", () => {
    expect(languageLabel("xyz")).toBe("XYZ");
  });

  test("returns an empty string for nullish input", () => {
    expect(languageLabel(null)).toBe("");
    expect(languageLabel(undefined)).toBe("");
    expect(languageLabel("")).toBe("");
  });
});
