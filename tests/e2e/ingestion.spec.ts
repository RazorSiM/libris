/**
 * E2E: Full book ingestion pipeline.
 *
 * Tests the complete flow: file drop → watcher detection → metadata parsing →
 * external metadata fetch → inbox UI → approval → library.
 *
 * Requires the API and Web dev servers to be running with:
 *   - A writable LIBRIS_INBOX_PATH directory
 *   - Redis + PostgreSQL available
 *   - Network access for external metadata APIs (Google Books, Hardcover)
 *
 * NOTE: External metadata lookups use the embedded ISBN/title from test fixtures.
 * If external APIs return no results, the book stays in "inbox" status and the
 * approval flow portion of the test is skipped (detection + parsing still verified).
 */

import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  API_BASE,
  authHeaders,
  copyToInbox,
  waitForJob,
  waitForAllQueuesIdle,
  deleteAllBooks,
  invalidateServerCache,
  waitForBookInInbox,
} from "./helpers";

const FIXTURES_DIR = join(import.meta.dirname!, "fixtures");

async function goInbox(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Inbox" }).click();
  await page.waitForURL("**/inbox");
}

async function goLibrary(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Library" }).click();
  await page.waitForURL("**/library");
}

/**
 * Fetch a single inbox book with its metadata candidates.
 */
async function getInboxBookDetail(id: string): Promise<{
  status: string;
  title: string | null;
  candidates: Array<{ source: string; normalized: Record<string, unknown> }>;
}> {
  const res = await fetch(`${API_BASE}/api/inbox/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch inbox book ${id}: ${res.status}`);
  return res.json() as Promise<{
    status: string;
    title: string | null;
    candidates: Array<{ source: string; normalized: Record<string, unknown> }>;
  }>;
}

/**
 * Fetch a library book detail with files.
 */
async function getLibraryBookDetail(id: string): Promise<{
  id: string;
  status: string;
  title: string | null;
  author: string | null;
  coverUrl: string | null;
  coverPath: string | null;
  approvedAt: string | null;
  files: Array<{ id: string; format: string; originalName: string; storagePath: string }>;
}> {
  const res = await fetch(`${API_BASE}/api/library/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch library book ${id}: ${res.status}`);
  return res.json() as Promise<{
    id: string;
    status: string;
    title: string | null;
    author: string | null;
    coverUrl: string | null;
    coverPath: string | null;
    approvedAt: string | null;
    files: Array<{ id: string; format: string; originalName: string; storagePath: string }>;
  }>;
}

/**
 * Verify cover image endpoint returns valid image data.
 */
async function verifyCoverEndpoint(bookId: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/library/${bookId}/cover`, {
    headers: authHeaders(),
  });
  if (!res.ok) return false;
  const contentType = res.headers.get("content-type") ?? "";
  return contentType.startsWith("image/");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Book Ingestion Pipeline", { tag: ["@slow", "@external"] }, () => {
  // Drain all queues after pipeline tests so in-flight workers don't leak data into subsequent test files
  test.afterAll(async () => {
    await waitForAllQueuesIdle();
  });

  test.beforeEach(async () => {
    await waitForAllQueuesIdle();
    await deleteAllBooks();
    // Clean inbox directory to ensure chokidar sees fresh "add" events
    const inboxPath = process.env.LIBRIS_INBOX_PATH;
    if (inboxPath) {
      try {
        const files = await readdir(inboxPath);
        await Promise.all(files.map((f) => unlink(join(inboxPath, f))));
      } catch {
        /* ignore if dir doesn't exist */
      }
    }
  });

  test("EPUB: detect → parse → review → approve → library", async ({ authedPage: page }) => {
    test.slow(); // Pipeline involves watcher delay + external API calls

    // ── 1. Drop EPUB into inbox ──────────────────────────────────────────────
    await copyToInbox(join(FIXTURES_DIR, "test-book.epub"));

    // ── 2. Wait for book to appear (detection + file parsing complete) ───────
    const detected = await waitForBookInInbox("The Art of Testing");
    expect(detected.title).toBe("The Art of Testing");

    // ── 3. Wait for external metadata fetch to finish ────────────────────────
    await waitForJob("book-fetch-metadata", { timeoutMs: 120_000 });

    // Re-fetch to see final status and all candidates
    const enriched = await getInboxBookDetail(detected.id);

    // File metadata candidate is always present after parsing
    expect(enriched.candidates.filter((c) => c.source === "file")).toHaveLength(1);

    // ── 4. Navigate to inbox and verify the book row ─────────────────────────
    await goInbox(page);

    const bookRow = page.getByRole("button").filter({ hasText: "The Art of Testing" });
    await expect(bookRow).toBeVisible({ timeout: 15_000 });
    await expect(bookRow.getByText("epub")).toBeVisible();

    // ── 5. Click into the review page ────────────────────────────────────────
    await bookRow.click();
    await page.waitForURL("**/inbox/**");

    // Verify book title displayed
    await expect(page.getByText("The Art of Testing").first()).toBeVisible();

    // Verify metadata source count
    await expect(page.getByText(/\d+ metadata sources? found/)).toBeVisible();

    // "File" source always shown in the metadata picker
    await expect(page.getByText("File").first()).toBeVisible();

    // ── 6. Approval flow (requires external metadata → review status) ────────
    if (enriched.status === "review") {
      // Verify review badge
      await expect(page.locator(".capitalize").filter({ hasText: "review" })).toBeVisible();

      // Verify external sources that are present
      const sourceLabels: Record<string, string> = {
        hardcover: "Hardcover",
      };
      const externalSources = enriched.candidates
        .filter((c) => c.source !== "file")
        .map((c) => c.source);

      for (const source of externalSources) {
        const label = sourceLabels[source];
        if (label) {
          await expect(page.getByText(label).first()).toBeVisible();
        }
      }

      // MetadataFieldPicker auto-selects highest-confidence values,
      // so the Approve button should already be enabled
      const approveBtn = page.getByRole("button", { name: /Approve/ });
      await expect(approveBtn).toBeEnabled();
      await approveBtn.click();

      // Should redirect back to inbox after approval
      await page.waitForURL("**/inbox", { timeout: 10_000 });

      // Wait for organize worker to move files to library
      await waitForJob("book-organize", { timeoutMs: 30_000 });

      // ── 7. Verify organized book via API ─────────────────────────────────
      const organized = await getLibraryBookDetail(detected.id);
      expect(organized.status).toBe("organized");
      expect(organized.title).toBe("The Art of Testing");
      expect(organized.approvedAt).toBeTruthy();
      expect(organized.files).toHaveLength(1);
      expect(organized.files[0].format).toBe("epub");
      expect(organized.files[0].storagePath).toBeTruthy();

      // ── 8. Verify cover image (if available) ─────────────────────────────
      const hasCover = organized.coverPath != null;
      if (hasCover) {
        const coverValid = await verifyCoverEndpoint(detected.id);
        expect(coverValid).toBe(true);
      }

      // ── 9. Verify book appears in library UI ─────────────────────────────
      await invalidateServerCache();
      await goLibrary(page);

      await expect(page.getByText("The Art of Testing")).toBeVisible();

      // If cover was downloaded, verify the <img> element renders
      if (hasCover) {
        const coverImg = page.locator(`img[src*="/api/library/${detected.id}/cover"]`);
        await expect(coverImg).toBeVisible({ timeout: 10_000 });
      }

      // ── 10. Navigate to library detail and verify ────────────────────────
      await page.getByText("The Art of Testing").first().click();
      await page.waitForURL("**/library/**");

      await expect(page.getByText("The Art of Testing").first()).toBeVisible();
      await expect(page.getByText("epub").first()).toBeVisible();

      if (hasCover) {
        const detailCover = page.locator("img[alt]").first();
        await expect(detailCover).toBeVisible();
      }
    }
  });
});
