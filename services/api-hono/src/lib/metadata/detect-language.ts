import type { NormalizedMetadata } from "../../types/index.js";
import { normalizeLanguage } from "../languages.js";
import { getLogger } from "../logger.js";

const logger = getLogger("metadata:detect-language");

// Below this many characters, free text is too short to detect reliably, so we
// skip detection entirely. Real book descriptions comfortably exceed this; a
// bare title usually does not (and we'd rather return null than guess from it).
//
// Note: tinyld's per-result "accuracy" score is not a usable confidence gate
// (it happily reports 1.0 for gibberish), so we instead rely on the length gate
// plus requiring the detected code to be a recognized language. This is a
// best-effort fallback that only runs when a book has no usable language tag.
const MIN_TEXT_LENGTH = 40;

type Detect = (text: string) => string;

// tinyld ships several MB of trained models; load it lazily so the cost is only
// paid the first time a book actually needs content-based detection (most books
// carry a usable language tag and never reach here).
let detectFn: Detect | null = null;
async function loadDetect(): Promise<Detect> {
  if (!detectFn) {
    const mod = (await import("tinyld")) as { detect?: Detect; default?: { detect?: Detect } };
    const fn = mod.detect ?? mod.default?.detect;
    if (typeof fn !== "function") throw new Error("tinyld detect() unavailable");
    detectFn = fn;
  }
  return detectFn;
}

/**
 * Best-effort detection of the ISO 639-1 language code from free text (title +
 * description). Returns null when the text is too short or the detected
 * language is empty/unrecognized.
 */
export async function detectLanguageFromText(
  text: string | null | undefined,
): Promise<string | null> {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  if (trimmed.length < MIN_TEXT_LENGTH) return null;

  try {
    const detect = await loadDetect();
    const detected = detect(trimmed);
    // Map tinyld's guess into our canonical set; unrecognized codes -> null.
    return detected ? normalizeLanguage(detected) : null;
  } catch (err) {
    logger.withMetadata({ error: String(err) }).warn("Language detection failed");
    return null;
  }
}

/**
 * Predict a book's canonical language. Order of preference:
 *   1. the (normalized) embedded metadata tag,
 *   2. the language detected from a sample of the book's body prose (the
 *      strongest signal — pass it in via `bodyText`),
 *   3. the language detected from the title + description.
 */
export async function predictLanguage(
  meta: Pick<NormalizedMetadata, "language" | "title" | "description">,
  bodyText?: string | null,
): Promise<string | null> {
  const tagged = normalizeLanguage(meta.language ?? null);
  if (tagged) return tagged;

  const fromBody = await detectLanguageFromText(bodyText);
  if (fromBody) return fromBody;

  const metaText = [meta.title, meta.description].filter(Boolean).join(". ");
  return detectLanguageFromText(metaText);
}
