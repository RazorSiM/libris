/**
 * E2E: OPDS feed and e-reader compatibility.
 *
 * Tests the OPDS catalog using Playwright's request context (no browser).
 * Verifies XML feed structure, book entries, search, cover image streaming,
 * file download, Basic auth for e-readers, and Content-Type headers.
 *
 * Books are seeded directly into the database (organized status) because
 * /__test/seed-books is unavailable in dev mode (import.meta.test = false).
 */

import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  API_BASE,
  deleteAllBooks,
  seedOrganizedBook,
  seedBookFile,
  seedOpdsCredentials,
} from "./helpers";

// ---------------------------------------------------------------------------
// OPDS auth — Basic auth with service credentials
// ---------------------------------------------------------------------------

const OPDS_USER = "opds-e2e";
const OPDS_PASS = "opds-e2e-pass";

function opdsHeaders(): Record<string, string> {
  const encoded = Buffer.from(`${OPDS_USER}:${OPDS_PASS}`).toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

function getLibraryPath(): string {
  const p = process.env.LIBRIS_LIBRARY_PATH;
  if (!p) throw new Error("LIBRIS_LIBRARY_PATH not set");
  return p;
}

// Minimal valid JPEG (1x1 pixel) — shared across cover tests
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
  0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00,
  0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
  0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
  0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94,
  0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2,
  0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
  0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda,
  0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7b, 0x94, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xd9,
]);

const EPUB_TEST_CONTENT = Buffer.from("PK\x03\x04fake-epub-content-for-testing");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// NOTE: These tests have been ported to Vitest integration tests at:
// services/api-hono/src/routes/opds.test.ts
// The integration tests use a Hono test client + PGlite and don't require
// a live server. The cover image and file download tests still require E2E
// because they access the real filesystem.
//
// All tests skipped here. Re-enable the describe block (remove .skip) if you
// need to run the full E2E suite against a live server.
test.describe.skip("OPDS Feed", { tag: "@smoke" }, () => {
  test.describe.configure({ mode: "serial" });

  // Shared state populated in beforeAll
  let prideBookId: string;
  let downloadFileId: string;

  test.beforeAll(async () => {
    await seedOpdsCredentials(OPDS_USER, OPDS_PASS);
    await deleteAllBooks();

    // Create cover file on disk
    const libraryPath = getLibraryPath();
    mkdirSync(join(libraryPath, "covers"), { recursive: true });
    writeFileSync(join(libraryPath, "covers", "test-cover.jpg"), JPEG_BYTES);

    // Create download file on disk
    mkdirSync(join(libraryPath, "books"), { recursive: true });
    writeFileSync(join(libraryPath, "books", "test-download.epub"), EPUB_TEST_CONTENT);

    // Book 1: Pride and Prejudice — full metadata, cover, epub + pdf files
    prideBookId = await seedOrganizedBook({
      title: "Pride and Prejudice",
      author: "Jane Austen",
      genres: ["Romance", "Classic"],
      publisher: "T. Egerton",
      language: "en",
      coverPath: "covers/test-cover.jpg",
    });
    downloadFileId = await seedBookFile(prideBookId, {
      format: "epub",
      originalName: "test-download.epub",
      storagePath: "books/test-download.epub",
      fileSize: EPUB_TEST_CONTENT.length,
    });
    await seedBookFile(prideBookId, { format: "pdf", originalName: "test.pdf" });

    // Book 2: 1984 — no files (used for search exclusion tests)
    await seedOrganizedBook({ title: "1984", author: "George Orwell" });
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("OPDS index at /opds returns valid navigation XML", async () => {
    const res = await fetch(`${API_BASE}/opds?_t=${Date.now()}`, {
      headers: opdsHeaders(),
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/atom+xml");
    expect(contentType).toContain("kind=navigation");

    const xml = await res.text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(xml).toContain("<title>Libris</title>");
    expect(xml).toContain("New Arrivals");
    expect(xml).toContain("All Books");
    expect(xml).toContain("Languages");
    expect(xml).toContain('rel="search"');
    expect(xml).toContain("opensearchdescription+xml");
  });

  test("/opds/languages lists present languages and filters by language", async () => {
    const navRes = await fetch(`${API_BASE}/opds/languages?_t=${Date.now()}`, {
      headers: opdsHeaders(),
    });
    expect(navRes.status).toBe(200);
    expect(navRes.headers.get("content-type") ?? "").toContain("kind=navigation");

    const navXml = await navRes.text();
    expect(navXml).toContain("<title>English</title>"); // full name, not the code
    expect(navXml).toContain("/opds/languages/en");
    expect(navXml).not.toContain("Italian"); // only languages we actually have

    const enRes = await fetch(`${API_BASE}/opds/languages/en?_t=${Date.now()}`, {
      headers: opdsHeaders(),
    });
    expect(enRes.status).toBe(200);
    expect(enRes.headers.get("content-type") ?? "").toContain("kind=acquisition");

    const enXml = await enRes.text();
    expect(enXml).toContain("Pride and Prejudice");
    expect(enXml).not.toContain(">1984<"); // 1984 has no language set
  });

  test("/opds/books returns acquisition feed with book entries", async () => {
    const res = await fetch(`${API_BASE}/opds/books?_t=${Date.now()}`, {
      headers: opdsHeaders(),
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/atom+xml");
    expect(contentType).toContain("kind=acquisition");

    const xml = await res.text();
    // Book entries
    expect(xml).toContain("Pride and Prejudice");
    expect(xml).toContain("Jane Austen");
    expect(xml).toContain("1984");
    expect(xml).toContain("George Orwell");

    // Dublin Core metadata
    expect(xml).toContain("<dc:language>en</dc:language>");
    expect(xml).toContain("<dc:publisher>T. Egerton</dc:publisher>");
    expect(xml).toContain('<category term="Romance"/>');
    expect(xml).toContain('<category term="Classic"/>');

    // Acquisition link for the epub file
    expect(xml).toContain("application/epub+zip");
    expect(xml).toContain("/opds/download/");

    // Pagination elements
    expect(xml).toContain("opensearch:totalResults");
    expect(xml).toContain(">2<"); // 2 books total
  });

  test("/opds/search?q=pride returns filtered results", async () => {
    const res = await fetch(`${API_BASE}/opds/search?q=pride&_t=${Date.now()}`, {
      headers: opdsHeaders(),
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("kind=acquisition");

    const xml = await res.text();
    expect(xml).toContain("Pride and Prejudice");
    expect(xml).not.toContain(">1984<");
    expect(xml).toContain("<title>Search: pride</title>");
  });

  test("/opds/search without query returns OpenSearch description", async () => {
    const res = await fetch(`${API_BASE}/opds/search?_t=${Date.now()}`, {
      headers: opdsHeaders(),
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("opensearchdescription+xml");

    const xml = await res.text();
    expect(xml).toContain("OpenSearchDescription");
    expect(xml).toContain("<ShortName>Libris</ShortName>");
    expect(xml).toContain("{searchTerms}");
  });

  test("/opds/covers/[id] returns image bytes", async () => {
    const res = await fetch(`${API_BASE}/opds/covers/${prideBookId}`, {
      headers: opdsHeaders(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
    // Verify JPEG magic bytes (SOI marker: FF D8)
    const bytes = new Uint8Array(body);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  test("/opds/download/[fileId] returns EPUB file", async () => {
    const res = await fetch(`${API_BASE}/opds/download/${downloadFileId}`, {
      headers: opdsHeaders(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/epub+zip");
    expect(res.headers.get("content-disposition")).toContain("test-download.epub");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(EPUB_TEST_CONTENT.length);
  });

  test("Basic auth works for e-reader compatibility", async () => {
    // Use Basic auth (user:pass) like KOReader sends
    const res = await fetch(`${API_BASE}/opds/books?_t=${Date.now()}`, {
      headers: opdsHeaders(),
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/atom+xml");

    const xml = await res.text();
    expect(xml).toContain("Pride and Prejudice");
    expect(xml).toContain("Jane Austen");
  });

  test("unauthenticated request returns 401", async () => {
    const res = await fetch(`${API_BASE}/opds?_t=${Date.now()}`);
    expect(res.status).toBe(401);
  });

  test("Content-Type headers are correct for each endpoint", async () => {
    const headers = opdsHeaders();

    // Navigation feed
    const indexRes = await fetch(`${API_BASE}/opds?_t=${Date.now()}`, { headers });
    expect(indexRes.headers.get("content-type")).toContain(
      "application/atom+xml;profile=opds-catalog;kind=navigation",
    );

    // Acquisition feed (books list)
    const booksRes = await fetch(`${API_BASE}/opds/books?_t=${Date.now()}`, { headers });
    expect(booksRes.headers.get("content-type")).toContain(
      "application/atom+xml;profile=opds-catalog;kind=acquisition",
    );

    // New arrivals feed
    const newRes = await fetch(`${API_BASE}/opds/new?_t=${Date.now()}`, { headers });
    expect(newRes.headers.get("content-type")).toContain(
      "application/atom+xml;profile=opds-catalog;kind=acquisition",
    );

    // Single book entry
    const entryRes = await fetch(`${API_BASE}/opds/books/${prideBookId}?_t=${Date.now()}`, {
      headers,
    });
    expect(entryRes.headers.get("content-type")).toContain(
      "application/atom+xml;type=entry;profile=opds-catalog",
    );

    // OpenSearch description
    const searchDescRes = await fetch(`${API_BASE}/opds/search?_t=${Date.now()}`, { headers });
    expect(searchDescRes.headers.get("content-type")).toContain(
      "application/opensearchdescription+xml",
    );

    // Search results feed
    const searchRes = await fetch(`${API_BASE}/opds/search?q=test&_t=${Date.now()}`, { headers });
    expect(searchRes.headers.get("content-type")).toContain(
      "application/atom+xml;profile=opds-catalog;kind=acquisition",
    );
  });
});
