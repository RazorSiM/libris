/**
 * Shared helpers for OPDS route handlers.
 */

import { z } from "zod";
import { acquisitionEntry } from "./opds-xml.js";

// ---------------------------------------------------------------------------
// Format → MIME mapping (shared with download route)
// ---------------------------------------------------------------------------

const FORMAT_MIMES: Record<string, string> = {
  epub: "application/epub+zip",
};

export function formatMime(format: string): string {
  return FORMAT_MIMES[format] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Derive the external base URL, respecting reverse-proxy headers.
 * Behind Traefik the internal URL is http:// but the client sees https://.
 */
export function getBaseUrl(requestUrl: string, forwardedProto?: string | null): string {
  const parsed = new URL(requestUrl);
  if (forwardedProto) {
    parsed.protocol = `${forwardedProto}:`;
  }
  return parsed.origin;
}

export function slugifyAuthor(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function slugifyGenre(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const OpdsPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
});

// ---------------------------------------------------------------------------
// Entry builder
// ---------------------------------------------------------------------------

interface BookRow {
  id: string;
  title: string | null;
  author: string | null;
  description: string | null;
  language: string | null;
  publisher: string | null;
  publishedYear: number | null;
  genres: string[];
  coverPath: string | null;
  coverUrl: string | null;
  updatedAt: Date;
}

interface FileRow {
  id: string;
  format: string;
}

const PER_PAGE = 20;
export { PER_PAGE as OPDS_PER_PAGE };

export function bookToEntry(book: BookRow, files: FileRow[], baseUrl: string): string {
  const coverAvailable = !!(book.coverPath || book.coverUrl);
  const coverHref = coverAvailable ? `${baseUrl}/opds/covers/${book.id}` : undefined;

  return acquisitionEntry({
    id: `urn:uuid:${book.id}`,
    title: book.title ?? "Untitled",
    updated: book.updatedAt,
    authors: book.author ? [book.author] : [],
    summary: book.description ?? undefined,
    dc: {
      language: book.language ?? undefined,
      publisher: book.publisher ?? undefined,
      published: book.publishedYear ? String(book.publishedYear) : undefined,
      categories: book.genres.length > 0 ? book.genres : undefined,
    },
    acquisitionLinks: files.map((f) => ({
      href: `${baseUrl}/opds/download/${f.id}`,
      type: formatMime(f.format),
    })),
    coverHref,
    thumbnailHref: coverHref,
  });
}
