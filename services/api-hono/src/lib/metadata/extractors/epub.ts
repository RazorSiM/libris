import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { NormalizedMetadata } from "../../../types/index.js";
import {
  EOCD_MAX_COMMENT,
  EOCD_MIN_SIZE,
  LOCAL_HEADER_SIG,
  findEocd,
  parseCentralDirectory,
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

// --- container.xml parsing ---

function parseContainerXml(xml: string): string | null {
  const m = xml.match(/<rootfile[^>]+full-path="([^"]+)"[^>]*>/i);
  return m?.[1] || null;
}

// --- OPF parsing ---

// Field length limits to prevent DoS via extremely long metadata strings
const MAX_FIELD_LENGTH = 1000;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_OPF_BYTES = 2 * 1024 * 1024;
const MAX_XML_ELEMENT_BYTES = 20 * 1024;
const MAX_COVER_BYTES = 10 * 1024 * 1024;

// Body-text sampling for language detection (see extractEpubTextSample).
const TEXT_SAMPLE_TARGET = 1500; // stop once this many chars of prose are collected
const MIN_DOC_TEXT = 200; // skip spine docs shorter than this (likely front matter)
const MAX_SPINE_DOCS = 15; // cap how many spine docs we crack open

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return value;
  return value.length > max ? value.slice(0, max) : value;
}

function parseOpf(xml: string): NormalizedMetadata {
  const getAll = (tag: string): string[] => {
    const results: string[] = [];
    const openingTag = new RegExp(`<dc:${tag}(?:\\s[^>]*)?>`, "gi");
    const closingTag = `</dc:${tag}>`;
    const lowerXml = xml.toLowerCase();
    let opening: RegExpExecArray | null;
    while ((opening = openingTag.exec(xml))) {
      const contentStart = opening.index + opening[0].length;
      const contentEnd = lowerXml.indexOf(closingTag, contentStart);
      if (contentEnd === -1) break;
      const text = xml
        .slice(contentStart, Math.min(contentEnd, contentStart + MAX_XML_ELEMENT_BYTES))
        .trim();
      if (text) results.push(text);
      openingTag.lastIndex = contentEnd + closingTag.length;
    }
    return results;
  };

  const get = (tag: string): string | undefined => getAll(tag)[0] || undefined;

  // Strip HTML from text fields that could contain injected tags
  const title = truncate(stripHtml(get("title") ?? "").trim() || undefined, MAX_FIELD_LENGTH);

  // Multiple creators — join with ", "
  const creators = getAll("creator")
    .map((c) => stripHtml(c).trim())
    .filter(Boolean);
  const author = truncate(creators.length > 0 ? creators.join(", ") : undefined, MAX_FIELD_LENGTH);

  const publisher = truncate(
    stripHtml(get("publisher") ?? "").trim() || undefined,
    MAX_FIELD_LENGTH,
  );
  // Normalize the embedded language tag to a canonical ISO 639-1 code when we
  // recognize it (e.g. "en-GB" -> "en", "Italian" -> "it"); otherwise keep the
  // raw value so the file candidate still records what the file actually said.
  const rawLanguage = truncate(get("language"), MAX_FIELD_LENGTH);
  const language = normalizeLanguage(rawLanguage) ?? rawLanguage;

  // Description may contain HTML
  const rawDescription = get("description");
  const description = truncate(
    rawDescription ? stripHtml(rawDescription) : undefined,
    MAX_DESCRIPTION_LENGTH,
  );

  // dc:subject → genres
  const genres = getAll("subject");

  // Scan all dc:identifier elements for ISBNs
  const identifiers = getAll("identifier");
  // Also grab identifiers with opf:scheme="ISBN"
  for (const m of xml.matchAll(
    /<dc:identifier[^>]+opf:scheme="ISBN"[^>]*>([^<]*)<\/dc:identifier>/gi,
  )) {
    const v = m[1]?.trim();
    if (v && !identifiers.includes(v)) identifiers.push(v);
  }

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
  const series = truncate(
    stripHtml(seriesMatch?.[1]?.trim() ?? "").trim() || undefined,
    MAX_FIELD_LENGTH,
  );
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
  const hrefMatch = tag.match(/href="([^"]+)"/i);
  const mtMatch = tag.match(/media-type="([^"]+)"/i);
  return { href: hrefMatch?.[1], mediaType: mtMatch?.[1] };
}

function extractCoverHref(xml: string): CoverRef | undefined {
  // EPUB2: <meta name="cover" content="cover-image-id" />
  const metaMatch = xml.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/i);
  if (metaMatch) {
    const coverId = metaMatch[1]!;

    // Find manifest item with matching id
    const itemRe = new RegExp(`<item[^>]+id="${escapeRegex(coverId)}"[^>]*>`, "i");
    const m1 = xml.match(itemRe);
    if (m1) {
      const attrs = extractManifestItemAttrs(m1[0]);
      if (attrs.href) return { href: attrs.href, mediaType: attrs.mediaType };
    }

    // Try reversed attribute order (id after href)
    const itemRe2 = new RegExp(
      `<item[^>]+href="[^"]+"[^>]+id="${escapeRegex(coverId)}"[^>]*>`,
      "i",
    );
    const m2 = xml.match(itemRe2);
    if (m2) {
      const attrs = extractManifestItemAttrs(m2[0]);
      if (attrs.href) return { href: attrs.href, mediaType: attrs.mediaType };
    }
  }

  // EPUB3: <item properties="cover-image" href="..." />
  // The properties attribute may contain multiple space-separated values
  for (const m of xml.matchAll(/<item[^>]+>/gi)) {
    const tag = m[0];
    const propsMatch = tag.match(/properties="([^"]+)"/i);
    if (propsMatch && propsMatch[1]?.split(/\s+/).includes("cover-image")) {
      const attrs = extractManifestItemAttrs(tag);
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
  const svgImageXlink = xhtml.match(/<image[^>]+xlink:href="([^"]+)"/i);
  if (svgImageXlink?.[1]) return svgImageXlink[1];

  const svgImageHref = xhtml.match(/<image[^>]+href="([^"]+)"/i);
  if (svgImageHref?.[1]) return svgImageHref[1];

  // HTML <img> with src attribute
  const imgSrc = xhtml.match(/<img[^>]+src="([^"]+)"/i);
  if (imgSrc?.[1]) return imgSrc[1];

  // CSS background-image: url(...)
  const bgImage = xhtml.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
  if (bgImage?.[1]) return bgImage[1];

  return undefined;
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  const cdBuf = await readRange(filePath, cdOffset, cdSize);
  const entries = parseCentralDirectory(cdBuf, cdSize);

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
  for (const m of opfXml.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = tag.match(/\bid="([^"]+)"/i)?.[1];
    const href = tag.match(/\bhref="([^"]+)"/i)?.[1];
    const mediaType = tag.match(/\bmedia-type="([^"]+)"/i)?.[1];
    if (id && href && (!mediaType || /html|xml/i.test(mediaType))) {
      idToHref.set(id, href);
    }
  }

  const spineXml = opfXml.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i)?.[1] ?? "";
  const hrefs: string[] = [];
  for (const m of spineXml.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"[^>]*>/gi)) {
    const href = idToHref.get(m[1]!);
    if (href) hrefs.push(href);
  }
  return hrefs;
}

/** Readable prose from an XHTML content document — body only, no script/style. */
function xhtmlToText(xhtml: string): string {
  const body = xhtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? xhtml;
  const withoutCode = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
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
