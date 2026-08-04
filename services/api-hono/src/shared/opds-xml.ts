/**
 * Atom XML builder for OPDS 1.2 feeds.
 *
 * Builds well-formed Atom XML with OPDS catalog, Dublin Core, and
 * OpenSearch namespaces. All text values are XML-escaped automatically.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OPDS_MIME_NAVIGATION = "application/atom+xml;profile=opds-catalog;kind=navigation";
export const OPDS_MIME_ACQUISITION = "application/atom+xml;profile=opds-catalog;kind=acquisition";
export const OPDS_MIME_CATALOG = "application/atom+xml;profile=opds-catalog";
export const OPDS_MIME_ENTRY = "application/atom+xml;type=entry;profile=opds-catalog";
export const OPDS_MIME_OPENSEARCH = "application/opensearchdescription+xml";

// Acquisition link relations
export const REL_ACQUISITION = "http://opds-spec.org/acquisition";
export const REL_ACQUISITION_OPEN_ACCESS = "http://opds-spec.org/acquisition/open-access";
export const REL_IMAGE = "http://opds-spec.org/image";
export const REL_THUMBNAIL = "http://opds-spec.org/image/thumbnail";

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

/** Remove code points XML 1.0 cannot represent, preserving tab, LF, and CR. */
export function stripXmlInvalidCharacters(str: string): string {
  let result = "";
  for (const character of str) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      result += character;
    }
  }
  return result;
}

export function escapeXml(str: string): string {
  return stripXmlInvalidCharacters(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedOptions {
  id: string;
  title: string;
  updated?: Date | string;
  author?: string;
  selfHref: string;
  selfType?: string;
  startHref?: string;
}

export interface LinkOptions {
  rel: string;
  href: string;
  type?: string;
  title?: string;
}

export interface NavigationEntryOptions {
  id: string;
  title: string;
  updated?: Date | string;
  content?: string;
  link: LinkOptions;
}

export interface DublinCoreOptions {
  language?: string;
  publisher?: string;
  published?: string;
  categories?: string[];
}

export interface AcquisitionEntryOptions {
  id: string;
  title: string;
  updated?: Date | string;
  authors?: string[];
  summary?: string;
  dc?: DublinCoreOptions;
  acquisitionLinks: { href: string; type: string }[];
  coverHref?: string;
  thumbnailHref?: string;
}

export interface PaginationOptions {
  currentPage: number;
  totalPages: number;
  perPage: number;
  totalResults: number;
  baseHref: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date | string | undefined): string {
  if (!d) return new Date().toISOString();
  return d instanceof Date ? d.toISOString() : d;
}

function xmlLink(link: LinkOptions): string {
  const parts = [`rel="${escapeXml(link.rel)}"`, `href="${escapeXml(link.href)}"`];
  if (link.type) parts.push(`type="${escapeXml(link.type)}"`);
  if (link.title) parts.push(`title="${escapeXml(link.title)}"`);
  return `  <link ${parts.join(" ")}/>`;
}

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

/**
 * Build a navigation entry (links to a sub-catalog).
 */
export function navigationEntry(opts: NavigationEntryOptions): string {
  const lines: string[] = [
    "  <entry>",
    `    <id>${escapeXml(opts.id)}</id>`,
    `    <title>${escapeXml(opts.title)}</title>`,
    `    <updated>${formatDate(opts.updated)}</updated>`,
  ];

  if (opts.content) {
    lines.push(`    <content type="text">${escapeXml(opts.content)}</content>`);
  }

  const link = opts.link;
  const linkParts = [`rel="${escapeXml(link.rel)}"`, `href="${escapeXml(link.href)}"`];
  if (link.type) linkParts.push(`type="${escapeXml(link.type)}"`);
  if (link.title) linkParts.push(`title="${escapeXml(link.title)}"`);
  lines.push(`    <link ${linkParts.join(" ")}/>`);

  lines.push("  </entry>");
  return lines.join("\n");
}

/**
 * Build an acquisition entry (a book with download links and metadata).
 */
export function acquisitionEntry(opts: AcquisitionEntryOptions): string {
  const lines: string[] = [
    "  <entry>",
    `    <id>${escapeXml(opts.id)}</id>`,
    `    <title>${escapeXml(opts.title)}</title>`,
    `    <updated>${formatDate(opts.updated)}</updated>`,
  ];

  if (opts.authors?.length) {
    for (const author of opts.authors) {
      lines.push("    <author>");
      lines.push(`      <name>${escapeXml(author)}</name>`);
      lines.push("    </author>");
    }
  }

  if (opts.summary) {
    lines.push(`    <summary type="text">${escapeXml(opts.summary)}</summary>`);
  }

  // Dublin Core metadata
  if (opts.dc?.language) {
    lines.push(`    <dc:language>${escapeXml(opts.dc.language)}</dc:language>`);
  }
  if (opts.dc?.publisher) {
    lines.push(`    <dc:publisher>${escapeXml(opts.dc.publisher)}</dc:publisher>`);
  }
  if (opts.dc?.published) {
    lines.push(`    <dc:issued>${escapeXml(opts.dc.published)}</dc:issued>`);
  }
  if (opts.dc?.categories?.length) {
    for (const cat of opts.dc.categories) {
      lines.push(`    <category term="${escapeXml(cat)}"/>`);
    }
  }

  // Acquisition links
  for (const acq of opts.acquisitionLinks) {
    lines.push(
      `    <link rel="${REL_ACQUISITION_OPEN_ACCESS}" href="${escapeXml(acq.href)}" type="${escapeXml(acq.type)}"/>`,
    );
  }

  // Cover / thumbnail
  if (opts.coverHref) {
    lines.push(
      `    <link rel="${REL_IMAGE}" href="${escapeXml(opts.coverHref)}" type="image/jpeg"/>`,
    );
  }
  if (opts.thumbnailHref) {
    lines.push(
      `    <link rel="${REL_THUMBNAIL}" href="${escapeXml(opts.thumbnailHref)}" type="image/jpeg"/>`,
    );
  }

  lines.push("  </entry>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Build pagination links and OpenSearch elements for a feed.
 * Returns an array of XML lines to include inside the <feed>.
 */
export function paginationLinks(opts: PaginationOptions): string[] {
  const lines: string[] = [];

  // OpenSearch totalResults / startIndex / itemsPerPage
  lines.push(`  <opensearch:totalResults>${opts.totalResults}</opensearch:totalResults>`);
  lines.push(
    `  <opensearch:startIndex>${(opts.currentPage - 1) * opts.perPage + 1}</opensearch:startIndex>`,
  );
  lines.push(`  <opensearch:itemsPerPage>${opts.perPage}</opensearch:itemsPerPage>`);

  // Separator between base and query param
  const sep = opts.baseHref.includes("?") ? "&" : "?";

  if (opts.currentPage > 1) {
    const prevHref = `${opts.baseHref}${sep}page=${opts.currentPage - 1}`;
    lines.push(xmlLink({ rel: "previous", href: prevHref, type: OPDS_MIME_ACQUISITION }));
  }

  if (opts.currentPage < opts.totalPages) {
    const nextHref = `${opts.baseHref}${sep}page=${opts.currentPage + 1}`;
    lines.push(xmlLink({ rel: "next", href: nextHref, type: OPDS_MIME_ACQUISITION }));
  }

  // First / last
  lines.push(
    xmlLink({ rel: "first", href: `${opts.baseHref}${sep}page=1`, type: OPDS_MIME_ACQUISITION }),
  );
  lines.push(
    xmlLink({
      rel: "last",
      href: `${opts.baseHref}${sep}page=${opts.totalPages}`,
      type: OPDS_MIME_ACQUISITION,
    }),
  );

  return lines;
}

// ---------------------------------------------------------------------------
// Feed builder
// ---------------------------------------------------------------------------

/**
 * Build a complete OPDS Atom XML feed.
 *
 * @param feed    - Feed-level metadata (id, title, links)
 * @param entries - Pre-built entry XML strings from navigationEntry() / acquisitionEntry()
 * @param extra   - Additional XML lines to insert (e.g. pagination from paginationLinks())
 */
export function buildFeed(feed: FeedOptions, entries: string[], extra?: string[]): string {
  const selfType = feed.selfType ?? OPDS_MIME_NAVIGATION;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom"',
    '      xmlns:dc="http://purl.org/dc/terms/"',
    '      xmlns:opds="http://opds-spec.org/2010/catalog"',
    '      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">',
    `  <id>${escapeXml(feed.id)}</id>`,
    `  <title>${escapeXml(feed.title)}</title>`,
    `  <updated>${formatDate(feed.updated)}</updated>`,
  ];

  if (feed.author) {
    lines.push("  <author>");
    lines.push(`    <name>${escapeXml(feed.author)}</name>`);
    lines.push("  </author>");
  }

  // Self link
  lines.push(xmlLink({ rel: "self", href: feed.selfHref, type: selfType }));

  // Start link
  if (feed.startHref) {
    lines.push(xmlLink({ rel: "start", href: feed.startHref, type: OPDS_MIME_NAVIGATION }));
  }

  // Extra lines (pagination, search link, etc.)
  if (extra?.length) {
    lines.push(...extra);
  }

  // Entries
  lines.push(...entries);

  lines.push("</feed>");
  return lines.join("\n");
}
