/**
 * E2E: Book detail — reading progress display.
 *
 * Tests the reading progress section on the book detail page `/library/[id]`.
 * Verifies progress bars, percentage text, device names, status badges,
 * empty state, and finished-book badge.
 *
 * Books and reading_progress rows are seeded directly into the database.
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

/**
 * Insert (or upsert) a reading_progress row for the given content hash.
 */
async function seedProgress(contentHash: string, device: string, percentage: number, daysAgo = 0) {
  const sql = getSql();
  const ts = Math.floor((Date.now() - daysAgo * 86400000) / 1000);
  const apiKeyId = await getAdminKeyId();
  try {
    await sql`
      INSERT INTO reading_progress (api_key_id, document, device, progress, percentage, timestamp)
      VALUES (${apiKeyId}, ${contentHash}, ${device}, ${"pos"}, ${percentage.toFixed(4)}, ${ts})
      ON CONFLICT (api_key_id, document, device) DO UPDATE SET percentage = ${percentage.toFixed(4)}, timestamp = ${ts}, updated_at = NOW()
    `;
  } finally {
    await sql.end();
  }
}

/**
 * Query the content_hash for a book file by its id.
 */
async function getContentHash(fileId: string): Promise<string> {
  const sql = getSql();
  try {
    const [row] = await sql`SELECT content_hash FROM book_files WHERE id = ${fileId}`;
    if (!row) throw new Error(`No book_file with id ${fileId}`);
    return row.content_hash;
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Book Detail — Reading Progress", { tag: "@smoke" }, () => {
  test.describe.configure({ mode: "serial" });

  let bookAId: string;
  let bookBId: string;
  let bookCId: string;

  test.beforeAll(async () => {
    await waitForAllQueuesIdle();
    await deleteAllBooks();

    // Book A — two progress entries on different devices
    bookAId = await seedOrganizedBook({ title: "Progress Book A", author: "Author A" });
    const fileAId = await seedBookFile(bookAId);
    const hashA = await getContentHash(fileAId);
    await seedProgress(hashA, "Kobo_clara", 0.452);
    await seedProgress(hashA, "KOReader_phone", 0.31);

    // Book B — has a file but NO progress entries
    bookBId = await seedOrganizedBook({ title: "Progress Book B", author: "Author B" });
    await seedBookFile(bookBId);

    // Book C — finished (97 %)
    bookCId = await seedOrganizedBook({ title: "Progress Book C", author: "Author C" });
    const fileCId = await seedBookFile(bookCId);
    const hashC = await getContentHash(fileCId);
    await seedProgress(hashC, "Kobo_clara", 0.97);

    await invalidateServerCache();
  });

  test("shows reading progress data for multiple devices", async ({ authedPage: page }) => {
    await goPath(page, `/library/${bookAId}`);

    // Section and device rows visible
    await expect(page.getByTestId("reading-progress-section")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("reading-progress-device-Kobo_clara")).toBeVisible();
    await expect(page.getByTestId("reading-progress-device-KOReader_phone")).toBeVisible();

    // Progress bars
    await expect(page.getByTestId("reading-progress-bar-Kobo_clara")).toBeVisible();
    await expect(page.getByTestId("reading-progress-bar-KOReader_phone")).toBeVisible();

    // Percentage accuracy
    await expect(page.getByTestId("reading-progress-percentage-Kobo_clara")).toHaveText("45.20%");
    await expect(page.getByTestId("reading-progress-percentage-KOReader_phone")).toHaveText(
      "31.00%",
    );

    // Device names
    await expect(page.getByText("Kobo_clara")).toBeVisible();
    await expect(page.getByText("KOReader_phone")).toBeVisible();

    // Status badges (both in-progress → "Reading")
    const badges = page.getByTestId("reading-progress-status-badge");
    await expect(badges.first()).toBeVisible();
    await expect(page.getByText("Reading").first()).toBeVisible();
  });

  test("shows empty state when no progress exists", async ({ authedPage: page }) => {
    await goPath(page, `/library/${bookBId}`);

    await expect(page.getByTestId("reading-progress-empty")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("reading-progress-empty")).toHaveText("Not started yet");
  });

  test("shows finished badge for completed book", async ({ authedPage: page }) => {
    await goPath(page, `/library/${bookCId}`);

    await expect(page.getByTestId("reading-progress-section")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("reading-progress-status-badge")).toHaveText("Finished");
  });
});
