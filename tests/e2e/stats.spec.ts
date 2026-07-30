/**
 * E2E: Reading statistics page.
 *
 * Tests the /stats page sections: books finished counts, reading streak,
 * avg days to finish, daily activity chart (last 30 days), and genre
 * distribution for finished books. Also tests empty state.
 *
 * "Finished" = organized book where reading_progress.percentage >= 0.95.
 * Daily activity and streak come from reading_progress_history entries.
 *
 * Books, reading progress, and history are seeded directly into the database
 * because /__test/* routes are unavailable in dev mode.
 *
 * NOTE: The authedPage fixture lands on /settings (SSR meta-refresh redirect).
 * All tests navigate to /stats via the sidebar "Stats" link (client-side routing).
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { getSql, deleteAllBooks, seedOrganizedBook, getAdminKeyId } from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to the stats page via client-side routing (sidebar Stats link). */
async function goStats(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Stats" }).click();
  await page.waitForURL("**/stats");
}

/**
 * Create a book_file for a book and seed reading_progress with given percentage.
 * Also creates reading_progress_history entries for streak/activity calculations.
 * Returns the content hash used to link everything.
 */
async function seedFinishedBookProgress(
  bookId: string,
  opts: {
    percentage: number;
    device?: string;
    /** Dates to create history entries on (for streak/activity). Defaults to [today]. */
    historyDates?: Date[];
  },
): Promise<string> {
  const sql = getSql();
  try {
    const contentHash = `hash-${bookId}-${Date.now()}`;
    const device = opts.device ?? "TestDevice";
    const timestampEpoch = Math.floor(Date.now() / 1000);

    // Create book_file
    await sql`
      INSERT INTO book_files (book_id, format, original_name, content_hash)
      VALUES (${bookId}, 'epub', 'test.epub', ${contentHash})
    `;

    // Create reading_progress (current state)
    // Set updated_at to last history date so stats SQL uses the correct "finished" date
    const dates = opts.historyDates ?? [new Date()];
    const lastDate = dates[dates.length - 1];
    const apiKeyId = await getAdminKeyId();
    await sql`
      INSERT INTO reading_progress (api_key_id, book_id, document, device, progress, percentage, timestamp, updated_at)
      VALUES (${apiKeyId}, ${bookId}, ${contentHash}, ${device}, ${String(opts.percentage)}, ${opts.percentage}, ${timestampEpoch}, ${lastDate.toISOString()})
    `;

    // Create reading_progress_history entries
    for (const date of dates) {
      await sql`
        INSERT INTO reading_progress_history (api_key_id, book_id, document, device, progress, percentage, created_at)
        VALUES (${apiKeyId}, ${bookId}, ${contentHash}, ${device}, ${String(opts.percentage)}, ${opts.percentage}, ${date.toISOString()})
      `;
    }

    return contentHash;
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Reading Stats", { tag: "@smoke" }, () => {
  test.describe.configure({ mode: "serial" });

  // ── Empty state ─────────────────────────────────────────────────

  test.describe("empty state", () => {
    test.beforeAll(async () => {
      await deleteAllBooks();
    });

    test("empty state with no reading history", async ({ authedPage: page }) => {
      await goStats(page);

      // Top stats cards should show zeros
      await expect(page.getByText("Finished (All Time)")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("stat-value-finished-all-time")).toHaveText("0");
      await expect(page.getByTestId("stat-value-finished-this-year")).toHaveText("0");
      await expect(page.getByTestId("stat-value-finished-this-month")).toHaveText("0");

      // Streak should show 0 days
      await expect(page.getByTestId("stat-value-reading-streak")).toContainText("0");
      await expect(
        page.getByTestId("stat-card-reading-streak").getByText("Longest: 0 days"),
      ).toBeVisible();

      // Empty-state messages from the new chart layout
      const currentYear = new Date().getFullYear();
      await expect(page.getByText(`No reading activity in ${currentYear}`)).toBeVisible();
      await expect(page.getByText("No genre data for finished books")).toBeVisible();
    });
  });

  // ── With reading data ───────────────────────────────────────────
  //
  // Seed a comprehensive dataset once for all read-only tests.
  // Finished books: 4 (this month ×2, earlier this year ×1, last year ×1)
  // Unfinished: 1 (50% progress — verifies exclusion from finished stats)
  // Reading streak: 3 consecutive days (today, yesterday, 2 days ago)

  test.describe("with reading data", () => {
    test.beforeAll(async () => {
      await deleteAllBooks();

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const twoDaysAgo = new Date(today);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const earlierThisYear = new Date(now.getFullYear(), now.getMonth() - 2, 15);
      const lastYear = new Date(now.getFullYear() - 1, 6, 1);

      // Book A: finished this month
      const bookA = await seedOrganizedBook({
        title: "Finished This Month",
        genres: ["Fantasy", "Adventure"],
        pageCount: 300,
      });
      await seedFinishedBookProgress(bookA, {
        percentage: 0.98,
        historyDates: [today],
      });

      // Book B: finished earlier this year (not this month)
      const bookB = await seedOrganizedBook({
        title: "Finished Earlier Year",
        genres: ["Fantasy", "Romance"],
        pageCount: 250,
      });
      await seedFinishedBookProgress(bookB, {
        percentage: 0.96,
        historyDates: [earlierThisYear],
      });

      // Book C: finished last year
      const bookC = await seedOrganizedBook({
        title: "Finished Last Year",
        genres: ["Mystery"],
        pageCount: 200,
      });
      await seedFinishedBookProgress(bookC, {
        percentage: 0.99,
        historyDates: [lastYear],
      });

      // Book D: finished, with 3-day reading streak
      const bookD = await seedOrganizedBook({
        title: "Streak Reader",
        genres: ["Sci-Fi"],
        pageCount: 400,
      });
      await seedFinishedBookProgress(bookD, {
        percentage: 0.97,
        historyDates: [twoDaysAgo, yesterday, today],
      });

      // Book E: NOT finished (50%) — excluded from finished stats
      const bookE = await seedOrganizedBook({
        title: "Half-Read Book",
        genres: ["Horror"],
        pageCount: 200,
      });
      await seedFinishedBookProgress(bookE, {
        percentage: 0.5,
        historyDates: [today],
      });
    });

    test.afterAll(async () => {
      await deleteAllBooks();
    });

    test("books finished counts display correctly", async ({ authedPage: page }) => {
      await goStats(page);

      // All Time: 4 finished books (A, B, C, D — all ≥ 95%)
      await expect(page.getByTestId("stat-value-finished-all-time")).toHaveText("4", {
        timeout: 10_000,
      });

      // This Year: 3 (A + B + D — C is last year)
      await expect(page.getByTestId("stat-value-finished-this-year")).toHaveText("3");

      // This Month: 2 (A + D)
      await expect(page.getByTestId("stat-value-finished-this-month")).toHaveText("2");
    });

    test("reading streak shows current and longest streak", async ({ authedPage: page }) => {
      await goStats(page);

      // Book D has 3 consecutive days of history (today, yesterday, 2 days ago)
      await expect(page.getByTestId("stat-value-reading-streak")).toContainText("3", {
        timeout: 10_000,
      });

      // Longest streak should also be 3 (only continuous streak)
      await expect(
        page.getByTestId("stat-card-reading-streak").getByText("Longest: 3 days"),
      ).toBeVisible();
    });

    test("activity heatmap renders with data points", async ({ authedPage: page }) => {
      await goStats(page);

      // Section heading should be visible
      await expect(page.getByText("Pages Read", { exact: true })).toBeVisible({ timeout: 10_000 });

      // Should NOT show the per-year empty state
      const currentYear = new Date().getFullYear();
      await expect(page.getByText(`No reading activity in ${currentYear}`)).not.toBeVisible();

      // Heatmap container renders (the activity-chart testid carries over)
      await expect(page.getByTestId("activity-chart")).toBeVisible();
    });

    test("genre distribution chart renders with data points", async ({ authedPage: page }) => {
      await goStats(page);

      // Genre section heading
      await expect(page.getByText("Genres (Finished Books)")).toBeVisible({ timeout: 10_000 });

      // Should NOT show empty state
      await expect(page.getByText("No genre data for finished books")).not.toBeVisible();

      // Genres from finished books appear as legend labels in the donut.
      // Horror is excluded (Book E is unfinished at 50%).
      const chart = page.getByTestId("genre-chart");
      await expect(chart).toBeVisible();
      await expect(chart.getByText("Fantasy")).toBeVisible();
      await expect(chart.getByText("Adventure")).toBeVisible();
      await expect(chart.getByText("Sci-Fi")).toBeVisible();
      await expect(chart.getByText("Romance")).toBeVisible();
      await expect(chart.getByText("Mystery")).toBeVisible();
    });

    test("unfinished books do not count in stats", async ({ authedPage: page }) => {
      await goStats(page);

      // Book E at 50% is NOT counted as finished — All Time should be 4, not 5
      await expect(page.getByTestId("stat-value-finished-all-time")).toHaveText("4", {
        timeout: 10_000,
      });

      // Horror genre (from unfinished Book E) should NOT appear in the donut legend
      await expect(page.getByTestId("genre-chart").getByText("Horror")).not.toBeVisible();

      // But the heatmap SHOULD show data (Book E has history entries this year)
      const currentYear = new Date().getFullYear();
      await expect(page.getByText(`No reading activity in ${currentYear}`)).not.toBeVisible();
    });

    test("new chart containers all render", async ({ authedPage: page }) => {
      await goStats(page);
      for (const testid of [
        "activity-chart",
        "genre-chart",
        "finished-per-month-chart",
        "velocity-chart",
        "top-authors-chart",
        "days-to-finish-chart",
        "library-growth-chart",
      ]) {
        await expect(page.getByTestId(testid)).toBeVisible({ timeout: 10_000 });
      }
    });
  });
});
