/**
 * E2E: Inbox list, search, and review page.
 *
 * Tests the inbox page: list with titles/formats/status badges,
 * search filtering, pagination, review page metadata picker,
 * manual entry, source selection, approve button count, and empty state.
 *
 * Books are seeded directly into the database (inbox/review status) with
 * metadata candidates because /__test/seed-books is unavailable in dev mode.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  API_BASE,
  authHeaders,
  getAdminUserId,
  getSql,
  deleteAllBooks,
  seedBookFile,
  seedMetadataCandidate,
  goPath,
  waitForAllQueuesIdle,
} from "./helpers";
import { ADMIN } from "./helpers/accounts.js";

/** Insert a book in review status with metadata candidates. Returns the book id. */
async function seedReviewBook(
  overrides: {
    title?: string;
    author?: string;
    description?: string;
    genres?: string[];
  } = {},
): Promise<string> {
  const sql = getSql();
  try {
    const genres = overrides.genres ?? [];
    const genresLiteral = `{${genres.map((g) => `"${g}"`).join(",")}}`;
    const [row] = await sql`
      INSERT INTO books (
        status, title, author, description, genres, created_by
      )
      VALUES (
        'review',
        ${overrides.title ?? "Test Review Book"},
        ${overrides.author ?? "Test Author"},
        ${overrides.description ?? null},
        ${genresLiteral}::text[],
        ${getAdminUserId()}
      )
      RETURNING id
    `;
    return row.id;
  } finally {
    await sql.end();
  }
}

/** Insert a book in inbox status (no metadata yet). Returns the book id. */
async function seedInboxBook(overrides: { title?: string; author?: string } = {}): Promise<string> {
  const sql = getSql();
  try {
    const [row] = await sql`
      INSERT INTO books (status, title, author, genres, created_by)
      VALUES (
        'inbox',
        ${overrides.title ?? "Inbox Book"},
        ${overrides.author ?? null},
        '{}'::text[],
        ${getAdminUserId()}
      )
      RETURNING id
    `;
    return row.id;
  } finally {
    await sql.end();
  }
}

/**
 * Seed metadata candidates for a book. Each candidate is a source with normalized metadata.
 * The confidence is used to determine auto-selection priority.
 *
 * Delegates to the shared helper — writing the jsonb column by hand is how this
 * file spent a long time storing a jsonb string instead of a jsonb object.
 */
const seedCandidate = seedMetadataCandidate;

/** Navigate to inbox — uses goPath for a full SSR render (avoids client-side cache issues). */
async function goInbox(page: Page): Promise<void> {
  await goPath(page, "/inbox");
}

// All inbox tests run serially — they share the same database
test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// Tests — Inbox List
// ---------------------------------------------------------------------------

test.describe("Inbox List", { tag: "@smoke" }, () => {
  // ── Empty state ─────────────────────────────────────────────────

  test.describe("empty state", () => {
    test.beforeAll(async () => {
      await deleteAllBooks();
    });

    test("empty inbox shows placeholder message", async ({ authedPage: page }) => {
      await goInbox(page);

      await expect(page.getByText("No books in inbox")).toBeVisible({ timeout: 10_000 });
    });
  });

  // ── List, search, and navigation ────────────────────────────────
  //
  // Seed once: 3 review books (with files) + 1 inbox book. All tests are read-only.

  test.describe("list and search", () => {
    let clickableBookId: string;
    let uploaderBookId: string;
    let uploaderLabel = "";

    test.beforeAll(async () => {
      await deleteAllBooks();

      // Was the label of the isAdmin key from /api/auth/keys, back when a key
      // was a person. The byline shows the USER's name now, and app passwords
      // carry no role at all — so there is nothing to look up.
      uploaderLabel = ADMIN.name;

      // Review books with files (for status badges, format column, search)
      const reviewId = await seedReviewBook({ title: "Review Alpha", author: "Author A" });
      await seedBookFile(reviewId, { format: "epub", originalName: "alpha.epub" });

      const inboxId = await seedInboxBook({ title: "Inbox Beta" });
      await seedBookFile(inboxId, { format: "pdf", originalName: "beta.pdf" });

      const reviewId2 = await seedReviewBook({ title: "Review Gamma", author: "Author C" });
      await seedBookFile(reviewId2, { format: "mobi", originalName: "gamma.mobi" });

      // Search-specific books (also review status so they appear in inbox)
      const qp = await seedReviewBook({ title: "Quantum Physics Explained" });
      await seedBookFile(qp);
      await seedReviewBook({ title: "History of Rome" });
      const qc = await seedReviewBook({ title: "Quantum Computing Basics" });
      await seedBookFile(qc);

      // Clickable book for navigation test
      clickableBookId = await seedReviewBook({ title: "Clickable Inbox Book" });
      await seedBookFile(clickableBookId);

      uploaderBookId = await seedReviewBook({
        title: "Uploader Inbox Book",
        author: "Uploader Author",
      });
      await seedBookFile(uploaderBookId, { format: "epub", originalName: "uploader.epub" });

      const sql = getSql();
      try {
        await sql`
          UPDATE books
          SET created_by = ${getAdminUserId()}
          WHERE id = ${uploaderBookId}
        `;
      } finally {
        await sql.end();
      }
    });

    test("inbox list shows books with correct titles, formats, and status badges", async ({
      authedPage: page,
    }) => {
      await goInbox(page);

      // Verify books appear
      await expect(page.getByText("Review Alpha")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Inbox Beta")).toBeVisible();
      await expect(page.getByText("Review Gamma")).toBeVisible();

      // Verify format column values (uppercase display)
      await expect(page.getByText("epub").first()).toBeVisible();
      await expect(page.getByText("pdf").first()).toBeVisible();
      await expect(page.getByText("mobi")).toBeVisible();

      // Verify status badges — "review" books get info badge, "inbox" gets neutral
      const reviewRow = page.getByRole("button").filter({ hasText: "Review Alpha" });
      await expect(
        reviewRow.getByTestId("status-badge").filter({ hasText: "review" }),
      ).toBeVisible();

      const inboxRow = page.getByRole("button").filter({ hasText: "Inbox Beta" });
      await expect(inboxRow.getByTestId("status-badge").filter({ hasText: "inbox" })).toBeVisible();

      // Verify table headers
      await expect(page.getByText("Title").first()).toBeVisible();
      await expect(page.getByText("Format").first()).toBeVisible();
      await expect(page.getByText("Status").first()).toBeVisible();
      await expect(page.getByText("Detected").first()).toBeVisible();
    });

    test("search filters books by title", async ({ authedPage: page }) => {
      await goInbox(page);
      await expect(page.getByText("Quantum Physics Explained")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("History of Rome")).toBeVisible();

      // Search for "Quantum"
      const searchInput = page.getByPlaceholder("Search books...");
      await searchInput.fill("Quantum");

      // Should filter to only matching books (search is server-side; wait for API round-trip)
      await expect(page.getByText("History of Rome")).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Quantum Physics Explained")).toBeVisible();
      await expect(page.getByText("Quantum Computing Basics")).toBeVisible();
    });

    test("click book row navigates to review page", async ({ authedPage: page }) => {
      await goInbox(page);
      await expect(page.getByText("Clickable Inbox Book")).toBeVisible({ timeout: 10_000 });

      // Click the book row
      await page.getByText("Clickable Inbox Book").click();

      // Should navigate to review page
      await page.waitForURL(`**/inbox/${clickableBookId}`, { timeout: 10_000 });
    });

    test("inbox list and detail show uploader label", async ({ authedPage: page }) => {
      await goInbox(page);
      await expect(page.getByText("Uploader Inbox Book")).toBeVisible({ timeout: 10_000 });

      // Scoped to this book's row: every book has an owner, so the byline is on
      // every row and an unscoped getByText matches the whole list.
      const row = page.getByRole("button").filter({ hasText: "Uploader Inbox Book" });
      await expect(row.getByText(`Uploaded by ${uploaderLabel}`)).toBeVisible();

      await page.getByText("Uploader Inbox Book").click();
      await page.waitForURL(`**/inbox/${uploaderBookId}`, { timeout: 10_000 });
      await expect(page.getByTestId("book-uploader")).toContainText(uploaderLabel);
    });
  });

  // ── Pagination ──────────────────────────────────────────────────

  test.describe("pagination", () => {
    test.beforeAll(async () => {
      await deleteAllBooks();

      // Seed 25 books (page limit is 20)
      const promises: Promise<string>[] = [];
      for (let i = 1; i <= 25; i++) {
        promises.push(
          (async () => {
            const bookId = await seedReviewBook({
              title: `Paginated Inbox ${String(i).padStart(2, "0")}`,
            });
            await seedBookFile(bookId);
            return bookId;
          })(),
        );
      }
      await Promise.all(promises);
    });

    test("pagination appears with many books", async ({ authedPage: page }) => {
      await goInbox(page);

      // Wait for books to appear
      await expect(page.getByText("Paginated Inbox", { exact: false }).first()).toBeVisible({
        timeout: 10_000,
      });

      // Pagination should be visible (totalPages > 1)
      const pagination = page
        .getByRole("navigation")
        .filter({ has: page.getByRole("button", { name: "Page 2" }) });
      await expect(pagination).toBeVisible();

      // Click page 2
      await page.getByRole("button", { name: "Page 2" }).click();

      // Page 2 should have only the remaining 5 books
      await expect(page.getByText("Paginated Inbox", { exact: false }).first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Paginated Inbox", { exact: false })).toHaveCount(5);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Review Page
// ---------------------------------------------------------------------------

test.describe("Review Page", { tag: "@smoke" }, () => {
  // ── Read-only review page tests ─────────────────────────────────
  //
  // Seed a set of review books with metadata candidates once.
  // Tests verify metadata display, picker, field selection — all read-only.

  test.describe("metadata display and selection", () => {
    let detailBookId: string;
    let pickerBookId: string;
    let autoSelectBookId: string;
    let manualBookId: string;
    let switchBookId: string;
    let inboxStatusBookId: string;
    let coverBookId: string;
    let breadcrumbBookId: string;

    test.beforeAll(async () => {
      await deleteAllBooks();

      // Book: Review Detail — displays info, file details, source count
      detailBookId = await seedReviewBook({
        title: "Review Detail Book",
        author: "Detail Author",
      });
      await seedBookFile(detailBookId, { format: "epub", originalName: "detail-book.epub" });
      await seedCandidate(detailBookId, "file", 0.5, {
        title: "Review Detail Book",
        author: "Detail Author",
      });
      await seedCandidate(detailBookId, "hardcover", 0.85, {
        title: "Review Detail Book",
        author: "Detail Author",
        publisher: "Great Publisher",
        publishedYear: 2024,
        description: "A great book about testing.",
      });

      // Book: Field Picker — shows all 11 fields with radio buttons
      pickerBookId = await seedReviewBook({ title: "Field Picker Book" });
      await seedBookFile(pickerBookId);
      await seedCandidate(pickerBookId, "file", 0.5, {
        title: "Field Picker Book",
        author: "File Author",
        language: "en",
      });
      await seedCandidate(pickerBookId, "hardcover", 0.9, {
        title: "Field Picker Book - Extended",
        author: "Hardcover Author",
        publisher: "Big Publisher",
        publishedYear: 2023,
        isbn10: "1234567890",
        isbn13: "9781234567890",
        language: "en",
        description: "A comprehensive guide to field picking.",
        pageCount: 350,
        genres: ["Technology", "Programming"],
        coverUrl: "https://example.com/cover.jpg",
      });

      // Book: Auto Select — auto-selects highest confidence
      autoSelectBookId = await seedReviewBook({ title: "Auto Select Book" });
      await seedBookFile(autoSelectBookId);
      await seedCandidate(autoSelectBookId, "file", 0.3, {
        title: "Auto Select Book",
        author: "File Author",
      });
      await seedCandidate(autoSelectBookId, "hardcover", 0.85, {
        title: "Auto Select Book - Enhanced",
        author: "Hardcover Author",
        publisher: "Top Publisher",
        description: "A test description.",
        genres: ["Fiction"],
      });

      // Book: Manual Entry — only file candidate, some fields unset
      manualBookId = await seedReviewBook({ title: "Manual Entry Book" });
      await seedBookFile(manualBookId);
      await seedCandidate(manualBookId, "file", 0.5, {
        title: "Manual Entry Book",
      });

      // Book: Source Switch — two candidates for comparison
      switchBookId = await seedReviewBook({ title: "Source Switch Book" });
      await seedBookFile(switchBookId);
      await seedCandidate(switchBookId, "file", 0.4, {
        title: "Source Switch Book",
        author: "File Author",
      });
      await seedCandidate(switchBookId, "hardcover", 0.9, {
        title: "Source Switch Book - Enhanced",
        author: "Hardcover Author",
      });

      // Book: Inbox Status — approve button should be disabled
      inboxStatusBookId = await seedInboxBook({ title: "Inbox Status Book" });
      await seedBookFile(inboxStatusBookId);

      // Book: Cover Preview — external URL cover rendering
      coverBookId = await seedReviewBook({ title: "Cover Preview Book" });
      await seedBookFile(coverBookId);
      await seedCandidate(coverBookId, "file", 0.4, {
        title: "Cover Preview Book",
        coverUrl: "cover.jpg",
      });
      await seedCandidate(coverBookId, "hardcover", 0.9, {
        title: "Cover Preview Book",
        coverUrl: "https://hardcover.app/images/covers/99999.jpg",
      });

      // Book: Breadcrumb navigation
      breadcrumbBookId = await seedReviewBook({ title: "Back Nav Inbox Book" });
      await seedBookFile(breadcrumbBookId);
      await seedCandidate(breadcrumbBookId, "file", 0.5, { title: "Back Nav Inbox Book" });
    });

    test("displays book info, file details, and metadata source count", async ({
      authedPage: page,
    }) => {
      await goPath(page, `/inbox/${detailBookId}`);

      // Book title in header
      await expect(page.getByText("Review Detail Book").first()).toBeVisible({ timeout: 10_000 });

      // Author displayed
      await expect(page.getByText("Detail Author").first()).toBeVisible();

      // Status badge
      await expect(page.getByTestId("status-badge").filter({ hasText: "review" })).toBeVisible();

      // File info
      await expect(page.getByText("detail-book.epub")).toBeVisible();
      await expect(page.getByText("epub", { exact: false }).first()).toBeVisible();

      // Metadata source count
      await expect(page.getByText("2 metadata sources found")).toBeVisible();
    });

    test("metadata picker shows all 11 fields with radio buttons per source", async ({
      authedPage: page,
    }) => {
      await goPath(page, `/inbox/${pickerBookId}`);

      await expect(page.getByText("Select Metadata")).toBeVisible({ timeout: 10_000 });

      // Verify all 11 field labels are present
      const fieldLabels = [
        "Title",
        "Author",
        "Publisher",
        "Year",
        "ISBN-10",
        "ISBN-13",
        "Language",
        "Description",
        "Pages",
        "Genres",
        "Cover",
      ];
      for (const label of fieldLabels) {
        await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
      }

      // Source labels should appear for fields that have values
      await expect(page.getByText("File").first()).toBeVisible();
      await expect(page.getByText("Hardcover").first()).toBeVisible();

      // Confidence percentages should be displayed
      await expect(page.getByText("(50%)").first()).toBeVisible();
      await expect(page.getByText("(90%)").first()).toBeVisible();

      // Manual option should be available for each field
      const manualLabels = page.getByText("Manual");
      expect(await manualLabels.count()).toBeGreaterThanOrEqual(11);

      // Radio buttons should be present (one per source per field + manual)
      const radios = page.locator('input[type="radio"]');
      expect(await radios.count()).toBeGreaterThanOrEqual(11);
    });

    test("auto-selects highest confidence source and approve button shows field count", async ({
      authedPage: page,
    }) => {
      await goPath(page, `/inbox/${autoSelectBookId}`);

      await expect(page.getByText("Select Metadata")).toBeVisible({ timeout: 10_000 });

      const approveBtn = page.getByTestId("approve-btn");
      await expect(approveBtn).toBeEnabled();

      // The button label includes the field count: "Approve (N)"
      const btnText = await approveBtn.textContent();
      const match = btnText?.match(/Approve \((\d+)\)/);
      expect(match).not.toBeNull();
      const fieldCount = Number(match![1]);
      expect(fieldCount).toBeGreaterThanOrEqual(5);
    });

    test("manual entry updates selection and approve count", async ({ authedPage: page }) => {
      await goPath(page, `/inbox/${manualBookId}`);

      await expect(page.getByText("Select Metadata")).toBeVisible({ timeout: 10_000 });

      // Get initial approve count
      const approveBtn = page.getByTestId("approve-btn");
      const initialText = await approveBtn.textContent();
      const initialMatch = initialText?.match(/Approve \((\d+)\)/);
      const initialCount = initialMatch ? Number(initialMatch[1]) : 0;

      // Find the Publisher field's manual input and type a value
      const publisherSection = page.getByTestId("field-publisher");

      // Click the manual radio and type a value
      const manualInput = publisherSection.getByPlaceholder("Enter value...");
      await manualInput.click();
      await manualInput.fill("Custom Publisher Inc.");

      // The approve count should increase by 1
      await expect(approveBtn).toContainText(`Approve (${initialCount + 1})`);
    });

    test("selecting different source changes the selection", async ({ authedPage: page }) => {
      await goPath(page, `/inbox/${switchBookId}`);

      await expect(page.getByText("Select Metadata")).toBeVisible({ timeout: 10_000 });

      // Hardcover is auto-selected for author (higher confidence)
      const authorSection = page.getByTestId("field-author");

      const hardcoverRadio = authorSection
        .locator("label")
        .filter({ hasText: "Hardcover" })
        .locator('input[type="radio"]');
      await expect(hardcoverRadio).toBeChecked();

      // Click the File source radio for author
      const fileRadio = authorSection
        .locator("label")
        .filter({ hasText: "File" })
        .locator('input[type="radio"]');
      await fileRadio.click();

      // File radio should now be checked, Hardcover unchecked
      await expect(fileRadio).toBeChecked();
      await expect(hardcoverRadio).not.toBeChecked();
    });

    test("approve button is disabled when no fields selected and status is not review", async ({
      authedPage: page,
    }) => {
      await goPath(page, `/inbox/${inboxStatusBookId}`);

      await expect(page.getByText("Inbox Status Book").first()).toBeVisible({ timeout: 10_000 });

      // Status badge shows "inbox"
      await expect(page.getByTestId("status-badge").filter({ hasText: "inbox" })).toBeVisible();

      // Approve button should be disabled (status !== review)
      const approveBtn = page.getByTestId("approve-btn");
      await expect(approveBtn).toBeDisabled();

      // Rescan button should be enabled
      const rescanBtn = page.getByTestId("rescan-btn");
      await expect(rescanBtn).toBeEnabled();
    });

    test("breadcrumb navigates back to inbox list", async ({ authedPage: page }) => {
      await goPath(page, `/inbox/${breadcrumbBookId}`);

      await expect(page.getByText("Back Nav Inbox Book").first()).toBeVisible({ timeout: 10_000 });

      // Click the "Inbox" breadcrumb link to go back
      const breadcrumbInbox = page
        .getByRole("navigation", { name: "breadcrumb" })
        .getByRole("link", { name: "Inbox" });
      await breadcrumbInbox.click();

      await page.waitForURL("**/inbox", { timeout: 10_000 });
    });

    test("cover image preview renders for external URLs and updates header preview", async ({
      authedPage: page,
    }) => {
      await goPath(page, `/inbox/${coverBookId}`);

      await expect(page.getByText("Select Metadata")).toBeVisible({ timeout: 10_000 });

      // The Cover field section should show img previews for HTTP URLs
      const coverSection = page.getByTestId("field-coverUrl");

      // Hardcover cover should be auto-selected (highest confidence) with img preview
      const hardcoverCoverImg = coverSection.locator('img[alt="Cover from Hardcover"]');
      await expect(hardcoverCoverImg).toBeVisible();

      // "File" source also appears
      const fileLabel = coverSection.locator("label").filter({ hasText: "File" });
      await expect(fileLabel).toBeVisible();

      // Header cover preview should show the auto-selected Hardcover cover
      const headerCover = page.getByTestId("cover-preview");
      await expect(headerCover).toBeVisible();
      const headerSrc = await headerCover.getAttribute("src");
      expect(headerSrc).toContain("hardcover.app");
    });
  });

  // ── Mutating tests (approve, delete) ────────────────────────────
  //
  // These tests modify data (approve → organized, delete → removed).
  // Each seeds its own data in beforeEach to ensure isolation.

  test.describe("approve and delete", () => {
    test.beforeEach(async () => {
      await deleteAllBooks();
    });

    // Drain queues after approve tests so organized books don't leak
    test.afterAll(async () => {
      await waitForAllQueuesIdle();
    });

    test("approve with manual entry overrides source values", async ({ authedPage: page }) => {
      const bookId = await seedReviewBook({ title: "Manual Override Book" });
      await seedBookFile(bookId);

      await seedCandidate(bookId, "hardcover", 0.9, {
        title: "Manual Override Book",
        author: "Hardcover Author",
        publisher: "Hardcover Publisher",
      });

      await goPath(page, `/inbox/${bookId}`);

      await expect(page.getByText("Select Metadata")).toBeVisible({ timeout: 10_000 });

      // Override the author field with manual entry
      const authorSection = page.getByTestId("field-author");
      const pageErrors: Error[] = [];
      const staleDetail404s: number[] = [];

      page.on("pageerror", (error) => {
        pageErrors.push(error);
      });
      page.on("response", (response) => {
        if (response.url().includes(`/api/inbox/${bookId}`) && response.status() === 404) {
          staleDetail404s.push(response.status());
        }
      });

      const manualInput = authorSection.getByPlaceholder("Enter value...");
      await manualInput.click();
      await manualInput.fill("Manually Entered Author");

      // Wait for the approve API response to verify payload and status
      const approvePromise = page.waitForResponse(
        (res) =>
          res.url().includes(`/api/books/${bookId}/approve`) && res.request().method() === "POST",
      );

      const approveBtn = page.getByTestId("approve-btn");
      await approveBtn.click();

      const approveRes = await approvePromise;
      expect(approveRes.status()).toBe(200);
      const reqBody = approveRes.request().postDataJSON() as {
        fields: Record<string, { source: string; value: unknown }>;
      };

      // Author should be manual source with the entered value
      expect(reqBody.fields.author?.source).toBe("manual");
      expect(reqBody.fields.author?.value).toBe("Manually Entered Author");

      // Other fields should still be from hardcover
      expect(reqBody.fields.title?.source).toBe("hardcover");
      expect(reqBody.fields.publisher?.source).toBe("hardcover");

      // After approval, navigates back to inbox
      await expect(page.getByText("Book approved and organized").first()).toBeVisible({
        timeout: 5_000,
      });
      await page.waitForURL("**/inbox", { timeout: 10_000 });
      await page.waitForTimeout(500);

      expect(staleDetail404s).toHaveLength(0);
      expect(pageErrors).toEqual([]);

      // Verify via API
      const res = await fetch(`${API_BASE}/api/library/${bookId}`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const book = (await res.json()) as { author: string; title: string; status: string };
      expect(book.status).toBe("organized");
      expect(book.author).toBe("Manually Entered Author");
      expect(book.title).toBe("Manual Override Book");
    });

    test("delete button removes book and redirects to inbox", async ({ authedPage: page }) => {
      const bookId = await seedReviewBook({ title: "Delete Me Book" });
      await seedBookFile(bookId);
      await seedCandidate(bookId, "file", 0.5, { title: "Delete Me Book" });

      await goPath(page, `/inbox/${bookId}`);

      await expect(page.getByText("Delete Me Book").first()).toBeVisible({ timeout: 10_000 });

      // Click the delete (trash) icon-only button
      const deleteBtn = page.getByTestId("delete-btn");
      await deleteBtn.click();

      // Confirm the deletion in the ConfirmDialog
      const confirmDialog = page.getByRole("dialog");
      await expect(confirmDialog.getByText("Delete Book")).toBeVisible({ timeout: 5_000 });
      await confirmDialog.getByRole("button", { name: "Delete" }).click();

      // Should redirect to inbox list
      await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({
        timeout: 10_000,
      });

      // Book should no longer appear in the inbox list
      await expect(page.getByText("Delete Me Book")).not.toBeVisible({ timeout: 5_000 });

      // Verify via API that book is gone
      const res = await fetch(`${API_BASE}/api/inbox/${bookId}`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });
});
