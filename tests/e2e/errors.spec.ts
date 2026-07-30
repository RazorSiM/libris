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
import { test as baseTest } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  API_BASE,
  authHeaders,
  getSql,
  deleteAllBooks,
  waitForBookInInbox,
  goPath,
  waitForJob,
  waitForAllQueuesIdle,
} from "./helpers";

const FIXTURES_DIR = join(import.meta.dirname!, "fixtures");

/** Seed a review book with two metadata candidates so the approve button is enabled. */
async function seedReviewBookWithCandidates(
  overrides: { title?: string; author?: string } = {},
): Promise<string> {
  const sql = getSql();
  try {
    const title = overrides.title ?? "Error Test Book";
    const author = overrides.author ?? "Test Author";
    const [row] = await sql`
      INSERT INTO books (status, title, author, genres)
      VALUES ('review', ${title}, ${author}, '{}'::text[])
      RETURNING id
    `;
    const bookId = row.id as string;

    const contentHash = `hash-${bookId}-${Date.now()}`;
    await sql`
      INSERT INTO book_files (book_id, format, original_name, file_size, storage_path, content_hash)
      VALUES (${bookId}, 'epub', 'test.epub', 1048576, ${null}, ${contentHash})
    `;

    await sql`
      INSERT INTO book_metadata_candidates (book_id, source, confidence, normalized)
      VALUES (${bookId}, 'file', 0.5, ${JSON.stringify({ title, author })}::jsonb)
    `;
    await sql`
      INSERT INTO book_metadata_candidates (book_id, source, confidence, normalized)
      VALUES (${bookId}, 'hardcover', 0.9, ${JSON.stringify({
        title,
        author,
        publisher: "Test Publisher",
        description: "A test book.",
        genres: ["Testing"],
      })}::jsonb)
    `;

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
      INSERT INTO books (status, title, genres)
      VALUES ('inbox', ${overrides.title ?? "Inbox Test Book"}, '{}'::text[])
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
// Tests — Auth Error Handling (unauthenticated context)
// ---------------------------------------------------------------------------

baseTest.describe("Auth Error Handling", { tag: "@smoke" }, () => {
  // These tests verify unauthenticated flows — clear the project-level storageState
  baseTest.use({ storageState: { cookies: [], origins: [] } });

  baseTest("accessing /inbox without auth redirects to /settings", async ({ page }) => {
    await page.goto("/inbox");
    await page.waitForURL("**/settings");
  });

  baseTest("accessing /library without auth redirects to /settings", async ({ page }) => {
    await page.goto("/library");
    await page.waitForURL("**/settings");
  });

  baseTest("invalid API key: BFF rejects login and shows error", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Welcome to Libris — Set Up Your API Key")).toBeVisible({
      timeout: 10_000,
    });

    // Enter an invalid API key via manual entry
    await page.getByPlaceholder("Enter your API key").fill("invalid-key-will-not-work");
    await page.getByRole("button", { name: "Login" }).click();

    // BFF validates the key against the backend → 401 → error toast
    // User should remain on the unauthenticated setup view
    await expect(page.getByText("Welcome to Libris — Set Up Your API Key")).toBeVisible({
      timeout: 10_000,
    });

    // Authenticated tabs should NOT appear
    await expect(page.getByRole("tab", { name: "System" })).not.toBeVisible();
  });
});

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

  // Drain all queues after pipeline tests so in-flight workers don't leak data into subsequent test files
  test.afterAll(async () => {
    await waitForAllQueuesIdle();
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
