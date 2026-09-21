import { readFile, rename, writeFile } from "node:fs/promises";
import { getAttribute, indexOfTag, scanTags } from "../xml/scan.ts";
import { buildZip, readAllZipEntries } from "./zip.ts";
import type { ZipBuildEntry } from "./zip.ts";

export interface EpubEmbedMetadata {
  title?: string | null;
  author?: string | null;
  isbn10?: string | null;
  isbn13?: string | null;
  publisher?: string | null;
  publishedYear?: number | null;
  language?: string | null;
  description?: string | null;
  series?: string | null;
  seriesIndex?: number | null;
  genres?: string[] | null;
}

/**
 * Largest OPF accepted for rewriting. A real one is tens of KiB even with a
 * huge manifest; anything past this is either malformed or hostile. Without
 * the cap the scanner below still runs linearly, but the rebuild would copy
 * the entry through the worker and into a fresh ZIP for no user benefit.
 */
export const DEFAULT_MAX_EMBED_OPF_BYTES = 1024 * 1024;

/** Hard ceiling on a single rewrite before the worker is terminated. */
export const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

export interface EmbedEpubMetadataOptions {
  coverImagePath?: string;
  /** Reject OPF documents larger than this. Default {@link DEFAULT_MAX_EMBED_OPF_BYTES}. */
  maxOpfBytes?: number;
}

/**
 * Rewrite an EPUB's OPF with approved metadata, in the calling thread.
 *
 * Runs inside a `node:worker_threads` worker in production (see
 * `embed-metadata.ts`); it is also the in-process entry point for tests. Writes
 * atomically (tmp file + rename). Non-epub files are silently skipped by the
 * caller, and any thrown error leaves the original file untouched.
 *
 * Every OPF scan here is a single forward pass from `lib/xml/scan.ts` — the
 * regexes this replaced backtracked quadratically on crafted documents.
 */
export async function embedEpubMetadataInProcess(
  filePath: string,
  metadata: EpubEmbedMetadata,
  options: EmbedEpubMetadataOptions = {},
): Promise<void> {
  const maxOpfBytes = options.maxOpfBytes ?? DEFAULT_MAX_EMBED_OPF_BYTES;

  const { entries, rawEntries } = await readAllZipEntries(filePath);
  const originalCompression = new Map(
    entries.map((entry) => [entry.fileName, entry.compression === 8] as const),
  );

  const opfPath = resolveOpfPath(rawEntries);
  if (!opfPath) {
    throw new Error("Could not find OPF file in EPUB");
  }

  const opfBuffer = rawEntries.get(opfPath);
  if (!opfBuffer) {
    throw new Error("Could not find OPF file in EPUB");
  }
  if (opfBuffer.byteLength > maxOpfBytes) {
    throw new Error(
      `OPF document is ${opfBuffer.byteLength} bytes, over the ${maxOpfBytes}-byte embedding limit`,
    );
  }

  const opfXml = opfBuffer.toString("utf8");
  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";

  // Modify OPF XML with new metadata
  let newOpfXml = rewriteMetadata(opfXml, metadata);

  // Handle cover image
  let coverData: Buffer | undefined;
  const entryNames = [...rawEntries.keys()];
  if (options.coverImagePath) {
    coverData = await readFile(options.coverImagePath);
    const existingCoverZipPath = findExistingCoverPath(opfXml, opfDir, entryNames);
    newOpfXml = embedCoverInOpf(newOpfXml, existingCoverZipPath);
  }

  // Rebuild the ZIP
  const buildEntries: ZipBuildEntry[] = [];
  const existingCoverZipPath = coverData ? findExistingCoverPath(opfXml, opfDir, entryNames) : null;

  // mimetype MUST be first and uncompressed
  const mimetypeData = rawEntries.get("mimetype");
  if (mimetypeData) {
    buildEntries.push({ name: "mimetype", data: mimetypeData, compress: false });
  }

  for (const [name, data] of rawEntries) {
    if (name === "mimetype") continue;

    if (name === opfPath) {
      // Replace OPF with modified version
      buildEntries.push({
        name,
        data: Buffer.from(newOpfXml, "utf8"),
        compress: originalCompression.get(name) ?? true,
      });
    } else if (coverData && existingCoverZipPath && name === existingCoverZipPath) {
      // Replace existing cover image (found via OPF metadata or filename heuristic)
      buildEntries.push({ name, data: coverData, compress: originalCompression.get(name) ?? true });
    } else {
      buildEntries.push({ name, data, compress: originalCompression.get(name) ?? true });
    }
  }

  // Add new cover image entry only if no existing cover was found to replace
  if (coverData && !existingCoverZipPath) {
    const coverZipPath = opfDir + "cover-embedded.jpg";
    buildEntries.push({ name: coverZipPath, data: coverData, compress: true });
  }

  const zipBuffer = buildZip(buildEntries);

  // Atomic write: write to tmp, then rename
  const tmpPath = filePath + ".tmp";
  await writeFile(tmpPath, zipBuffer);
  await rename(tmpPath, filePath);
}

export function hasAnyMetadata(m: EpubEmbedMetadata): boolean {
  return !!(
    m.title ||
    m.author ||
    m.isbn10 ||
    m.isbn13 ||
    m.publisher ||
    m.publishedYear ||
    m.language ||
    m.description ||
    m.series ||
    (m.genres && m.genres.length > 0)
  );
}

/**
 * Locate the package document: container.xml's rootfile first, any `.opf`
 * entry second. Linear via {@link scanTags}, unlike the regex this replaced.
 */
function resolveOpfPath(rawEntries: Map<string, Buffer>): string | null {
  const containerXml = rawEntries.get("META-INF/container.xml");
  if (containerXml) {
    for (const tag of scanTags(containerXml.toString("utf8"), "rootfile")) {
      const fullPath = getAttribute(tag.text, "full-path");
      if (fullPath && rawEntries.has(fullPath)) return fullPath;
    }
  }
  return [...rawEntries.keys()].find((k) => k.endsWith(".opf")) ?? null;
}

/** Escape a string for safe insertion into XML text content */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Rewrite the <metadata> section of an OPF XML string.
 * Removes existing DC elements and inserts new ones from metadata.
 * Preserves non-DC elements (like <meta> tags).
 */
function rewriteMetadata(opfXml: string, metadata: EpubEmbedMetadata): string {
  const firstTag = scanTags(opfXml, "metadata").next();
  if (firstTag.done) {
    // No metadata section — inject one before </package>
    const dcElements = buildDcElements(metadata);
    const packageClose = indexOfTag(opfXml, "</package>", 0);
    if (packageClose === -1) return opfXml;
    const injected = `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n${dcElements}  </metadata>\n`;
    return opfXml.slice(0, packageClose) + injected + opfXml.slice(packageClose);
  }

  const metaStartMatch = firstTag.value;
  const metaStartIdx = metaStartMatch.start;
  const metaStartEnd = metaStartMatch.end;

  const metaEndMatch = opfXml.indexOf("</metadata>", metaStartEnd);
  if (metaEndMatch === -1) return opfXml; // malformed, bail

  const metadataContent = opfXml.substring(metaStartEnd, metaEndMatch);

  // Remove existing DC elements, preserve non-DC elements (<meta> tags, etc.)
  const nonDcElements = extractNonDcElements(metadataContent, metadata);

  // Build new DC elements
  const dcElements = buildDcElements(metadata);

  // Ensure the metadata tag has the dc namespace
  let metaOpenTag = metaStartMatch.text;
  if (!metaOpenTag.includes("xmlns:dc")) {
    metaOpenTag = metaOpenTag.replace(
      ">",
      ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
    );
  }

  const newMetadataBlock = `${metaOpenTag}\n${dcElements}${nonDcElements}  </metadata>`;

  return (
    opfXml.substring(0, metaStartIdx) +
    newMetadataBlock +
    opfXml.substring(metaEndMatch + "</metadata>".length)
  );
}

const CHAR_GT = 0x3e; // ">"
const CHAR_SLASH = 0x2f; // "/"

function isWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  );
}

/**
 * Remove every `<dc:...>` element (self-closing and paired) in one forward
 * pass, preserving all surrounding text. Replaces the pair of regex scans
 * (`/<dc:[^>]*\/>/gi` then `/<dc:\w+[^>]*>[\s\S]*?<\/dc:\w+>/gi`) that
 * backtracked quadratically on unterminated tags.
 */
function removeDcElements(content: string): string {
  let out = "";
  let pos = 0;

  while (pos < content.length) {
    const open = indexOfTag(content, "<dc:", pos);
    if (open === -1) break;

    const gt = content.indexOf(">", open);
    if (gt === -1) break; // unterminated tag — the rest cannot match either

    const nameStart = open + "<dc:".length;
    if (!isWordCode(content.charCodeAt(nameStart))) {
      // `<dc:>` et al: the original `\w+` cannot match here; rescan past it.
      pos = open + 1;
      continue;
    }

    if (content.charCodeAt(gt - 1) === CHAR_SLASH) {
      out += content.slice(pos, open);
      pos = gt + 1;
      continue;
    }

    const close = findDcCloseTag(content, gt + 1);
    if (!close) {
      // No `</dc:word>` anywhere ahead, so no later open can pair either.
      out += content.slice(pos, gt + 1);
      pos = gt + 1;
      continue;
    }

    out += content.slice(pos, open);
    pos = close.end;
  }

  return out + content.slice(pos);
}

/** First `</dc:word>` at or after `from`, case-insensitively. Linear. */
function findDcCloseTag(content: string, from: number): { start: number; end: number } | null {
  let pos = from;
  while (pos < content.length) {
    const open = indexOfTag(content, "</dc:", pos);
    if (open === -1) return null;
    const nameStart = open + "</dc:".length;
    let i = nameStart;
    while (i < content.length && isWordCode(content.charCodeAt(i))) i++;
    if (i > nameStart && content.charCodeAt(i) === CHAR_GT) {
      return { start: open, end: i + 1 };
    }
    pos = open + 1;
  }
  return null;
}

/** Remove `<meta name="calibre:series[_index]" ...>` tags, linearly. */
function removeCalibreSeriesMetas(content: string): string {
  let out = "";
  let pos = 0;
  for (const tag of scanTags(content, "meta")) {
    if (tag.start < pos) continue;
    const name = getAttribute(tag.text, "name");
    if (name !== "calibre:series" && name !== "calibre:series_index") continue;
    out += content.slice(pos, tag.start);
    pos = tag.end;
  }
  return out + content.slice(pos);
}

/**
 * Extract non-DC elements from the metadata section content.
 * DC elements match <dc:*>...</dc:*> pattern.
 * When series metadata is provided, also strips existing calibre:series meta tags
 * so they can be replaced with the approved values.
 */
function extractNonDcElements(content: string, metadata?: EpubEmbedMetadata): string {
  let cleaned = removeDcElements(content);
  // Remove existing calibre:series meta tags when we have series data to write
  if (metadata?.series) {
    cleaned = removeCalibreSeriesMetas(cleaned);
  }
  // Trim blank lines but preserve actual content
  const lines = cleaned
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (line.endsWith("\n") ? line : line + "\n"));
  return lines.length > 0 ? lines.join("") + "\n" : "";
}

function buildDcElements(metadata: EpubEmbedMetadata): string {
  const lines: string[] = [];

  if (metadata.title) {
    lines.push(`    <dc:title>${escapeXml(metadata.title)}</dc:title>`);
  }
  if (metadata.author) {
    lines.push(`    <dc:creator>${escapeXml(metadata.author)}</dc:creator>`);
  }
  if (metadata.publisher) {
    lines.push(`    <dc:publisher>${escapeXml(metadata.publisher)}</dc:publisher>`);
  }
  if (metadata.language) {
    lines.push(`    <dc:language>${escapeXml(metadata.language)}</dc:language>`);
  }
  if (metadata.description) {
    lines.push(`    <dc:description>${escapeXml(metadata.description)}</dc:description>`);
  }
  if (metadata.publishedYear) {
    lines.push(`    <dc:date>${metadata.publishedYear}</dc:date>`);
  }
  if (metadata.isbn13) {
    lines.push(
      `    <dc:identifier id="isbn13">urn:isbn:${escapeXml(metadata.isbn13)}</dc:identifier>`,
    );
  }
  if (metadata.isbn10) {
    lines.push(`    <dc:identifier id="isbn10">${escapeXml(metadata.isbn10)}</dc:identifier>`);
  }
  if (metadata.genres && metadata.genres.length > 0) {
    for (const genre of metadata.genres) {
      lines.push(`    <dc:subject>${escapeXml(genre)}</dc:subject>`);
    }
  }
  if (metadata.series) {
    lines.push(`    <meta name="calibre:series" content="${escapeXml(metadata.series)}"/>`);
    if (metadata.seriesIndex != null) {
      lines.push(
        `    <meta name="calibre:series_index" content="${String(metadata.seriesIndex)}"/>`,
      );
    }
  }

  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

/**
 * Find the ZIP path of an existing cover image, using OPF metadata first
 * then falling back to filename heuristic (cover.{jpg,jpeg,png,webp,gif}).
 */
function findExistingCoverPath(
  opfXml: string,
  opfDir: string,
  entryNames: string[],
): string | null {
  const coverHref = extractCoverHref(opfXml);
  if (coverHref) {
    const resolved = opfDir + coverHref;
    if (entryNames.includes(resolved)) return resolved;
    if (entryNames.includes(coverHref)) return coverHref;
  }

  // Filename heuristic: look for cover.{jpg,jpeg,png,webp,gif}
  const imageExts = /\.(jpe?g|png|webp|gif)$/i;
  return (
    entryNames.find((name) => {
      const base = name.toLowerCase().split("/").pop() ?? "";
      return base.startsWith("cover") && imageExts.test(base);
    }) ?? null
  );
}

/**
 * Find the cover href an OPF already references: EPUB2's
 * `<meta name="cover" content="id">` + manifest item, or EPUB3's
 * `<item properties="cover-image">`. Linear tag scans throughout.
 */
function extractCoverHref(xml: string): string | null {
  // EPUB2: <meta name="cover" content="cover-image-id" />
  let coverId: string | undefined;
  for (const tag of scanTags(xml, "meta")) {
    if (getAttribute(tag.text, "name") === "cover") {
      coverId = getAttribute(tag.text, "content");
      break;
    }
  }
  if (coverId) {
    for (const tag of scanTags(xml, "item")) {
      if (getAttribute(tag.text, "id") !== coverId) continue;
      const href = getAttribute(tag.text, "href");
      if (href) return href;
    }
  }

  // EPUB3: <item properties="cover-image" href="..." />
  for (const tag of scanTags(xml, "item")) {
    const props = getAttribute(tag.text, "properties");
    if (!props || !props.split(/\s+/).includes("cover-image")) continue;
    const href = getAttribute(tag.text, "href");
    if (href) return href;
  }

  return null;
}

/**
 * Add or update cover image references in OPF XML.
 * If existingCoverZipPath is provided (found via heuristic), add OPF metadata
 * pointing to that file instead of creating a new cover-embedded.jpg entry.
 */
function embedCoverInOpf(opfXml: string, existingCoverZipPath: string | null): string {
  const existingHref = extractCoverHref(opfXml);

  if (existingHref) {
    // OPF already references a cover — the image data is replaced in the ZIP entries
    return opfXml;
  }

  // Determine the href and media type for the cover entry
  const coverHref = existingCoverZipPath ?? "cover-embedded.jpg";
  const ext = coverHref.split(".").pop()?.toLowerCase() ?? "jpg";
  const mediaType =
    ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : ext === "gif"
          ? "image/gif"
          : "image/jpeg";

  // Add manifest item
  const manifestItem = `<item id="cover-embedded" href="${coverHref}" media-type="${mediaType}"/>`;
  const manifestClose = indexOfTag(opfXml, "</manifest>", 0);
  if (manifestClose !== -1) {
    opfXml =
      opfXml.slice(0, manifestClose) + `    ${manifestItem}\n  ` + opfXml.slice(manifestClose);
  }

  // Add meta cover reference in metadata
  const coverMeta = `    <meta name="cover" content="cover-embedded"/>`;
  const metadataClose = indexOfTag(opfXml, "</metadata>", 0);
  if (metadataClose !== -1) {
    opfXml = opfXml.slice(0, metadataClose) + `${coverMeta}\n  ` + opfXml.slice(metadataClose);
  }

  return opfXml;
}
