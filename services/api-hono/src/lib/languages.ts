// Canonical language handling shared between the API and the web app.
//
// The source of truth for a book's language is a lowercase ISO 639-1 code
// (e.g. "en", "it"). Display names and most normalization are delegated to the
// platform's `Intl.DisplayNames` (available in Node and every modern browser),
// so this module only hard-codes the one thing the standard library can't give
// us: the list of ISO 639-1 codes (there is no `Intl.supportedValuesOf` for
// languages). No third-party dependencies — safe in the browser bundle.

export interface Language {
  /** Lowercase ISO 639-1 code, e.g. "en". */
  code: string;
  /** Display name in English, e.g. "English". */
  name: string;
}

// The complete ISO 639-1 two-letter code set. Names come from Intl at runtime.
// prettier-ignore
const ISO_639_1_CODES =
  ("aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch " +
    "co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga " +
    "gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja " +
    "jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv " +
    "mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or " +
    "os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr " +
    "ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi " +
    "vo wa wo xh yi yo za zh zu").split(" ");

// A few endonyms / alternate English names that `Intl` does not resolve. Keep
// this small — `Intl` already covers ISO 639-1/2/3 codes and English names.
const ALIASES: Record<string, string> = {
  italiano: "it",
  espanol: "es",
  castellano: "es",
  deutsch: "de",
  francais: "fr",
  portugues: "pt",
  "brazilian portuguese": "pt",
  nederlands: "nl",
  flemish: "nl",
  svenska: "sv",
  dansk: "da",
  norsk: "no",
  suomi: "fi",
  polski: "pl",
  magyar: "hu",
  mandarin: "zh",
  cantonese: "zh",
  farsi: "fa",
};

const displayNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/** English display name for a language code/tag, or undefined if unknown. */
function nameOf(code: string): string | undefined {
  try {
    return displayNames.of(code) ?? undefined;
  } catch {
    return undefined;
  }
}

const CODE_SET = new Set(ISO_639_1_CODES);

/** Lowercased English name -> ISO 639-1 code, built from Intl at module load. */
const NAME_TO_CODE = new Map<string, string>();
for (const code of ISO_639_1_CODES) {
  const name = nameOf(code);
  if (name) NAME_TO_CODE.set(name.toLowerCase(), code);
}

/** Selectable languages (code + English name), sorted by name. */
export const LANGUAGES: Language[] = ISO_639_1_CODES.map((code) => ({ code, name: nameOf(code) }))
  .filter((l): l is Language => Boolean(l.name))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Map an arbitrary language value to its canonical lowercase ISO 639-1 code.
 *
 * Handles ISO 639-1 codes ("en"), BCP-47 tags ("en-GB", "zh-Hans" -> "en",
 * "zh"), ISO 639-2/3 codes ("eng"/"deu" -> "en"/"de", via Intl), English names
 * ("English"), and a few endonyms ("italiano" -> "it"). Returns null for empty
 * or unrecognized input.
 */
export function normalizeLanguage(input: string | null | undefined): string | null {
  if (input == null) return null;
  const lower = String(input).trim().toLowerCase();
  if (!lower) return null;

  // BCP-47: the primary subtag, before any region/script.
  const primary = lower.split(/[-_]/)[0] ?? lower;

  // 1. Already a known ISO 639-1 code.
  if (CODE_SET.has(primary)) return primary;

  // 2. A full English name ("english", "norwegian bokmål").
  const byName = NAME_TO_CODE.get(lower);
  if (byName) return byName;

  // 3. An ISO 639-2/3 code Intl recognizes ("eng" -> "English" -> "en").
  const viaIntl = nameOf(primary);
  if (viaIntl) {
    const code = NAME_TO_CODE.get(viaIntl.toLowerCase());
    if (code) return code;
  }

  // 4. Endonym / alternate name.
  return ALIASES[primary] ?? ALIASES[lower] ?? null;
}

/**
 * Human-readable label for a language value. Returns the English name for a
 * known language, the raw value uppercased for anything unrecognized (so
 * legacy values still render), and "" for nullish input.
 */
export function languageLabel(code: string | null | undefined): string {
  if (code == null) return "";
  const raw = String(code).trim();
  if (!raw) return "";
  const norm = normalizeLanguage(raw);
  if (norm) {
    const name = nameOf(norm);
    if (name) return name;
  }
  return raw.toUpperCase();
}
