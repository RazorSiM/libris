/**
 * E2E: Library views and book detail.
 *
 * Tests the library page: grid view, list view, author filter, genre filter,
 * search, pagination, book detail page metadata fields, cover image,
 * file download link, and empty library state.
 *
 * Books are seeded directly into the database (organized status) because
 * /__test/seed-books is unavailable in dev mode (import.meta.test = false).
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  API_BASE,
  authHeaders,
  getAdminUserId,
  getRegularUserId,
  getSql,
  goPath,
  deleteAllBooks,
  seedOrganizedBook,
  seedBookFile,
  waitForAllQueuesIdle,
} from "./helpers";
import { ADMIN, REGULAR_USER } from "./helpers/accounts.js";

/** Navigate to library via sidebar link (avoids SSR redirect). */
async function goLibrary(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Library" }).click();
  await page.waitForURL("**/library");
  await page.waitForLoadState("networkidle");
}

/**
 * Who owns what, for the uploader filter and the detail page's byline.
 *
 * Was a fetch of /api/auth/keys picking the isAdmin key out of the list, which
 * worked because a key WAS a person and its label WAS their display name. Both
 * facts are gone: the route is removed, keys carry no isAdmin, and the byline
 * shows the user's name. Nothing needs fetching now — global-setup already
 * knows both accounts.
 */
function owners() {
  return {
    admin: { id: getAdminUserId(), label: ADMIN.name },
    regular: { id: getRegularUserId(), label: REGULAR_USER.name },
  };
}

// ---------------------------------------------------------------------------
// Tests — Library
// ---------------------------------------------------------------------------

test.describe("Library", { tag: "@smoke" }, () => {
  test.describe.configure({ mode: "serial" });

  // ── Empty library ───────────────────────────────────────────────

  test.describe("empty library", () => {
    test.beforeAll(async () => {
      await waitForAllQueuesIdle();
      await deleteAllBooks();
    });

    test("empty library shows placeholder message", async ({ authedPage: page }) => {
      await goLibrary(page);

      await expect(page.getByText("No books in library")).toBeVisible({ timeout: 10_000 });
    });
  });

  // ── Grid, list, search, and navigation ──────────────────────────
  //
  // Seed 8 books once for grid view, list view, search (author/genre/title),
  // and click-to-detail tests. All tests are read-only.

  test.describe("grid, list, search, and navigation", () => {
    let fantasyBookId: string;
    let bobBookId: string;

    test.beforeAll(async () => {
      await waitForAllQueuesIdle();
      await deleteAllBooks();

      // Author-search books
      await seedOrganizedBook({ title: "Book by Alice", author: "Alice Smith" });
      bobBookId = await seedOrganizedBook({
        title: "Book by Bob",
        author: "Bob Jones",
        genres: ["Mystery", "Thriller"],
      });
      await seedBookFile(bobBookId, { format: "pdf", originalName: "bob.pdf" });

      await seedOrganizedBook({
        title: "Book by Alice Too",
        author: "Alice Brown",
        genres: ["Romance"],
      });

      // Genre-search books
      fantasyBookId = await seedOrganizedBook({
        title: "Fantasy Adventure",
        author: "Author X",
        genres: ["Fantasy", "Adventure"],
      });
      await seedBookFile(fantasyBookId, { format: "epub", originalName: "fantasy.epub" });

      await seedOrganizedBook({
        title: "Sci-Fi Thriller",
        author: "Author Y",
        genres: ["Sci-Fi", "Thriller"],
      });

      // Title-search books
      await seedOrganizedBook({ title: "The Great Gatsby", author: "F. Scott Fitzgerald" });
      await seedOrganizedBook({ title: "Moby Dick", author: "Herman Melville" });
      await seedOrganizedBook({ title: "Great Expectations", author: "Charles Dickens" });
    });

    test("grid view shows books with titles and authors", async ({ authedPage: page }) => {
      await goLibrary(page);

      // Grid view is the default — verify books are rendered
      await expect(page.getByText("Book by Alice", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Book by Bob")).toBeVisible();
      await expect(page.getByText("Fantasy Adventure")).toBeVisible();
      await expect(page.getByText("Alice Smith")).toBeVisible();
      await expect(page.getByText("Bob Jones")).toBeVisible();
      await expect(page.getByText("Author X")).toBeVisible();
      await expect(page.getByTestId("library-results-count")).toContainText("8 books");
    });

    test("grid cards stay constrained on wide screens", async ({ authedPage: page }) => {
      await page.setViewportSize({ width: 1800, height: 1200 });
      await goLibrary(page);
      const firstCard = page.getByTestId(`book-card-${bobBookId}`);
      await expect(firstCard).toBeVisible({ timeout: 10_000 });

      const box = await firstCard.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(240);
    });

    test("switch to list view shows table with columns", async ({ authedPage: page }) => {
      await goLibrary(page);
      await expect(page.getByText("Book by Bob")).toBeVisible({ timeout: 10_000 });

      // Switch to list view
      const listBtn = page.getByRole("button", { name: "List view" });
      await listBtn.click();

      // Table headers visible
      await expect(page.getByText("Title").first()).toBeVisible();
      await expect(page.getByText("Author").first()).toBeVisible();
      await expect(page.getByText("Format").first()).toBeVisible();
      await expect(page.getByText("Genres").first()).toBeVisible();
      await expect(page.getByText("Added").first()).toBeVisible();

      // Book data in table
      await expect(page.getByText("Book by Bob")).toBeVisible();
      await expect(page.getByText("Bob Jones")).toBeVisible();
      await expect(page.getByText("Fantasy Adventure")).toBeVisible();

      // Genre badges in list view (max 2 per book)
      await expect(page.getByText("Mystery")).toBeVisible();
      await expect(page.getByText("Thriller").first()).toBeVisible();
      await expect(page.getByText("Romance")).toBeVisible();
    });

    test("search finds books by author", async ({ authedPage: page }) => {
      await goLibrary(page);
      await expect(page.getByText("Book by Alice", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Book by Bob")).toBeVisible();

      const searchInput = page.getByPlaceholder("Search books...");
      await searchInput.fill("Bob Jones");

      // Should filter to only Bob Jones's book
      await expect(page.getByText("Book by Bob")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Book by Alice", { exact: true })).not.toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByText("Book by Alice Too")).not.toBeVisible({ timeout: 5_000 });

      // Clear search
      await searchInput.clear();

      // All books should return
      await expect(page.getByText("Book by Alice", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
    });

    test("search finds books by genre", async ({ authedPage: page }) => {
      await goLibrary(page);
      await expect(page.getByText("Fantasy Adventure")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Sci-Fi Thriller")).toBeVisible();

      const searchInput = page.getByPlaceholder("Search books...");
      await searchInput.fill("Fantasy");

      // Should show only Fantasy books
      await expect(page.getByText("Fantasy Adventure")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Sci-Fi Thriller")).not.toBeVisible({ timeout: 5_000 });
    });

    test("search finds books by title", async ({ authedPage: page }) => {
      await goLibrary(page);
      await expect(page.getByText("The Great Gatsby")).toBeVisible({ timeout: 10_000 });

      // Search for "Great"
      const searchInput = page.getByPlaceholder("Search books...");
      await searchInput.fill("Great");

      // Should find matching books
      await expect(page.getByText("The Great Gatsby")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Great Expectations")).toBeVisible();
      await expect(page.getByText("Moby Dick")).not.toBeVisible();
    });

    test("click book in grid navigates to detail page", async ({ authedPage: page }) => {
      await goLibrary(page);
      await expect(page.getByText("Fantasy Adventure")).toBeVisible({ timeout: 10_000 });

      // Click the book in grid view
      await page.getByText("Fantasy Adventure").click();

      // Should navigate to detail page
      await page.waitForURL(`**/library/${fantasyBookId}`, { timeout: 10_000 });
      await expect(page.getByRole("heading", { name: "Fantasy Adventure" })).toBeVisible();
    });

    test("click book in list view navigates to detail page", async ({ authedPage: page }) => {
      await goLibrary(page);
      await expect(page.getByText("Book by Bob")).toBeVisible({ timeout: 10_000 });

      // Switch to list view
      const listBtn = page.getByRole("button", { name: "List view" });
      await listBtn.click();

      // Click the book row
      await page.getByText("Book by Bob").click();

      // Should navigate to detail page
      await page.waitForURL(`**/library/${bobBookId}`, { timeout: 10_000 });
      await expect(page.getByRole("heading", { name: "Book by Bob" })).toBeVisible();
    });
  });

  // ── Pagination ──────────────────────────────────────────────────

  test.describe("pagination", () => {
    test.beforeAll(async () => {
      await waitForAllQueuesIdle();
      await deleteAllBooks();

      // Seed 25 books (page limit is 20)
      const promises: Promise<string>[] = [];
      for (let i = 1; i <= 25; i++) {
        promises.push(
          seedOrganizedBook({
            title: `Paginated Book ${String(i).padStart(2, "0")}`,
            author: `Author ${i}`,
          }),
        );
      }
      await Promise.all(promises);
    });

    test("pagination appears with many books", async ({ authedPage: page }) => {
      await goLibrary(page);

      // Wait for first page books to appear
      await expect(page.getByText("Paginated Book", { exact: false }).first()).toBeVisible({
        timeout: 10_000,
      });

      // Pagination should be visible (totalPages > 1) — look for the "2" page button
      await expect(page.getByRole("button", { name: "2" })).toBeVisible({ timeout: 5_000 });

      // Click page 2
      await page.getByRole("button", { name: "2" }).click();

      // Page 2 should show books 21-25 (sorted alphabetically), not page 1 content
      await expect(page.getByText("Paginated Book 21")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Paginated Book 01")).not.toBeVisible();
    });
  });

  test.describe("filters and uploader metadata", () => {
    let adminBookId: string;
    let regularBookId: string;
    let keys: ReturnType<typeof owners>;

    test.beforeAll(async () => {
      await waitForAllQueuesIdle();
      await deleteAllBooks();
      keys = owners();

      adminBookId = await seedOrganizedBook({
        title: "English Admin Book",
        author: "Admin Author",
        language: "en",
      });
      regularBookId = await seedOrganizedBook({
        title: "French User Book",
        author: "Regular Author",
        language: "fr",
      });

      const sql = getSql();
      try {
        await sql`
          UPDATE books
          SET created_by = ${keys.admin.id}
          WHERE id = ${adminBookId}
        `;
        await sql`
          UPDATE books
          SET created_by = ${keys.regular.id}
          WHERE id = ${regularBookId}
        `;
      } finally {
        await sql.end();
      }
    });

    test("filter panel filters the library by language and uploader", async ({
      authedPage: page,
    }) => {
      await goLibrary(page);
      await expect(page.getByText("English Admin Book")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("French User Book")).toBeVisible();

      await page.getByTestId("open-filters-btn").click();
      await expect(page.getByTestId("language-filter")).toBeVisible();

      await page.getByTestId("language-filter").click();
      await page.getByRole("option", { name: "French" }).click();

      await page.getByTestId("uploader-filter").click();
      await page.getByRole("option", { name: keys.regular.label }).click();

      await page.getByRole("button", { name: "Done" }).click();

      await expect(page.getByTestId("active-filter-language")).toContainText("Language: French");
      await expect(page.getByTestId("active-filter-uploaderId")).toContainText(keys.regular.label);
      await expect(page.getByText("French User Book")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("English Admin Book")).not.toBeVisible({ timeout: 5_000 });
    });

    test("library detail shows the uploader label", async ({ authedPage: page }) => {
      await goPath(page, `/library/${adminBookId}`);
      await expect(page.getByRole("heading", { name: "English Admin Book" })).toBeVisible();
      await expect(page.getByTestId("book-uploader")).toContainText(keys.admin.label);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Book Detail
// ---------------------------------------------------------------------------

test.describe("Book Detail", { tag: "@smoke" }, () => {
  test.describe.configure({ mode: "serial" });

  // Seed 3 books once for all detail tests:
  // - fullBook: all metadata + cover + file (for metadata, cover, download, back-nav tests)
  // - noCoverBook: no cover_path (for placeholder test)
  // - noFilesBook: no files (for empty files test)
  let fullBookId: string;
  let fullBookFileId: string;
  let noCoverBookId: string;
  let noFilesBookId: string;

  test.beforeAll(async () => {
    await waitForAllQueuesIdle();
    await deleteAllBooks();

    // Book with full metadata + cover + file
    const sql = getSql();
    try {
      const [row] = await sql`
        INSERT INTO books (
          status, title, author, description, genres,
          publisher, published_year, language, page_count,
          isbn_10, isbn_13, cover_path, created_by, approved_at
        )
        VALUES (
          'organized',
          'Detailed Book Title', 'Jane Doe',
          'A comprehensive description of this detailed book for testing purposes.',
          '{"Fantasy","Adventure","Epic"}'::text[],
          'Penguin Books', 2023, 'en', 432,
          '1234567890', '9781234567890',
          'Jane Doe/Detailed Book Title/cover.jpg',
          ${getAdminUserId()},
          NOW()
        )
        RETURNING id
      `;
      fullBookId = row.id;
    } finally {
      await sql.end();
    }
    fullBookFileId = await seedBookFile(fullBookId, {
      format: "epub",
      originalName: "download-test.epub",
      fileSize: 2048000,
    });

    // Book without cover
    noCoverBookId = await seedOrganizedBook({
      title: "No Cover Book",
      author: "No Cover Author",
    });

    // Book without files
    noFilesBookId = await seedOrganizedBook({
      title: "No Files Book",
      author: "No Files Author",
    });
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("displays all metadata fields", async ({ authedPage: page }) => {
    await goPath(page, `/library/${fullBookId}`);

    // Title and author
    await expect(page.getByRole("heading", { name: "Detailed Book Title" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Jane Doe")).toBeVisible();

    // Description
    await expect(page.getByText("A comprehensive description of this detailed book")).toBeVisible();

    // Genre badges
    await expect(page.getByText("Fantasy")).toBeVisible();
    await expect(page.getByText("Adventure")).toBeVisible();
    await expect(page.getByText("Epic")).toBeVisible();

    // Details section
    await expect(page.getByText("Details")).toBeVisible();

    // Publisher
    await expect(page.getByText("Publisher")).toBeVisible();
    await expect(page.getByText("Penguin Books")).toBeVisible();

    // Published year
    await expect(page.getByText("Published")).toBeVisible();
    await expect(page.getByText("2023")).toBeVisible();

    // Language
    await expect(page.getByText("Language")).toBeVisible();
    await expect(page.locator("dd").filter({ hasText: /^en$/i })).toBeVisible();

    // Pages
    await expect(page.getByText("Pages")).toBeVisible();
    await expect(page.getByText("432")).toBeVisible();

    // ISBNs
    await expect(page.getByText("ISBN-13")).toBeVisible();
    await expect(page.getByText("9781234567890")).toBeVisible();
    await expect(page.getByText("ISBN-10")).toBeVisible();
    await expect(page.getByText("1234567890", { exact: true })).toBeVisible();

    // Dates
    await expect(page.getByText("Organized")).toBeVisible();
    await expect(page.getByText("Added")).toBeVisible();
    const organizedDd = page.locator("dl div:has(dt:text('Organized')) dd");
    await expect(organizedDd).not.toHaveText("—");
  });

  test("cover image loads when available", async ({ authedPage: page }) => {
    await goPath(page, `/library/${fullBookId}`);

    await expect(page.getByRole("heading", { name: "Detailed Book Title" })).toBeVisible({
      timeout: 10_000,
    });

    // Cover image should be rendered (coverPath triggers the img element)
    const coverImg = page.getByTestId("book-cover-img");
    await expect(coverImg).toBeVisible();
    await expect(coverImg).toHaveAttribute("src", /\/api\/library\/.*\/cover$/);
  });

  test("cover placeholder shown when no cover", async ({ authedPage: page }) => {
    await goPath(page, `/library/${noCoverBookId}`);

    await expect(page.getByRole("heading", { name: "No Cover Book" })).toBeVisible({
      timeout: 10_000,
    });

    // Should not have a cover image — placeholder icon should be shown
    const coverImg = page.locator("img[alt='No Cover Book']");
    await expect(coverImg).not.toBeVisible();

    // Placeholder should be visible
    const placeholder = page.getByTestId("cover-placeholder");
    await expect(placeholder).toBeVisible();
  });

  test("file download link works", async ({ authedPage: page }) => {
    await goPath(page, `/library/${fullBookId}`);

    await expect(page.getByRole("heading", { name: "Detailed Book Title" })).toBeVisible({
      timeout: 10_000,
    });

    // Files section
    await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
    await expect(page.getByText("download-test.epub")).toBeVisible();

    // Format badge
    await expect(page.getByText("epub", { exact: true }).first()).toBeVisible();

    // File size (2048000 bytes = ~2.0 MB)
    await expect(page.getByText("2.0 MB")).toBeVisible();

    // Download button with correct href
    const downloadLink = page.locator(
      `a[href$="/api/library/${fullBookId}/download/${fullBookFileId}"]`,
    );
    await expect(downloadLink).toBeVisible();

    // Verify the download endpoint returns correct headers via API
    const res = await fetch(`${API_BASE}/api/library/${fullBookId}/download/${fullBookFileId}`, {
      method: "HEAD",
      headers: authHeaders(),
    });
    // Will be 404 because storagePath is null (no real file on disk)
    expect(res.status).toBe(404);
  });

  test("no files shows empty state", async ({ authedPage: page }) => {
    await goPath(page, `/library/${noFilesBookId}`);

    await expect(page.getByRole("heading", { name: "No Files Book" })).toBeVisible({
      timeout: 10_000,
    });

    // Files section with empty state
    await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
    await expect(page.getByText("No files available")).toBeVisible();
  });

  test("back button navigates to library list", async ({ authedPage: page }) => {
    await goPath(page, `/library/${fullBookId}`);

    await expect(page.getByRole("heading", { name: "Detailed Book Title" })).toBeVisible({
      timeout: 10_000,
    });

    // Click the Library breadcrumb link to navigate back
    const breadcrumbLibrary = page
      .getByRole("navigation", { name: "breadcrumb" })
      .getByRole("link", { name: "Library" });
    await breadcrumbLibrary.click();

    await page.waitForURL("**/library", { timeout: 10_000 });
  });
});
