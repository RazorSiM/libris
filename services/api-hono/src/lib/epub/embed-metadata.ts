import { readFile, rename, writeFile } from "node:fs/promises";
import { buildZip, readAllZipEntries } from "./zip.js";
import type { ZipBuildEntry } from "./zip.js";

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
 * Embed approved metadata into an EPUB file's OPF Dublin Core section.
 * Writes atomically (tmp file + rename). Non-epub files are silently skipped.
 */
export async function embedEpubMetadata(
  filePath: string,
  metadata: EpubEmbedMetadata,
  coverImagePath?: string,
): Promise<void> {
  // Skip if no meaningful metadata to embed
  if (!hasAnyMetadata(metadata) && !coverImagePath) return;

  const { entries, rawEntries } = await readAllZipEntries(filePath);
  const originalCompression = new Map(
    entries.map((entry) => [entry.fileName, entry.compression === 8] as const),
  );

  // Find OPF path from container.xml
  const containerXml = rawEntries.get("META-INF/container.xml");
  let opfPath: string | null = null;
  if (containerXml) {
    const match = containerXml.toString("utf8").match(/<rootfile[^>]+full-path="([^"]+)"[^>]*>/i);
    opfPath = match?.[1] ?? null;
  }

  // Fallback: find by .opf extension
  if (!opfPath || !rawEntries.has(opfPath)) {
    opfPath = [...rawEntries.keys()].find((k) => k.endsWith(".opf")) ?? null;
  }

  if (!opfPath) {
    throw new Error("Could not find OPF file in EPUB");
  }

  const opfXml = rawEntries.get(opfPath)!.toString("utf8");
  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";

  // Modify OPF XML with new metadata
  let newOpfXml = rewriteMetadata(opfXml, metadata);

  // Handle cover image
  let coverData: Buffer | undefined;
  const entryNames = [...rawEntries.keys()];
  if (coverImagePath) {
    coverData = await readFile(coverImagePath);
    const existingCoverZipPath = findExistingCoverPath(opfXml, opfDir, entryNames);
    newOpfXml = embedCoverInOpf(newOpfXml, opfDir, coverImagePath, existingCoverZipPath);
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

function hasAnyMetadata(m: EpubEmbedMetadata): boolean {
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
  // Find the <metadata ...> ... </metadata> block
  const metaStartMatch = opfXml.match(/<metadata[^>]*>/i);
  if (!metaStartMatch) {
    // No metadata section — inject one before </package>
    const dcElements = buildDcElements(metadata);
    return opfXml.replace(
      /<\/package>/i,
      `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n${dcElements}  </metadata>\n</package>`,
    );
  }

  const metaStartIdx = metaStartMatch.index!;
  const metaStartEnd = metaStartIdx + metaStartMatch[0].length;

  const metaEndMatch = opfXml.indexOf("</metadata>", metaStartEnd);
  if (metaEndMatch === -1) return opfXml; // malformed, bail

  const metadataContent = opfXml.substring(metaStartEnd, metaEndMatch);

  // Remove existing DC elements, preserve non-DC elements (<meta> tags, etc.)
  const nonDcElements = extractNonDcElements(metadataContent, metadata);

  // Build new DC elements
  const dcElements = buildDcElements(metadata);

  // Ensure the metadata tag has the dc namespace
  let metaOpenTag = metaStartMatch[0];
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

/**
 * Extract non-DC elements from the metadata section content.
 * DC elements match <dc:*>...</dc:*> pattern.
 * When series metadata is provided, also strips existing calibre:series meta tags
 * so they can be replaced with the approved values.
 */
function extractNonDcElements(content: string, metadata?: EpubEmbedMetadata): string {
  // Remove all dc: elements (both self-closing and paired)
  let cleaned = content.replace(/<dc:[^>]*\/>/gi, "");
  cleaned = cleaned.replace(/<dc:\w+[^>]*>[\s\S]*?<\/dc:\w+>/gi, "");
  // Remove existing calibre:series meta tags when we have series data to write
  if (metadata?.series) {
    cleaned = cleaned.replace(/<meta\s+name=["']calibre:series(?:_index)?["'][^>]*\/?>/gi, "");
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

function extractCoverHref(xml: string): string | null {
  // EPUB2: <meta name="cover" content="cover-image-id" />
  const metaMatch = xml.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/i);
  if (metaMatch) {
    const coverId = metaMatch[1];
    const escId = coverId!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Try both attribute orders
    const m1 = xml.match(new RegExp(`<item[^>]+id="${escId}"[^>]+href="([^"]+)"`, "i"));
    if (m1) return m1[1]!;
    const m2 = xml.match(new RegExp(`<item[^>]+href="([^"]+)"[^>]+id="${escId}"`, "i"));
    if (m2) return m2[1]!;
  }

  // EPUB3: <item properties="cover-image" href="..." />
  for (const m of xml.matchAll(/<item[^>]+>/gi)) {
    const tag = m[0];
    const propsMatch = tag.match(/properties="([^"]+)"/i);
    if (propsMatch && propsMatch[1]!.split(/\s+/).includes("cover-image")) {
      const hrefMatch = tag.match(/href="([^"]+)"/i);
      if (hrefMatch) return hrefMatch[1]!;
    }
  }

  return null;
}

/**
 * Add or update cover image references in OPF XML.
 * If existingCoverZipPath is provided (found via heuristic), add OPF metadata
 * pointing to that file instead of creating a new cover-embedded.jpg entry.
 */
function embedCoverInOpf(
  opfXml: string,
  _opfDir: string,
  coverImagePath: string,
  existingCoverZipPath: string | null,
): string {
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
  opfXml = opfXml.replace(/<\/manifest>/i, `    ${manifestItem}\n  </manifest>`);

  // Add meta cover reference in metadata
  const coverMeta = `    <meta name="cover" content="cover-embedded"/>`;
  opfXml = opfXml.replace(/<\/metadata>/i, `${coverMeta}\n  </metadata>`);

  return opfXml;
}
