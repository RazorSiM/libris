/**
 * E2E: Error handling and edge cases.
 *
 * Tests invalid API key behavior, unauthenticated redirects, 409 conflict
 * on approve, delete from inbox, duplicate file detection, network error
 * recovery, and error toast visibility.
 */

import type { Page } from "@playwright/test";
import { copyFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import {
  API_BASE,
  authHeaders,
  getAdminUserId,
  getSql,
  deleteAllBooks,
  waitForBookInInbox,
  goPath,
  seedMetadataCandidate,
  waitForJob,
  waitForAllQueuesIdle,
} from "./helpers";

const FIXTURES_DIR = join(import.meta.dirname!, "fixtures");

/**
 * `awaitWriteFinish.stabilityThreshold` in shared/inbox-watcher.ts — how long a
 * file must sit unchanged before chokidar reports it. Nothing about a dropped
 * file is observable before this elapses.
 */
const WATCHER_STABILITY_MS = 2_000;

/** Seed a review book with two metadata candidates so the approve button is enabled. */
async function seedReviewBookWithCandidates(
  overrides: { title?: string; author?: string } = {},
): Promise<string> {
  const sql = getSql();
  try {
    const title = overrides.title ?? "Error Test Book";
    const author = overrides.author ?? "Test Author";
    const [row] = await sql`
      INSERT INTO books (status, title, author, genres, created_by)
      VALUES ('review', ${title}, ${author}, '{}'::text[], ${getAdminUserId()})
      RETURNING id
    `;
    const bookId = row.id as string;

    const contentHash = `hash-${bookId}-${Date.now()}`;
    await sql`
      INSERT INTO book_files (book_id, format, original_name, file_size, storage_path, content_hash)
      VALUES (${bookId}, 'epub', 'test.epub', 1048576, ${null}, ${contentHash})
    `;

    await seedMetadataCandidate(bookId, "file", 0.5, { title, author });
    await seedMetadataCandidate(bookId, "hardcover", 0.9, {
      title,
      author,
      publisher: "Test Publisher",
      description: "A test book.",
      genres: ["Testing"],
    });

    return bookId;
  } finally {
    await sql.end();
  }
}

/** Seed a book in inbox status with a file but no candidates. */
async function seedInboxBook(overrides: { title?: string } = {}): Promise<string> {
  const sql = getSql();
  try {
    const [row] = await sql`
      INSERT INTO books (status, title, genres, created_by)
      VALUES ('inbox', ${overrides.title ?? "Inbox Test Book"}, '{}'::text[], ${getAdminUserId()})
      RETURNING id
    `;
    const bookId = row.id as string;
    const contentHash = `hash-${bookId}-${Date.now()}`;
    await sql`
      INSERT INTO book_files (book_id, format, original_name, file_size, storage_path, content_hash)
      VALUES (${bookId}, 'epub', 'test.epub', 1048576, ${null}, ${contentHash})
    `;
    return bookId;
  } finally {
    await sql.end();
  }
}

/** Navigate to inbox via sidebar link (avoids SSR redirect). */
async function goInbox(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Inbox" }).click();
  await page.waitForURL("**/inbox");
}

/** Copy a fixture file to the inbox directory with a custom destination name. */
async function copyToInboxAs(fixturePath: string, destName: string): Promise<string> {
  const inboxPath = process.env.LIBRIS_INBOX_PATH;
  if (!inboxPath) throw new Error("LIBRIS_INBOX_PATH not set");
  await mkdir(inboxPath, { recursive: true });
  const dest = join(inboxPath, destName);
  await copyFile(fixturePath, dest);
  return dest;
}

/** Remove all files from the inbox directory (prevents stale chokidar events). */
async function cleanInboxDir(): Promise<void> {
  const inboxPath = process.env.LIBRIS_INBOX_PATH;
  if (!inboxPath) return;
  try {
    const entries = await readdir(inboxPath);
    await Promise.all(entries.map((f) => unlink(join(inboxPath, f)).catch(() => {})));
  } catch {
    // Directory may not exist yet
  }
}

/** Count books currently in inbox via API. */
async function countInboxBooks(): Promise<number> {
  const res = await fetch(`${API_BASE}/api/inbox?limit=100&_t=${Date.now()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) return 0;
  const { data } = (await res.json()) as { data: Array<unknown> };
  return data.length;
}

// ---------------------------------------------------------------------------
// Auth error handling lives in auth.spec.ts
// ---------------------------------------------------------------------------
//
// Three tests were here and all three described the old model: an
// unauthenticated visitor was bounced to /settings, and signing in meant
// pasting an API key into a "Welcome to Libris — Set Up Your API Key" screen.
// The target is /login now and the credential is an email and a password.
//
// auth.spec.ts covers the replacements and covers them better — "sends an
// anonymous visitor to /login", "returns the user to the page they asked for"
// (which the old redirect tests never checked), and "rejects a wrong password
// without confirming the account exists".
//
// ---------------------------------------------------------------------------
// Tests — Error Toasts & Edge Cases (authenticated context)
// ---------------------------------------------------------------------------

test.describe("Error Toasts & Edge Cases", { tag: "@smoke" }, () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async () => {
    await waitForAllQueuesIdle();
    await deleteAllBooks();
  });

  test("approving already-organized book shows error toast (409 conflict)", async ({
    authedPage: page,
  }) => {
    const bookId = await seedReviewBookWithCandidates({ title: "Conflict Test Book" });

    await goInbox(page);
    await goPath(page, `/inbox/${bookId}`);

    // Wait for metadata picker to auto-select fields
    await expect(page.getByText("Select Metadata")).toBeVisible({ timeout: 10_000 });
    const approveBtn = page.getByTestId("approve-btn");
    await expect(approveBtn).toBeEnabled();

    // Intercept the next approve request to return 409 (simulates concurrent approval)
    await page.route(`**/api/books/${bookId}/approve`, async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Book is in 'organized' status, expected 'review'" }),
      });
    });

    // Click Approve in UI — intercepted API returns 409
    await approveBtn.click();

    // Error toast should be visible — shows the API's error message (409: book is no longer in review status)
    await expect(page.getByText(/organized.*expected.*review|Book is in/i).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("deleting a book from inbox shows success toast and redirects", async ({
    authedPage: page,
  }) => {
    const bookId = await seedReviewBookWithCandidates({ title: "Delete Toast Book" });

    await goInbox(page);
    await goPath(page, `/inbox/${bookId}`);
    await expect(page.getByText("Delete Toast Book").first()).toBeVisible({ timeout: 10_000 });

    // Click delete button
    const deleteBtn = page.getByTestId("delete-btn");
    await deleteBtn.click();

    // Confirm deletion in the ConfirmDialog (UModal may not expose role="dialog")
    await expect(page.getByText("Delete Book")).toBeVisible({ timeout: 5_000 });
    // Use exact match to click the modal's "Delete" confirm button, not the trigger
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    // Success toast
    await expect(page.getByText("Book deleted").first()).toBeVisible({ timeout: 5_000 });

    // Redirects to inbox list
    await page.waitForURL("**/inbox", { timeout: 10_000 });

    // Verify book gone via API
    const apiRes = await fetch(`${API_BASE}/api/inbox/${bookId}`, { headers: authHeaders() });
    expect(apiRes.status).toBe(404);
  });

  test("network error on delete shows error toast and book persists", async ({
    authedPage: page,
  }) => {
    const bookId = await seedInboxBook({ title: "Network Err Delete" });

    await goInbox(page);
    await goPath(page, `/inbox/${bookId}`);
    await expect(page.getByText("Network Err Delete").first()).toBeVisible({ timeout: 10_000 });

    // Intercept DELETE request to simulate server error
    await page.route(`**/api/books/${bookId}`, async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 500, body: "Internal Server Error" });
      } else {
        await route.continue();
      }
    });

    const deleteBtn = page.getByTestId("delete-btn");
    await deleteBtn.click();

    // Confirm deletion in the ConfirmDialog (UModal may not expose role="dialog")
    await expect(page.getByText("Delete Book")).toBeVisible({ timeout: 5_000 });
    // Use exact match to click the modal's "Delete" confirm button, not the trigger
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    // Error toast
    await expect(page.getByText("Internal Server Error").first()).toBeVisible({ timeout: 5_000 });

    // Should stay on review page (no redirect)
    await expect(page).toHaveURL(new RegExp(`/inbox/${bookId}`));

    // Book still exists via real API
    await page.unroute(`**/api/books/${bookId}`);
    const apiRes = await fetch(`${API_BASE}/api/inbox/${bookId}`, { headers: authHeaders() });
    expect(apiRes.status).toBe(200);
  });

  test("network error on approve shows error toast", async ({ authedPage: page }) => {
    const bookId = await seedReviewBookWithCandidates({ title: "Network Err Approve" });

    await goInbox(page);
    await goPath(page, `/inbox/${bookId}`);
    await expect(page.getByText("Select Metadata")).toBeVisible({ timeout: 10_000 });
    const approveBtn = page.getByTestId("approve-btn");
    await expect(approveBtn).toBeEnabled();

    // Intercept approve API to simulate server error
    await page.route(`**/api/books/${bookId}/approve`, async (route) => {
      await route.fulfill({ status: 500, body: "Internal Server Error" });
    });

    await approveBtn.click();

    // Error toast (use .first() — toast text appears in both alert wrapper and toast body)
    await expect(page.getByText("Internal Server Error").first()).toBeVisible({ timeout: 5_000 });

    await page.unroute(`**/api/books/${bookId}/approve`);
  });
});

// ---------------------------------------------------------------------------
// Tests — Duplicate File Detection
// ---------------------------------------------------------------------------

test.describe("Duplicate File Detection", { tag: ["@slow", "@external"] }, () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async () => {
    await waitForAllQueuesIdle();
    await deleteAllBooks();
    await cleanInboxDir();
  });

  /**
   * Leave nothing behind that the watcher can still act on.
   *
   * These files were dropped into the inbox by hand, so they have no
   * `upload_registry` row and the book-detected worker never removes them
   * itself (see `discardRedundantUpload`) — the previous teardown drained the
   * queues but left both copies on disk. Delete first, then drain, then undo
   * anything a job that was already in flight managed to create.
   */
  test.afterAll(async () => {
    await cleanInboxDir();
    await waitForAllQueuesIdle();
    await deleteAllBooks();
  });

  test("dropping same file twice results in only one inbox entry", async ({ authedPage: page }) => {
    test.slow(); // Pipeline involves watcher + worker delays
    const epubPath = join(FIXTURES_DIR, "test-book.epub");

    // Copy first file to inbox
    await copyToInboxAs(epubPath, "dup-test-first.epub");

    // Wait for book to appear (detection + parsing complete)
    await waitForBookInInbox("The Art of Testing");

    // Copy same file content with a different name
    await copyToInboxAs(epubPath, "dup-test-second.epub");

    // Let the watcher notice it before asking whether its queue is idle.
    //
    // chokidar only emits `add` once a file has been stable for
    // `awaitWriteFinish.stabilityThreshold` — 2s, see shared/inbox-watcher.ts.
    // For those 2s book-detected is idle for reasons that have nothing to do
    // with this file, so `waitForJob` returns at once and the assertion below
    // checks deduplication BEFORE deduplication has been attempted: it cannot
    // fail. Worse, the job then ran during the next spec file, after its
    // `deleteAllBooks()` had removed the book whose checksum it would have
    // matched — so the "duplicate" was ingested as a new book and broke
    // inbox.spec.ts's empty-inbox test.
    await page.waitForTimeout(WATCHER_STABILITY_MS + 3_000);

    // Wait for book-detected queue to finish processing the duplicate
    await waitForJob("book-detected", { timeoutMs: 60_000 });

    // Only one book should exist in inbox
    const count = await countInboxBooks();
    expect(count).toBe(1);

    // Verify in UI — single row with the book title
    await goInbox(page);
    await expect(page.getByText("The Art of Testing")).toBeVisible({ timeout: 10_000 });
    const rows = page.getByRole("button").filter({ hasText: "The Art of Testing" });
    await expect(rows).toHaveCount(1);
  });
});
