/**
 * E2E: Reading status views.
 *
 * Tests the /reading/{status} pages: status tabs, book cards with progress,
 * navigation between statuses, book card click-to-detail, and empty states.
 *
 * Books and reading progress are seeded directly into the database because
 * /__test/seed-books is unavailable in dev mode (import.meta.test = false).
 *
 * Reading status is computed from reading_progress (percentage) and
 * reading_progress_history (last activity date):
 *   - unread:   organized book with book_file but no progress entries
 *   - reading:  percentage > 0 and < 0.95, last activity within 30 days
 *   - finished: percentage >= 0.95
 *   - paused:   percentage > 0 and < 0.95, last activity > 30 days ago
 */

import { test, expect } from "./fixtures";
import {
  getSql,
  goPath,
  deleteAllBooks,
  invalidateServerCache,
  seedOrganizedBook,
  seedBookFile,
  getAdminKeyId,
  waitForAllQueuesIdle,
} from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the content_hash for a book file by its file ID.
 */
async function getContentHash(fileId: string): Promise<string> {
  const sql = getSql();
  try {
    const [row] = await sql`
      SELECT content_hash FROM book_files WHERE id = ${fileId}
    `;
    return row.content_hash;
  } finally {
    await sql.end();
  }
}

/**
 * Seed reading_progress and reading_progress_history entries for a book file.
 * @param contentHash - The content_hash from the book_file row
 * @param device      - Device name (e.g. "KOReader")
 * @param percentage  - Progress as a 0-1 decimal
 * @param daysAgo     - How many days ago the last activity occurred (0 = now)
 */
async function seedProgress(
  bookId: string,
  contentHash: string,
  device: string,
  percentage: number,
  daysAgo = 0,
): Promise<void> {
  const sql = getSql();
  const ts = Math.floor((Date.now() - daysAgo * 86400000) / 1000);
  const createdAt = new Date(Date.now() - daysAgo * 86400000);
  const apiKeyId = await getAdminKeyId();
  try {
    await sql`
      INSERT INTO reading_progress (api_key_id, book_id, document, device, progress, percentage, timestamp)
      VALUES (${apiKeyId}, ${bookId}, ${contentHash}, ${device}, ${"position-data"}, ${percentage.toFixed(4)}, ${ts})
      ON CONFLICT (api_key_id, document, device) DO UPDATE SET book_id = ${bookId}, percentage = ${percentage.toFixed(4)}, timestamp = ${ts}
    `;
    await sql`
      INSERT INTO reading_progress_history (api_key_id, book_id, document, device, progress, percentage, timestamp, created_at)
      VALUES (
        ${apiKeyId}, ${bookId}, ${contentHash}, ${device}, ${"position-data"}, ${percentage.toFixed(4)}, ${ts},
        ${createdAt}
      )
    `;
  } finally {
    await sql.end();
  }
}

/**
 * Seed a complete book with a book file and optional reading progress.
 * Returns the book ID.
 */
async function seedBookWithProgress(opts: {
  title: string;
  author?: string;
  percentage?: number;
  device?: string;
  daysAgo?: number;
}): Promise<string> {
  const bookId = await seedOrganizedBook({
    title: opts.title,
    author: opts.author ?? "Test Author",
  });
  const fileId = await seedBookFile(bookId);
  if (opts.percentage != null && opts.percentage > 0) {
    const contentHash = await getContentHash(fileId);
    await seedProgress(
      bookId,
      contentHash,
      opts.device ?? "KOReader",
      opts.percentage,
      opts.daysAgo ?? 0,
    );
  }
  return bookId;
}

/**
 * Seed the full set of books covering all four reading statuses.
 */
async function seedAllStatuses(): Promise<void> {
  await seedBookWithProgress({
    title: "Reading Alpha",
    author: "Author A",
    percentage: 0.3,
    daysAgo: 1,
  });
  await seedBookWithProgress({
    title: "Reading Beta",
    author: "Author B",
    percentage: 0.6,
    daysAgo: 2,
  });
  await seedBookWithProgress({
    title: "Finished Alpha",
    author: "Author C",
    percentage: 0.98,
    daysAgo: 5,
  });
  await seedBookWithProgress({
    title: "Finished Beta",
    author: "Author D",
    percentage: 1.0,
    daysAgo: 10,
  });
  // Unread = organized books with book_files but NO reading progress entries
  await seedBookWithProgress({ title: "Unread Alpha", author: "Author E" });
  await seedBookWithProgress({ title: "Unread Beta", author: "Author F" });
  // Paused = progress > 0 but last activity > 30 days ago
  await seedBookWithProgress({
    title: "Paused Alpha",
    author: "Author G",
    percentage: 0.4,
    daysAgo: 45,
  });
  await invalidateServerCache();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Reading Status Views", { tag: "@smoke" }, () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await waitForAllQueuesIdle();
    await deleteAllBooks();
    await seedAllStatuses();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  // ── Sidebar ─────────────────────────────────────────────────────

  test("sidebar shows reading status links", async ({ authedPage: page }) => {
    // The sidebar renders a Reading section with links to each status
    const sidebar = page.getByTestId("sidebar-reading");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
    await expect(sidebar.getByRole("link", { name: "Reading" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Finished" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Unread" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Paused" })).toBeVisible();
  });

  // ── Status tabs ─────────────────────────────────────────────────

  test("status tabs are rendered on reading page", async ({ authedPage: page }) => {
    await goPath(page, "/reading/reading");

    await expect(page.getByTestId("status-tab-reading")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("status-tab-finished")).toBeVisible();
    await expect(page.getByTestId("status-tab-unread")).toBeVisible();
    await expect(page.getByTestId("status-tab-paused")).toBeVisible();
  });

  // ── Status tab content ──────────────────────────────────────────

  const statusCases = [
    {
      status: "reading",
      path: "/reading/reading",
      books: ["Reading Alpha", "Reading Beta"],
      percentages: ["30%", "60%"],
      notBooks: ["Finished Alpha", "Unread Alpha", "Paused Alpha"],
    },
    {
      status: "finished",
      path: "/reading/finished",
      books: ["Finished Alpha", "Finished Beta"],
      percentages: ["98%", "100%"],
      notBooks: ["Reading Alpha", "Unread Alpha"],
    },
    {
      status: "unread",
      path: "/reading/unread",
      books: ["Unread Alpha", "Unread Beta"],
      percentages: [],
      notBooks: ["Reading Alpha", "Finished Alpha"],
    },
    {
      status: "paused",
      path: "/reading/paused",
      books: ["Paused Alpha"],
      percentages: ["40%"],
      notBooks: ["Reading Alpha", "Finished Alpha", "Unread Alpha"],
    },
  ] as const;

  for (const { status, path, books, percentages, notBooks } of statusCases) {
    test(`${status} tab shows correct books`, async ({ authedPage: page }) => {
      await goPath(page, path);

      for (const book of books) {
        await expect(page.getByText(book)).toBeVisible({ timeout: 10_000 });
      }
      for (const pct of percentages) {
        await expect(page.getByText(pct)).toBeVisible();
      }
      for (const book of notBooks) {
        await expect(page.getByText(book)).not.toBeVisible();
      }
    });
  }

  // ── Empty state ─────────────────────────────────────────────────

  test("empty state shown when no books match status", async ({ authedPage: page }) => {
    // Delete all books and re-seed only reading books so other tabs are empty
    await deleteAllBooks();

    await seedBookWithProgress({ title: "Only Reading Book", percentage: 0.5, daysAgo: 1 });
    await invalidateServerCache();

    // Navigate to finished tab — should be empty
    await goPath(page, "/reading/finished");
    await expect(page.getByText("No finished books yet")).toBeVisible({ timeout: 10_000 });

    // Navigate to paused tab — should be empty
    await goPath(page, "/reading/paused");
    await expect(page.getByText("No paused books")).toBeVisible({ timeout: 10_000 });

    // Re-seed all statuses for any tests that follow
    await deleteAllBooks();
    await seedAllStatuses();
  });

  // ── Grid sizing ────────────────────────────────────────────────

  test("grid cards stay constrained on wide screens", async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 1800, height: 1200 });
    await goPath(page, "/reading/reading");

    const firstCard = page.locator('[data-testid^="book-card-"]').first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });

    const box = await firstCard.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(240);
  });
});
