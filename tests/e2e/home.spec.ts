/**
 * E2E: Home dashboard and quick stats.
 *
 * Tests the dashboard page sections: Quick Stats cards, Currently Reading
 * with progress bars, Recently Added books, empty state, and book card
 * navigation to the detail page.
 *
 * Books and reading progress are seeded directly into the database because
 * /__test/seed-books is unavailable in dev mode (import.meta.test = false).
 *
 * NOTE: The authedPage fixture lands on /settings (SSR meta-refresh redirect).
 * All tests navigate to / via the sidebar "Home" link (client-side routing)
 * to avoid SSR redirect.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  getSql,
  deleteAllBooks,
  cleanInboxDir,
  seedOrganizedBook,
  getAdminUserId,
  waitForAllQueuesIdle,
} from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to the home dashboard with a fresh server render (not client-side cache). */
async function goHome(page: Page): Promise<void> {
  // Use page.goto to force a full SSR render. Client-side navigation (via sidebar link)
  // reuses the Nuxt payload cache from the initial page load, which may contain stale data.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

/** Insert a book in inbox status. Returns the book id. */
async function seedInboxBook(title?: string): Promise<string> {
  const sql = getSql();
  try {
    const [row] = await sql`
      INSERT INTO books (status, title, author)
      VALUES ('inbox', ${title ?? "Inbox Book"}, 'Some Author')
      RETURNING id
    `;
    return row.id;
  } finally {
    await sql.end();
  }
}

/**
 * Seed a book_file and reading_progress entry for a given book.
 * This makes the book appear in the "Currently Reading" section.
 */
async function seedReadingProgress(
  bookId: string,
  opts: {
    percentage: number; // 0-1 decimal
    device: string;
    timestampEpoch: number; // epoch seconds
  },
): Promise<void> {
  const sql = getSql();
  try {
    // Create a book_file with a unique content_hash
    const contentHash = `hash-${bookId}-${Date.now()}`;
    await sql`
      INSERT INTO book_files (book_id, format, original_name, content_hash)
      VALUES (${bookId}, 'epub', 'test.epub', ${contentHash})
    `;
    // Create reading progress linked via content_hash
    const ownerId = getAdminUserId();
    await sql`
      INSERT INTO reading_progress (api_key_id, document, device, progress, percentage, timestamp)
      VALUES (${ownerId}, ${contentHash}, ${opts.device}, ${String(opts.percentage)}, ${opts.percentage}, ${opts.timestampEpoch})
    `;
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Home Dashboard", { tag: "@smoke" }, () => {
  // Run serially to avoid DB race conditions between parallel workers
  test.describe.configure({ mode: "serial" });

  // ── Empty state ─────────────────────────────────────────────────

  test.describe("empty state", () => {
    test.beforeAll(async () => {
      await cleanInboxDir();
      await waitForAllQueuesIdle();
      await deleteAllBooks();
    });

    test("empty state when no books exist", async ({ authedPage: page }) => {
      // Navigate to home via client-side routing
      await goHome(page);

      // Dashboard should show empty state
      await expect(page.getByText("Your library is empty")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Add books to your inbox folder to get started")).toBeVisible();

      // Stats cards should show zeros and defaults
      await expect(page.getByTestId("stat-card-total-books").getByText("0")).toBeVisible();
      await expect(page.getByTestId("stat-card-processing").getByText("0")).toBeVisible();
      await expect(page.getByTestId("stat-card-awaiting-review").getByText("0")).toBeVisible();
    });
  });

  // ── With data ───────────────────────────────────────────────────
  //
  // Seed once: 3 organized books (2 with reading progress), 2 inbox books.
  // All tests in this block are read-only — they navigate and assert.

  test.describe("with data", () => {
    test.beforeAll(async () => {
      await cleanInboxDir();
      await waitForAllQueuesIdle();
      await deleteAllBooks();

      const now = Math.floor(Date.now() / 1000);

      // Organized books with reading progress
      const readingAlphaId = await seedOrganizedBook({
        title: "Reading Book Alpha",
        author: "Progress Author",
      });
      await seedReadingProgress(readingAlphaId, {
        percentage: 0.42,
        device: "Kindle Paperwhite",
        timestampEpoch: now,
      });

      const readingBetaId = await seedOrganizedBook({
        title: "Reading Book Beta",
        author: "Another Reader",
      });
      await seedReadingProgress(readingBetaId, {
        percentage: 0.75,
        device: "KOReader",
        timestampEpoch: now - 86400, // yesterday
      });

      // Organized book without progress
      await seedOrganizedBook({
        title: "Recent Three",
        author: "Author R3",
      });

      // Inbox books for Awaiting Review count
      await seedInboxBook("Pending Book 1");
      await seedInboxBook("Pending Book 2");
    });

    test.afterAll(async () => {
      await deleteAllBooks();
    });

    test("Quick Stats cards show correct counts", async ({ authedPage: page }) => {
      await goHome(page);

      // Total Books = 3 (organized only)
      await expect(page.getByTestId("stat-card-total-books").getByText("3")).toBeVisible({
        timeout: 10_000,
      });

      // Processing = 0 (no books currently processing)
      await expect(page.getByTestId("stat-card-processing").getByText("0")).toBeVisible();

      // Library Size — just check it's visible with a non-empty value
      const librarySizeCard = page.getByTestId("stat-card-library-size");
      const librarySizeValue = librarySizeCard.locator("p.text-2xl");
      await expect(librarySizeValue).toBeVisible();
      await expect(librarySizeValue).not.toHaveText("");

      // Awaiting Review = 2 (inbox books)
      await expect(page.getByTestId("stat-card-awaiting-review").getByText("2")).toBeVisible();
    });

    test("Currently Reading section shows books with progress bars", async ({
      authedPage: page,
    }) => {
      await goHome(page);

      // Section heading visible
      await expect(page.getByText("Currently Reading")).toBeVisible({ timeout: 10_000 });

      const readingSection = page.getByTestId("currently-reading-section");

      // Book titles and authors
      await expect(readingSection.getByText("Reading Book Alpha")).toBeVisible();
      await expect(readingSection.getByText("Progress Author")).toBeVisible();
      await expect(readingSection.getByText("Reading Book Beta")).toBeVisible();
      await expect(readingSection.getByText("Another Reader")).toBeVisible();

      // Progress percentages
      await expect(readingSection.getByText("42%")).toBeVisible();
      await expect(readingSection.getByText("75%")).toBeVisible();

      // Device names
      await expect(readingSection.getByText("Kindle Paperwhite")).toBeVisible();
      await expect(readingSection.getByText("KOReader")).toBeVisible();

      // Last read timestamps (VueUse formatTimeAgo: "just now" for today, "yesterday" for 1 day ago)
      await expect(readingSection.getByText("just now")).toBeVisible();
      await expect(readingSection.getByText("yesterday")).toBeVisible();
    });

    test("Recently Added section shows latest library books", async ({ authedPage: page }) => {
      await goHome(page);

      // Scope to "Recently Added" section — books with progress also appear in "Currently Reading"
      const recentlyAddedSection = page.getByTestId("recently-added-section");
      await expect(recentlyAddedSection).toBeVisible({ timeout: 10_000 });

      // Books visible
      await expect(recentlyAddedSection.getByText("Reading Book Alpha")).toBeVisible();
      await expect(recentlyAddedSection.getByText("Reading Book Beta")).toBeVisible();
      await expect(recentlyAddedSection.getByText("Recent Three")).toBeVisible();

      // "View all" link to library
      const viewAll = recentlyAddedSection.getByRole("link", { name: "View all" });
      await expect(viewAll).toBeVisible();
      await expect(viewAll).toHaveAttribute("href", "/library");
    });

    test("Recently Added cards stay constrained on wide screens", async ({ authedPage: page }) => {
      await page.setViewportSize({ width: 1800, height: 1200 });
      await goHome(page);

      const firstCard = page.locator('[data-testid^="recently-added-card-"]').first();
      await expect(firstCard).toBeVisible({ timeout: 10_000 });

      const box = await firstCard.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(240);
    });

    test("Awaiting Review card links to inbox", async ({ authedPage: page }) => {
      await goHome(page);

      // The Awaiting Review card is a link to /inbox
      const awaitingCard = page.getByTestId("stat-card-awaiting-review");
      await expect(awaitingCard.getByText("2")).toBeVisible({ timeout: 10_000 });

      // Click the card to navigate to inbox
      await awaitingCard.click();
      await page.waitForURL("**/inbox", { timeout: 10_000 });
    });
  });
});
