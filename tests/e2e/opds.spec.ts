/**
 * E2E coverage for OPDS responses that cross the real filesystem boundary.
 *
 * Feed structure, query behaviour, authentication, and response headers are
 * covered by services/api-hono/src/routes/opds.test.ts. These cases stay E2E
 * because a Hono test client cannot prove that paths persisted in Postgres are
 * resolved and streamed correctly by the running server.
 */

import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN } from "./helpers/accounts.js";
import { API_BASE, deleteAllBooks, getApiKey, seedBookFile, seedOrganizedBook } from "./helpers";

function opdsHeaders(): Record<string, string> {
  const encoded = Buffer.from(`${ADMIN.email}:${getApiKey()}`).toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

function getLibraryPath(): string {
  const path = process.env.LIBRIS_LIBRARY_PATH;
  if (!path) throw new Error("LIBRIS_LIBRARY_PATH not set");
  return path;
}

// Minimal valid JPEG (1x1 pixel).
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const EPUB_BYTES = Buffer.from("PK\x03\x04e2e-opds-download");

test.describe("OPDS filesystem responses", { tag: "@smoke" }, () => {
  test.describe.configure({ mode: "serial" });

  let bookId: string;
  let fileId: string;

  test.beforeAll(async () => {
    await deleteAllBooks();

    const libraryPath = getLibraryPath();
    mkdirSync(join(libraryPath, "covers"), { recursive: true });
    mkdirSync(join(libraryPath, "books"), { recursive: true });
    writeFileSync(join(libraryPath, "covers", "opds-cover.jpg"), JPEG_BYTES);
    writeFileSync(join(libraryPath, "books", "opds-download.epub"), EPUB_BYTES);

    bookId = await seedOrganizedBook({
      title: "OPDS Filesystem Test",
      author: "Libris",
      coverPath: "covers/opds-cover.jpg",
    });
    fileId = await seedBookFile(bookId, {
      format: "epub",
      originalName: "opds-download.epub",
      storagePath: "books/opds-download.epub",
      fileSize: EPUB_BYTES.length,
    });
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("streams a stored cover image", async () => {
    const response = await fetch(`${API_BASE}/opds/covers/${bookId}`, {
      headers: opdsHeaders(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  test("streams a stored ebook with download headers", async () => {
    const response = await fetch(`${API_BASE}/opds/download/${fileId}`, {
      headers: opdsHeaders(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/epub+zip");
    expect(response.headers.get("content-disposition")).toContain("opds-download.epub");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(EPUB_BYTES);
  });
});
