import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { NormalizedMetadata } from "../../../types/index.js";
import {
  EOCD_MAX_COMMENT,
  EOCD_MIN_SIZE,
  LOCAL_HEADER_SIG,
  findEocd,
  readCentralDirectory,
  readRange,
  readZipEntry,
  ZipLimitError,
} from "../../epub/zip.js";
import type { ZipEntry } from "../../epub/zip.js";
import { normalizeLanguage } from "../../languages.js";
import { stripHtml } from "../sanitize.js";

import { getLogger } from "../../logger.js";

const logger = getLogger("epub-extractor");

// Full EPUB metadata extractor — reads the ZIP central directory, finds
// META-INF/container.xml to locate the OPF, then parses Dublin Core metadata.
// Supports both STORE (uncompressed) and DEFLATE entries.

// --- Linear XML scanning primitives ---
//
// Every scan in this file is built from `indexOf` plus fixed-offset ASCII
// comparisons. Regexes such as /<dc:title(?:\s[^>]*)?>/gi or /<item[^>]+>/gi
// look bounded but backtrack quadratically: on `"<dc:title ".repeat(n)` the
// cost is exactly 4x per doubling of n, so a 2 MB OPF (which deflates to a few
// hundred bytes inside a ~1 KB EPUB) pins the event loop for minutes. This is
// the second attempt at the problem — the previous "fix" swapped one
// backtracking pattern for another and measured no faster.
//
// Scanning at fixed offsets also removes a correctness bug: the old code
// searched `xml.toLowerCase()` for the closing tag but sliced the *original*
// string with the resulting offset. Lowercasing can change UTF-16 length
// (U+0130 lowercases to two code units), which desynchronised the two indices
// and appended a stray "<" to every dc: field after such a character.

const CHAR_GT = 0x3e; // ">"
const CHAR_SLASH = 0x2f; // "/"
const CHAR_EQUALS = 0x3d; // "="
const CHAR_DQUOTE = 0x22; // '"'
const CHAR_SQUOTE = 0x27; // "'"

function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function asciiLower(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/**
 * True when `haystack` contains `needleLower` at `at`, folding ASCII letters.
 * `needleLower` must already be lowercase. XML element and attribute names are
 * ASCII, so ASCII-only folding is both sufficient and safer than `toLowerCase`.
 */
function matchesAt(haystack: string, at: number, needleLower: string): boolean {
  if (at < 0 || at + needleLower.length > haystack.length) return false;
  for (let i = 0; i < needleLower.length; i++) {
    if (asciiLower(haystack.charCodeAt(at + i)) !== needleLower.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Case-insensitive `indexOf` for a needle beginning with "<". Native
 * `indexOf("<")` skips between candidates, so the total cost is
 * O(haystack length x needle length) with no backtracking.
 */
function indexOfTag(haystack: string, needleLower: string, from: number): number {
  const limit = haystack.length - needleLower.length;
  let i = Math.max(0, from);
  while (i <= limit) {
    const at = haystack.indexOf("<", i);
    if (at === -1 || at > limit) return -1;
    if (matchesAt(haystack, at, needleLower)) return at;
    i = at + 1;
  }
  return -1;
}

/** Case-insensitive `indexOf` for an arbitrary ASCII-lowercase needle. */
function indexOfCaseInsensitive(haystack: string, needleLower: string, from: number): number {
  const limit = haystack.length - needleLower.length;
  for (let i = Math.max(0, from); i <= limit; i++) {
    if (matchesAt(haystack, i, needleLower)) return i;
  }
  return -1;
}

interface XmlTag {
  /** Full source text of the tag, angle brackets included. */
  text: string;
  /** Index of "<". */
  start: number;
  /** Index just past ">". */
  end: number;
}

/**
 * Iterate every `<name ...>` tag in `xml`, case-insensitively. `name` must be
 * lowercase. `<items>` does not match a scan for `item`. Linear in `xml.length`
 * because the cursor only ever moves forward.
 */
function* scanTags(xml: string, name: string): Generator<XmlTag> {
  const open = `<${name}`;
  let pos = 0;
  while (pos < xml.length) {
    const start = indexOfTag(xml, open, pos);
    if (start === -1) return;
    const after = start + open.length;
    const next = after < xml.length ? xml.charCodeAt(after) : -1;
    if (next !== CHAR_GT && next !== CHAR_SLASH && !isXmlSpace(next)) {
      pos = start + 1;
      continue;
    }
    const gt = xml.indexOf(">", after);
    if (gt === -1) return;
    yield { text: xml.slice(start, gt + 1), start, end: gt + 1 };
    pos = gt + 1;
  }
}

/**
 * Read an attribute value out of a single tag's source text. `name` must be
 * lowercase; the attribute name must start at a whitespace boundary, so a scan
 * for `href` does not pick up `xlink:href`. Returns undefined for absent or
 * empty values, matching the `("[^"]+")` regexes this replaces.
 */
function getAttribute(tag: string, name: string): string | undefined {
  for (let i = 1; i + name.length < tag.length; i++) {
    if (!isXmlSpace(tag.charCodeAt(i - 1))) continue;
    if (!matchesAt(tag, i, name)) continue;
    let j = i + name.length;
    while (j < tag.length && isXmlSpace(tag.charCodeAt(j))) j++;
    if (tag.charCodeAt(j) !== CHAR_EQUALS) continue;
    j++;
    while (j < tag.length && isXmlSpace(tag.charCodeAt(j))) j++;
    const quote = tag.charCodeAt(j);
    if (quote !== CHAR_DQUOTE && quote !== CHAR_SQUOTE) continue;
    const close = tag.indexOf(quote === CHAR_DQUOTE ? '"' : "'", j + 1);
    if (close === -1) return undefined;
    const value = tag.slice(j + 1, close);
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Text between the first `<name ...>` and its `</name>`. Returns undefined when
 * either is missing. A failed close-tag search ends the scan rather than
 * retrying later open tags: any later tag starts after the failed search
 * window, so it could not find a close tag either.
 */
function elementContent(xml: string, name: string): string | undefined {
  for (const tag of scanTags(xml, name)) {
    if (tag.text.endsWith("/>")) continue;
    const close = indexOfTag(xml, `</${name}>`, tag.end);
    if (close === -1) return undefined;
    return xml.slice(tag.end, close);
  }
  return undefined;
}

/** Drop `<name>...</name>` elements (content included), replacing each with a space. */
function removeElements(html: string, names: readonly string[]): string {
  let result = html;
  for (const name of names) {
    const closeTag = `</${name}>`;
    let out = "";
    let pos = 0;
    for (const tag of scanTags(result, name)) {
      if (tag.start < pos) continue; // already inside a removed region
      const close = indexOfTag(result, closeTag, tag.end);
      if (close === -1) break;
      out += `${result.slice(pos, tag.start)} `;
      pos = close + closeTag.length;
    }
    if (pos > 0) result = out + result.slice(pos);
  }
  return result;
}

// --- container.xml parsing ---

function parseContainerXml(xml: string): string | null {
  for (const tag of scanTags(xml, "rootfile")) {
    const fullPath = getAttribute(tag.text, "full-path");
    if (fullPath) return fullPath;
  }
  return null;
}

// --- OPF parsing ---

// Field length limits to prevent DoS via extremely long metadata strings
const MAX_FIELD_LENGTH = 1000;
const MAX_DESCRIPTION_LENGTH = 5000;
// A real OPF is a few tens of KB even for a large manifest. The old 2 MB budget
// existed only because the parser could not be trusted with less.
const MAX_OPF_BYTES = 256 * 1024;
// Per-element and per-tag caps. These bound the work handed to stripHtml(),
// whose /<[^>]+>/g pass is itself quadratic on a run of "<" characters.
const MAX_XML_ELEMENT_BYTES = 8 * 1024;
const MAX_DC_ELEMENTS = 128;
const MAX_COVER_BYTES = 10 * 1024 * 1024;
// Only TEXT_SAMPLE_TARGET characters of prose are ever needed per spine doc,
// so there is no reason to hand a multi-megabyte body to the text stripper.
const MAX_TEXT_SCAN_BYTES = 8 * 1024;

// Body-text sampling for language detection (see extractEpubTextSample).
const TEXT_SAMPLE_TARGET = 1500; // stop once this many chars of prose are collected
const MIN_DOC_TEXT = 200; // skip spine docs shorter than this (likely front matter)
const MAX_SPINE_DOCS = 15; // cap how many spine docs we crack open

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return value;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Strip markup out of a metadata field, then truncate. Empty results collapse
 * to undefined so callers can `??` past them.
 *
 * `stripHtml` runs `/<[^>]+>/g`, which backtracks quadratically over a run of
 * "<" characters, so the input must already be bounded — every call site here
 * feeds it a value capped at MAX_XML_ELEMENT_BYTES by collectDcElements or a
 * single regex capture group.
 */
function stripField(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return truncate(stripHtml(value).trim() || undefined, max);
}

/**
 * Text content of every `<dc:{tag}>` element, in document order.
 *
 * Linear: the cursor only moves forward, every lookup is an `indexOf`, and a
 * missing close tag ends the scan instead of restarting it. Compare the
 * previous regex implementation, which took ~3 minutes on a 2 MB OPF of
 * repeated `"<dc:title "` tokens.
 */
function collectDcElements(xml: string, tag: string): string[] {
  const results: string[] = [];
  const openTag = `<dc:${tag}`;
  const closeTag = `</dc:${tag}>`;
  let pos = 0;

  while (pos < xml.length && results.length < MAX_DC_ELEMENTS) {
    const start = indexOfTag(xml, openTag, pos);
    if (start === -1) break;

    const after = start + openTag.length;
    const next = after < xml.length ? xml.charCodeAt(after) : -1;
    // The name must end here: reject <dc:titlefoo> when looking for <dc:title>.
    if (next !== CHAR_GT && !isXmlSpace(next)) {
      pos = start + 1;
      continue;
    }

    const gt = xml.indexOf(">", after);
    if (gt === -1) break; // unterminated tag — nothing further can match
    if (xml.charCodeAt(gt - 1) === CHAR_SLASH) {
      pos = gt + 1; // <dc:title/> — empty element, no content
      continue;
    }

    const contentStart = gt + 1;
    const contentEnd = indexOfTag(xml, closeTag, contentStart);
    if (contentEnd === -1) break;

    const text = xml
      .slice(contentStart, Math.min(contentEnd, contentStart + MAX_XML_ELEMENT_BYTES))
      .trim();
    if (text) results.push(text);
    pos = contentEnd + closeTag.length;
  }

  return results;
}

export function parseOpf(xml: string): NormalizedMetadata {
  const getAll = (tag: string): string[] => collectDcElements(xml, tag);

  const get = (tag: string): string | undefined => getAll(tag)[0] || undefined;

  // Strip HTML from text fields that could contain injected tags
  const title = stripField(get("title"), MAX_FIELD_LENGTH);

  // Multiple creators — join with ", "
  const creators = getAll("creator")
    .map((c) => stripField(c, MAX_FIELD_LENGTH))
    .filter((c): c is string => Boolean(c));
  const author = truncate(creators.length > 0 ? creators.join(", ") : undefined, MAX_FIELD_LENGTH);

  const publisher = stripField(get("publisher"), MAX_FIELD_LENGTH);
  // Normalize the embedded language tag to a canonical ISO 639-1 code when we
  // recognize it (e.g. "en-GB" -> "en", "Italian" -> "it"); otherwise keep the
  // raw value so the file candidate still records what the file actually said.
  const rawLanguage = truncate(get("language"), MAX_FIELD_LENGTH);
  const language = normalizeLanguage(rawLanguage) ?? rawLanguage;

  // Description may contain HTML
  const description = stripField(get("description"), MAX_DESCRIPTION_LENGTH);

  // dc:subject → genres
  const genres = getAll("subject");

  // Scan all dc:identifier elements for ISBNs. This already covers identifiers
  // carrying opf:scheme="ISBN" — the separate (and quadratic) regex that used
  // to re-scan for them was pure duplication.
  const identifiers = getAll("identifier");

  let isbn10: string | undefined;
  let isbn13: string | undefined;

  for (const id of identifiers) {
    const cleaned = id.replace(/[- ]/g, "").replace(/^(urn:isbn:|isbn[:\s]*)/i, "");
    if (/^\d{9}[\dXx]$/.test(cleaned)) {
      isbn10 = cleaned.toUpperCase();
    } else if (/^\d{13}$/.test(cleaned)) {
      isbn13 = cleaned;
    }
  }

  // Published date
  const dateStr = get("date");
  const publishedYear = dateStr ? parseYear(dateStr) : undefined;

  // Note: EPUB-internal cover href (e.g. "images/cover.jpg") is NOT stored in
  // coverUrl. coverUrl is reserved for external HTTP URLs from metadata sources.
  // The organize worker extracts the cover directly via extractEpubCoverImage().

  // calibre:series meta tags
  const seriesMatch = xml.match(
    /<meta\s+name=["']calibre:series["']\s+content=["']([^"']+)["']\s*\/?>/i,
  );
  const seriesIndexMatch = xml.match(
    /<meta\s+name=["']calibre:series_index["']\s+content=["']([^"']+)["']\s*\/?>/i,
  );
  const series = stripField(seriesMatch?.[1], MAX_FIELD_LENGTH);
  const seriesIndexRaw = seriesIndexMatch?.[1]?.trim();
  const seriesIndex =
    seriesIndexRaw && !Number.isNaN(Number.parseFloat(seriesIndexRaw))
      ? Number.parseFloat(seriesIndexRaw)
      : undefined;

  // Truncate genre strings
  const truncatedGenres = genres
    .map((g) => truncate(stripHtml(g).trim(), MAX_FIELD_LENGTH))
    .filter((g): g is string => Boolean(g));

  return {
    title,
    author,
    publisher,
    language,
    description,
    isbn10,
    isbn13,
    publishedYear,
    series,
    seriesIndex,
    ...(truncatedGenres.length > 0 ? { genres: truncatedGenres } : {}),
  };
}

interface CoverRef {
  href: string;
  mediaType: string | undefined;
}

function extractManifestItemAttrs(tag: string): { href?: string; mediaType?: string } {
  return { href: getAttribute(tag, "href"), mediaType: getAttribute(tag, "media-type") };
}

function extractCoverHref(xml: string): CoverRef | undefined {
  // EPUB2: <meta name="cover" content="cover-image-id" />
  let coverId: string | undefined;
  for (const tag of scanTags(xml, "meta")) {
    if (getAttribute(tag.text, "name") !== "cover") continue;
    coverId = getAttribute(tag.text, "content");
    if (coverId) break;
  }

  // Find the manifest item with that id (attribute order is irrelevant here).
  if (coverId) {
    for (const tag of scanTags(xml, "item")) {
      if (getAttribute(tag.text, "id") !== coverId) continue;
      const attrs = extractManifestItemAttrs(tag.text);
      if (attrs.href) return { href: attrs.href, mediaType: attrs.mediaType };
      break;
    }
  }

  // EPUB3: <item properties="cover-image" href="..." />
  // The properties attribute may contain multiple space-separated values
  for (const tag of scanTags(xml, "item")) {
    const props = getAttribute(tag.text, "properties");
    if (props?.split(/\s+/).includes("cover-image")) {
      const attrs = extractManifestItemAttrs(tag.text);
      if (attrs.href) return { href: attrs.href, mediaType: attrs.mediaType };
    }
  }

  return undefined;
}

/**
 * Extract the actual image reference from an XHTML cover page.
 * Standard Ebooks and similar publishers wrap cover images in XHTML pages
 * containing SVG <image>, HTML <img>, or CSS background-image references.
 * Returns the image path (relative to the XHTML file) or undefined.
 */
function extractImageHrefFromXhtml(xhtml: string): string | undefined {
  // SVG <image> with xlink:href or href attribute
  for (const tag of scanTags(xhtml, "image")) {
    const xlink = getAttribute(tag.text, "xlink:href");
    if (xlink) return xlink;
  }
  for (const tag of scanTags(xhtml, "image")) {
    const href = getAttribute(tag.text, "href");
    if (href) return href;
  }

  // HTML <img> with src attribute
  for (const tag of scanTags(xhtml, "img")) {
    const src = getAttribute(tag.text, "src");
    if (src) return src;
  }

  // CSS background-image: url(...)
  return extractCssBackgroundImage(xhtml);
}

/** `background-image: url("...")` value, scanned with indexOf rather than a backtracking regex. */
function extractCssBackgroundImage(css: string): string | undefined {
  const property = "background-image:";
  let from = 0;
  for (;;) {
    const at = indexOfCaseInsensitive(css, property, from);
    if (at === -1) return undefined;
    from = at + property.length;

    const open = css.indexOf("(", from);
    if (open === -1) return undefined;
    // Only whitespace and the "url" keyword may sit between the colon and "(".
    if (css.slice(from, open).trim().toLowerCase() !== "url") continue;

    const close = css.indexOf(")", open + 1);
    if (close === -1) return undefined;

    let value = css.slice(open + 1, close).trim();
    const first = value.charCodeAt(0);
    if (first === CHAR_DQUOTE || first === CHAR_SQUOTE) value = value.slice(1);
    const last = value.charCodeAt(value.length - 1);
    if (last === CHAR_DQUOTE || last === CHAR_SQUOTE) value = value.slice(0, -1);
    if (value.length > 0) return value;
  }
}

/**
 * Resolve a relative path against a base directory path.
 * Handles "../" segments to navigate up from the base.
 */
function resolveRelativePath(basePath: string, relativePath: string): string {
  // Get the directory of the base path
  const baseDir = basePath.includes("/")
    ? basePath.substring(0, basePath.lastIndexOf("/") + 1)
    : "";

  const parts = baseDir.split("/").filter(Boolean);
  const relParts = relativePath.split("/");

  for (const part of relParts) {
    if (part === "..") {
      parts.pop();
    } else if (part !== "." && part !== "") {
      parts.push(part);
    }
  }

  return parts.join("/");
}

function parseYear(dateStr: string): number | undefined {
  const m = dateStr.match(/(\d{4})/);
  return m ? Number.parseInt(m[1]!, 10) || undefined : undefined;
}

// --- Fallback: scan local headers (for files with damaged EOCD) ---

function findOpfInLocalHeaders(buf: Buffer): string | null {
  let offset = 0;
  while (offset < buf.length - 30) {
    if (buf.readUInt32LE(offset) !== LOCAL_HEADER_SIG) {
      offset++;
      continue;
    }
    const compression = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const fileNameLength = buf.readUInt16LE(offset + 26);
    const extraLength = buf.readUInt16LE(offset + 28);
    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    const dataStart = fileNameEnd + extraLength;

    if (fileNameEnd > buf.length) break;

    const fileName = buf.subarray(fileNameStart, fileNameEnd).toString("utf8");

    if (fileName.endsWith(".opf") && compression === 0) {
      const size = compressedSize || uncompressedSize;
      const dataEnd = Math.min(dataStart + size, buf.length);
      return buf.subarray(dataStart, dataEnd).toString("utf8");
    }

    const entrySize = compressedSize || uncompressedSize;
    offset = dataStart + entrySize;
    if (offset <= 0) break;
  }
  return null;
}

async function fallbackExtract(filePath: string): Promise<NormalizedMetadata> {
  const chunks: Buffer[] = [];
  let total = 0;
  const maxBytes = 131072; // 128KB
  return new Promise((resolve) => {
    const stream = createReadStream(filePath, { highWaterMark: 8192 });
    stream.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      chunks.push(buf);
      total += buf.length;
      if (total >= maxBytes) stream.destroy();
    });
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        const buf = Buffer.concat(chunks);
        const opfXml = findOpfInLocalHeaders(buf);
        resolve(opfXml ? parseOpf(opfXml) : {});
      }
    };
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", () => {
      if (!resolved) {
        resolved = true;
        resolve({});
      }
    });
  });
}

// --- Shared EPUB OPF reader ---

interface EpubOpfResult {
  entries: ZipEntry[];
  opfEntry: ZipEntry;
  opfXml: string;
}

async function readEpubOpf(filePath: string): Promise<EpubOpfResult | null> {
  const fileInfo = await stat(filePath);
  const fileSize = Number(fileInfo.size);
  if (fileSize < EOCD_MIN_SIZE) return null;

  const tailSize = Math.min(fileSize, EOCD_MIN_SIZE + EOCD_MAX_COMMENT);
  const tailOffset = fileSize - tailSize;
  const tailBuf = await readRange(filePath, tailOffset, tailSize);

  const eocdPos = findEocd(tailBuf);
  if (eocdPos === -1) return null;

  const cdSize = tailBuf.readUInt32LE(eocdPos + 12);
  const cdOffset = tailBuf.readUInt32LE(eocdPos + 16);

  const entries = await readCentralDirectory(filePath, cdOffset, cdSize);

  const containerEntry = entries.find((e) => e.fileName === "META-INF/container.xml");
  let opfPath: string | null = null;
  if (containerEntry) {
    const containerBuf = await readZipEntry(filePath, containerEntry);
    if (containerBuf) {
      opfPath = parseContainerXml(containerBuf.toString("utf8"));
    }
  }

  let opfEntry: ZipEntry | undefined;
  if (opfPath) {
    opfEntry = entries.find((e) => e.fileName === opfPath);
  }
  if (!opfEntry) {
    opfEntry = entries.find((e) => e.fileName.endsWith(".opf"));
  }
  if (!opfEntry) return null;

  const opfBuf = await readZipEntry(filePath, opfEntry, {
    maxOutputBytes: MAX_OPF_BYTES,
    label: "OPF document",
  });
  if (!opfBuf) return null;

  return { entries, opfEntry, opfXml: opfBuf.toString("utf8") };
}

// --- Cover image extractor ---

/**
 * Extract the embedded cover image from an EPUB file.
 * Returns the raw image bytes, or null if no cover is found.
 */
export async function extractEpubCoverImage(filePath: string): Promise<Buffer | null> {
  try {
    logger.debug(`Extracting cover from: ${filePath}`);

    const result = await readEpubOpf(filePath);
    if (!result) {
      logger.warn(`Cover extraction failed: could not read OPF from ${filePath}`);
      return null;
    }

    const { entries, opfEntry, opfXml } = result;

    let coverEntry: ZipEntry | undefined;
    const coverRef = extractCoverHref(opfXml);

    if (coverRef) {
      // Resolve cover path relative to OPF directory
      const opfDir = opfEntry.fileName.includes("/")
        ? opfEntry.fileName.substring(0, opfEntry.fileName.lastIndexOf("/") + 1)
        : "";
      const coverZipPath = opfDir + coverRef.href;

      coverEntry =
        entries.find((e) => e.fileName === coverZipPath) ||
        entries.find((e) => e.fileName === coverRef.href);

      // If the manifest item is an XHTML page (not a direct image), read it
      // and extract the actual image reference from SVG/HTML/CSS inside.
      const xhtmlTypes = ["application/xhtml+xml", "text/html"];
      if (
        coverEntry &&
        coverRef.mediaType &&
        xhtmlTypes.includes(coverRef.mediaType.toLowerCase())
      ) {
        logger.debug(
          `Cover manifest item is XHTML (${coverRef.mediaType}): ${coverEntry.fileName}. ` +
            `Parsing for embedded image reference.`,
        );
        const xhtmlBuf = await readZipEntry(filePath, coverEntry, {
          maxOutputBytes: MAX_OPF_BYTES,
          label: "cover XHTML document",
        });
        if (xhtmlBuf) {
          const imageHref = extractImageHrefFromXhtml(xhtmlBuf.toString("utf8"));
          if (imageHref) {
            const resolvedPath = resolveRelativePath(coverEntry.fileName, imageHref);
            const imageEntry =
              entries.find((e) => e.fileName === resolvedPath) ||
              entries.find((e) => e.fileName === imageHref);
            if (imageEntry) {
              logger.debug(`Resolved XHTML cover wrapper to actual image: ${imageEntry.fileName}`);
              coverEntry = imageEntry;
            } else {
              logger.warn(
                `Image referenced in XHTML cover not found in ZIP. ` +
                  `Looked for "${resolvedPath}" or "${imageHref}". ` +
                  `Falling back to filename heuristic.`,
              );
              coverEntry = undefined;
            }
          } else {
            logger.warn(
              `Could not find image reference in XHTML cover page: ${coverEntry.fileName}. ` +
                `Falling back to filename heuristic.`,
            );
            coverEntry = undefined;
          }
        }
      }

      if (!coverEntry && !xhtmlTypes.includes(coverRef.mediaType?.toLowerCase() ?? "")) {
        logger.warn(
          `Cover file not found in ZIP. Looked for "${coverZipPath}" or "${coverRef.href}". ` +
            `Falling back to filename heuristic.`,
        );
      }
    }

    // Fallback: look for common cover filenames in the ZIP
    if (!coverEntry) {
      const imageExts = /\.(jpe?g|png|webp|gif)$/i;
      coverEntry = entries.find((e) => {
        const name = e.fileName.toLowerCase();
        const base = name.split("/").pop() ?? "";
        return base.startsWith("cover") && imageExts.test(base);
      });
      if (coverEntry) {
        logger.debug(`Cover found via filename heuristic: ${coverEntry.fileName}`);
      }
    }

    if (!coverEntry) {
      logger.warn(
        `Cover extraction failed: no cover in OPF or ZIP for ${opfEntry.fileName}. ` +
          `ZIP entries: [${entries.map((e) => e.fileName).join(", ")}]`,
      );
      return null;
    }

    const data = await readZipEntry(filePath, coverEntry, {
      maxOutputBytes: MAX_COVER_BYTES,
      label: "cover image",
    });
    if (!data || data.length === 0) {
      logger.warn(
        `Cover extraction failed: readZipEntry returned empty data for ${coverEntry.fileName}`,
      );
      return null;
    }

    logger.debug(`Cover extracted successfully: ${coverEntry.fileName} (${data.length} bytes)`);
    return data;
  } catch (err) {
    logger.withMetadata({ error: String(err) }).error(`Cover extraction threw for ${filePath}`);
    return null;
  }
}

// --- Body text sampler (for language detection) ---

/** Ordered list of content-document hrefs from the OPF spine. */
function parseSpineHrefs(opfXml: string): string[] {
  // manifest id -> href (only (X)HTML content documents)
  const idToHref = new Map<string, string>();
  for (const tag of scanTags(opfXml, "item")) {
    const id = getAttribute(tag.text, "id");
    const href = getAttribute(tag.text, "href");
    const mediaType = getAttribute(tag.text, "media-type");
    if (id && href && (!mediaType || /html|xml/i.test(mediaType))) {
      idToHref.set(id, href);
    }
  }

  const spineXml = elementContent(opfXml, "spine") ?? "";
  const hrefs: string[] = [];
  for (const tag of scanTags(spineXml, "itemref")) {
    const idref = getAttribute(tag.text, "idref");
    if (!idref) continue;
    const href = idToHref.get(idref);
    if (href) hrefs.push(href);
  }
  return hrefs;
}

/** Readable prose from an XHTML content document — body only, no script/style. */
function xhtmlToText(xhtml: string): string {
  const body = elementContent(xhtml, "body") ?? xhtml;
  // We only ever keep TEXT_SAMPLE_TARGET characters, so cap the input before
  // handing it to stripHtml() rather than stripping a whole 16 MB chapter.
  const bounded = body.length > MAX_TEXT_SCAN_BYTES ? body.slice(0, MAX_TEXT_SCAN_BYTES) : body;
  const withoutCode = removeElements(bounded, ["script", "style"]);
  return stripHtml(withoutCode).replace(/\s+/g, " ").trim();
}

/**
 * Extract a sample of body prose from an EPUB for language detection.
 *
 * Walks the spine in reading order, skips short front-matter documents (title /
 * copyright / dedication pages, which are unreliable and sometimes in another
 * language), and accumulates clean text up to a cap. Returns undefined when no
 * substantial prose is found. Intended as a fallback when the embedded
 * `<dc:language>` tag is missing or unrecognized.
 */
export async function extractEpubTextSample(filePath: string): Promise<string | undefined> {
  try {
    const result = await readEpubOpf(filePath);
    if (!result) return undefined;

    const { entries, opfEntry, opfXml } = result;
    const hrefs = parseSpineHrefs(opfXml);

    let collected = "";
    let scanned = 0;
    for (const href of hrefs) {
      if (collected.length >= TEXT_SAMPLE_TARGET || scanned >= MAX_SPINE_DOCS) break;

      const cleanHref = href.split("#")[0]!;
      const zipPath = resolveRelativePath(opfEntry.fileName, cleanHref);
      const entry =
        entries.find((e) => e.fileName === zipPath) ??
        entries.find((e) => e.fileName === cleanHref);
      if (!entry) continue;

      scanned++;
      const buf = await readZipEntry(filePath, entry);
      if (!buf) continue;

      const text = xhtmlToText(buf.toString("utf8"));
      if (text.length < MIN_DOC_TEXT) continue; // skip front matter
      collected += (collected ? " " : "") + text;
    }

    collected = collected.trim();
    return collected.length >= MIN_DOC_TEXT ? collected.slice(0, TEXT_SAMPLE_TARGET) : undefined;
  } catch {
    return undefined;
  }
}

// --- Main extractor ---

export async function extractEpubMetadata(filePath: string): Promise<NormalizedMetadata> {
  try {
    const result = await readEpubOpf(filePath);
    if (!result) return fallbackExtract(filePath);

    return parseOpf(result.opfXml);
  } catch (error: unknown) {
    if (error instanceof ZipLimitError) throw error;
    return {};
  }
}
