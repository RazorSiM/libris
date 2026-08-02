/**
 * E2E: Multi-user auth scenarios.
 *
 * Tests admin key management, regular user login restrictions,
 * credential isolation between users, book ownership UI,
 * reading progress isolation, and stats isolation.
 *
 * Uses two user fixtures:
 * - `adminPage` (or `authedPage`): admin session from .auth/user.json
 * - `userPage`: non-admin session from .auth/regular-user.json
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  getAdminUserId,
  getRegularUserId,
  API_BASE,
  sessionHeaders,
  userSessionHeaders,
  getSql,
  deleteAllBooks,
  seedOrganizedBook,
  seedBookFile,
  invalidateServerCache,
} from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to settings and wait for tabs. */
async function goSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
}

/** Navigate to the home dashboard with a fresh render. */
async function goHome(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

/** Navigate to the stats page. */
async function goStats(page: Page): Promise<void> {
  await page.goto("/stats");
  await page.waitForLoadState("networkidle");
}

/**
 * Was getUserKeyId(): a fetch of /api/auth/keys to find the regular user's key
 * id, which doubled as their owner id because a key WAS a person. Ownership
 * hangs off the person now, so a credential id is not an identity — seeding
 * progress against one would produce rows no query can find. global-setup
 * exposes the user id directly.
 */

/**
 * Seed reading progress for a book, linked to a specific ownerId.
 */
async function seedProgressForUser(
  bookId: string,
  contentHash: string,
  ownerId: string,
  percentage: number,
): Promise<void> {
  const sql = getSql();
  const ts = Math.floor(Date.now() / 1000);
  try {
    await sql`
      INSERT INTO reading_progress (book_id, user_id, document, device, progress, percentage, timestamp)
      VALUES (${bookId}, ${ownerId}, ${contentHash}, 'e2e-device', 'pos', ${percentage.toFixed(4)}, ${ts})
      ON CONFLICT (user_id, document, device) DO UPDATE
        SET percentage = ${percentage.toFixed(4)}, timestamp = ${ts}, updated_at = NOW()
    `;
  } finally {
    await sql.end();
  }
}

/**
 * Seed reading progress history for stats calculations.
 */
async function seedProgressHistory(
  bookId: string,
  contentHash: string,
  ownerId: string,
  percentage: number,
): Promise<void> {
  const sql = getSql();
  try {
    await sql`
      INSERT INTO reading_progress_history (book_id, user_id, document, device, progress, percentage)
      VALUES (${bookId}, ${ownerId}, ${contentHash}, 'e2e-device', 'pos', ${percentage.toFixed(4)})
    `;
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Admin Key Management Flow
// ---------------------------------------------------------------------------

test.describe("Multi-User: Admin Key Management", () => {
  test("admin can navigate to API Keys tab and see key list", async ({ authedPage: page }) => {
    await goSettings(page);

    // Admin should see the API Keys tab
    const apiKeysTab = page.getByRole("tab", { name: "API Keys" });
    await expect(apiKeysTab).toBeVisible({ timeout: 10_000 });
    await apiKeysTab.click();

    // Should see the key list heading
    await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible();

    // Should see at least 2 keys (admin + regular user from global-setup)
    const keyItems = page.locator("[data-testid^='api-key-item-']");
    await expect(keyItems.first()).toBeVisible({ timeout: 10_000 });
    const count = await keyItems.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("admin can create a new key and see it in the list", async ({ authedPage: page }) => {
    await goSettings(page);

    const apiKeysTab = page.getByRole("tab", { name: "API Keys" });
    await expect(apiKeysTab).toBeVisible({ timeout: 10_000 });
    await apiKeysTab.click();

    // Count existing keys
    const keyItems = page.locator("[data-testid^='api-key-item-']");
    await expect(keyItems.first()).toBeVisible({ timeout: 10_000 });
    const initialCount = await keyItems.count();

    // Fill in the label and create
    await page.getByTestId("field-new-key-label").fill("E2E Test Key");
    await page.getByTestId("create-key-btn").click();

    // Should show the newly created key in a modal or inline display
    await expect(page.getByText(/[0-9a-f]{16,}/)).toBeVisible({ timeout: 10_000 });

    // Key list should now have one more entry
    await expect(keyItems).toHaveCount(initialCount + 1, { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Regular User Login Restrictions
// ---------------------------------------------------------------------------

test.describe("Multi-User: Regular User Restrictions", () => {
  test("regular user does not see API Keys tab", async ({ userPage: page }) => {
    await goSettings(page);

    // Should see the Connections tab (available to all)
    await expect(page.getByRole("tab", { name: "Connections" })).toBeVisible({ timeout: 10_000 });

    // Should NOT see admin-only tabs
    await expect(page.getByRole("tab", { name: "API Keys" })).not.toBeVisible();
    await expect(page.getByRole("tab", { name: "System" })).not.toBeVisible();
    await expect(page.getByRole("tab", { name: "Paths" })).not.toBeVisible();
  });

  test("regular user sees own credentials on Connections tab", async ({ userPage: page }) => {
    await goSettings(page);

    const connectionsTab = page.getByRole("tab", { name: "Connections" });
    await expect(connectionsTab).toBeVisible({ timeout: 10_000 });
    await connectionsTab.click();

    // Connections tab should be visible with credential sections
    await expect(page.getByRole("heading", { name: "OPDS Catalog" })).toBeVisible({
      timeout: 10_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Credential Isolation (Browser)
// ---------------------------------------------------------------------------

test.describe("Multi-User: Credential Isolation", () => {
  test("admin sets OPDS creds, user sees unconfigured, user sets own", async ({
    adminPage: _adminPage,
    userPage: _userPage,
  }) => {
    // Sessions throughout: /api/credentials refuses app passwords, so a Bearer
    // key here would 403 before the isolation this test is about is reached
    // (libris-5ng.28).
    const adminSetRes = await fetch(`${API_BASE}/api/credentials/opds`, {
      method: "PUT",
      headers: { ...sessionHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin-opds-e2e", password: "admin-pass" }),
    });
    expect(adminSetRes.ok).toBe(true);

    // User: verify unconfigured
    const userGetRes = await fetch(`${API_BASE}/api/credentials/opds`, {
      headers: userSessionHeaders(),
    });
    const userData = (await userGetRes.json()) as { configured: boolean };
    expect(userData.configured).toBe(false);

    // User: set own OPDS credentials
    const userSetRes = await fetch(`${API_BASE}/api/credentials/opds`, {
      method: "PUT",
      headers: { ...userSessionHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ username: "user-opds-e2e", password: "user-pass" }),
    });
    expect(userSetRes.ok).toBe(true);

    // Verify isolation: admin still sees admin-opds-e2e
    const adminVerifyRes = await fetch(`${API_BASE}/api/credentials/opds`, {
      headers: sessionHeaders(),
    });
    const adminData = (await adminVerifyRes.json()) as { configured: boolean; username: string };
    expect(adminData.configured).toBe(true);
    expect(adminData.username).toBe("admin-opds-e2e");

    // Verify: user sees user-opds-e2e
    const userVerifyRes = await fetch(`${API_BASE}/api/credentials/opds`, {
      headers: userSessionHeaders(),
    });
    const userVerifyData = (await userVerifyRes.json()) as {
      configured: boolean;
      username: string;
    };
    expect(userVerifyData.configured).toBe(true);
    expect(userVerifyData.username).toBe("user-opds-e2e");
  });
});

// ---------------------------------------------------------------------------
// Book Ownership UI
// ---------------------------------------------------------------------------

test.describe("Multi-User: Book Ownership UI", () => {
  test.describe.configure({ mode: "serial" });

  let adminBookId: string;

  test.beforeAll(async () => {
    await deleteAllBooks();

    // Seed a book owned by admin
    adminBookId = await seedOrganizedBook({
      title: "Admin's Library Book",
      author: "Admin Author",
    });

    // Set ownership
    const adminUserId = getAdminUserId();
    const sql = getSql();
    try {
      await sql`UPDATE books SET created_by = ${adminUserId} WHERE id = ${adminBookId}`;
    } finally {
      await sql.end();
    }
    await invalidateServerCache();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("admin sees edit controls on own book", async ({ adminPage: page }) => {
    await page.goto(`/library/${adminBookId}`);
    await page.waitForLoadState("networkidle");

    // Admin should see the actions dropdown (edit/delete/reorganize)
    await expect(page.getByTestId("book-actions-btn")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("regular user can view admin's book but has limited controls", async ({
    userPage: page,
  }) => {
    await page.goto(`/library/${adminBookId}`);
    await page.waitForLoadState("networkidle");

    // User should see the book title (shared library)
    await expect(page.getByRole("heading", { name: "Admin's Library Book" })).toBeVisible({
      timeout: 10_000,
    });

    // User should NOT see the actions dropdown (edit/delete/reorganize controls)
    await expect(page.getByTestId("book-actions-btn")).not.toBeVisible();

    // Verify edit and delete options are not accessible in the DOM
    await expect(page.getByRole("button", { name: /edit/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /delete/i })).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Reading Progress Isolation
// ---------------------------------------------------------------------------

test.describe("Multi-User: Reading Progress Isolation", () => {
  test.describe.configure({ mode: "serial" });

  let sharedBookId: string;
  let contentHash: string;

  test.beforeAll(async () => {
    await deleteAllBooks();

    // Seed a shared book with a file
    sharedBookId = await seedOrganizedBook({
      title: "Shared Progress Book",
      author: "Progress Author",
      pageCount: 400,
    });
    contentHash = `hash-shared-${Date.now()}`;
    const fileId = await seedBookFile(sharedBookId, {
      format: "epub",
      originalName: "shared.epub",
    });

    // Update the file's content hash
    const sql = getSql();
    try {
      await sql`UPDATE book_files SET content_hash = ${contentHash} WHERE id = ${fileId}`;
    } finally {
      await sql.end();
    }

    // Get key IDs
    const adminUserId = getAdminUserId();
    const userKeyId = getRegularUserId();

    // Admin at 75% on the book
    await seedProgressForUser(sharedBookId, contentHash, adminUserId, 0.75);
    // User at 25% on the book
    await seedProgressForUser(sharedBookId, contentHash, userKeyId, 0.25);

    await invalidateServerCache();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("admin dashboard shows 75% progress", async ({ adminPage: page }) => {
    await goHome(page);

    const readingSection = page.getByTestId("currently-reading-section");
    await expect(readingSection).toBeVisible({ timeout: 10_000 });
    await expect(readingSection.getByText("75%")).toBeVisible();
  });

  test("user dashboard shows 25% progress", async ({ userPage: page }) => {
    await goHome(page);

    const readingSection = page.getByTestId("currently-reading-section");
    await expect(readingSection).toBeVisible({ timeout: 10_000 });
    await expect(readingSection.getByText("25%")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Stats Isolation
// ---------------------------------------------------------------------------

test.describe("Multi-User: Stats Isolation", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await deleteAllBooks();

    const adminUserId = getAdminUserId();
    const userKeyId = getRegularUserId();

    // Admin finishes 3 books
    for (let i = 0; i < 3; i++) {
      const bookId = await seedOrganizedBook({
        title: `Admin Finished ${i + 1}`,
        author: "Admin Author",
        genres: ["Fantasy"],
        pageCount: 300,
      });
      const hash = `hash-admin-finished-${i}-${Date.now()}`;
      const fileId = await seedBookFile(bookId);

      // Update hash
      const sql = getSql();
      try {
        await sql`UPDATE book_files SET content_hash = ${hash} WHERE id = ${fileId}`;
      } finally {
        await sql.end();
      }

      await seedProgressForUser(bookId, hash, adminUserId, 0.98);
      await seedProgressHistory(bookId, hash, adminUserId, 0.98);
    }

    // User finishes 1 book
    const userBookId = await seedOrganizedBook({
      title: "User Finished 1",
      author: "User Author",
      genres: ["Sci-Fi"],
      pageCount: 200,
    });
    const userHash = `hash-user-finished-${Date.now()}`;
    const userFileId = await seedBookFile(userBookId);

    const sql = getSql();
    try {
      await sql`UPDATE book_files SET content_hash = ${userHash} WHERE id = ${userFileId}`;
    } finally {
      await sql.end();
    }

    await seedProgressForUser(userBookId, userHash, userKeyId, 0.98);
    await seedProgressHistory(userBookId, userHash, userKeyId, 0.98);

    await invalidateServerCache();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("admin stats shows 3 finished books", async ({ adminPage: page }) => {
    await goStats(page);

    await expect(page.getByTestId("stat-value-finished-all-time")).toHaveText("3", {
      timeout: 10_000,
    });
  });

  test("user stats shows 1 finished book", async ({ userPage: page }) => {
    await goStats(page);

    await expect(page.getByTestId("stat-value-finished-all-time")).toHaveText("1", {
      timeout: 10_000,
    });
  });
});
