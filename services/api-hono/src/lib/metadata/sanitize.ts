/**
 * Strip HTML tags and decode common HTML/XML entities from a string.
 * Used to sanitize metadata from all sources (EPUB, PDF, API responses)
 * before storing in the database.
 */
export function stripHtml(html: string): string {
  // Decode XML entities first so escaped HTML tags become real tags
  const decoded = html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  return stripXmlInvalidCharacters(decoded)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Sanitize all text fields in a NormalizedMetadata object.
 * Strips HTML from title, author, publisher, description, and genres.
 * Non-string fields (isbn, year, pageCount, coverUrl, language) are left as-is.
 */
export function sanitizeMetadata<
  T extends {
    title?: string | null;
    author?: string | null;
    publisher?: string | null;
    description?: string | null;
    series?: string | null;
    genres?: string[];
  },
>(metadata: T): T {
  const result = { ...metadata };

  if (typeof result.title === "string")
    result.title = (stripHtml(result.title).trim() || undefined) as T["title"];
  if (typeof result.author === "string")
    result.author = (stripHtml(result.author).trim() || undefined) as T["author"];
  if (typeof result.publisher === "string")
    result.publisher = (stripHtml(result.publisher).trim() || undefined) as T["publisher"];
  if (typeof result.description === "string")
    result.description = (stripHtml(result.description).trim() || undefined) as T["description"];
  if (typeof result.series === "string")
    result.series = (stripHtml(result.series).trim() || undefined) as T["series"];
  if (result.genres) {
    result.genres = result.genres.map((g) => stripHtml(g).trim()).filter(Boolean) as T["genres"];
  }

  return result;
}

/** Validate ISBN check digit to filter out junk numbers from EPUB metadata. */
export function isValidIsbn(isbn: string): boolean {
  if (isbn.length === 13 && /^(978|979)\d{10}$/.test(isbn)) {
    // ISBN-13 check digit: alternating weights 1,3
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return (10 - (sum % 10)) % 10 === Number(isbn[12]);
  }
  if (isbn.length === 10 && /^\d{9}[\dXx]$/.test(isbn)) {
    // ISBN-10 check digit: weighted sum mod 11
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += Number(isbn[i]) * (10 - i);
    }
    const check = isbn[9]!.toUpperCase() === "X" ? 10 : Number(isbn[9]);
    return (sum + check) % 11 === 0;
  }
  return false;
}
import { stripXmlInvalidCharacters } from "../../shared/opds-xml.js";
