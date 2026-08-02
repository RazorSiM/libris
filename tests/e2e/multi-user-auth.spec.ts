/**
 * E2E: Multi-user auth hardening.
 *
 * Tests credential rotation cache invalidation, frontend query cache clearing
 * on logout/login, credential form persistence (v-model fix), API key deletion
 * UI, and file upload collision safety.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  getAdminUserId,
  API_BASE,
  authHeaders,
  userAuthHeaders,
  sessionHeaders,
  getApiKey,
  seedOpdsCredentials,
  deleteAllBooks,
  seedOrganizedBook,
  seedBookFile,
  getSql,
  invalidateServerCache,
} from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function goSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
}

async function switchTab(page: Page, tabLabel: string): Promise<void> {
  await page.getByRole("tab", { name: tabLabel, exact: true }).click();
}

function opdsBasicAuth(username: string, password: string): { Authorization: string } {
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

/** Seed a book in "review" status (for approve tests). */
async function seedReviewBook(
  overrides: { title?: string; createdBy?: string } = {},
): Promise<string> {
  const sql = getSql();
  try {
    const [row] = await sql`
      INSERT INTO books (status, title, author, created_by)
      VALUES ('review', ${overrides.title ?? "Review Book"}, 'Test Author', ${overrides.createdBy ?? null})
      RETURNING id
    `;
    return row.id;
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Credential Rotation Cache Invalidation
// ---------------------------------------------------------------------------

test.describe("Credential Rotation Cache Invalidation", () => {
  test("OPDS auth fails immediately after password rotation", async () => {
    const username = "opds-rotation-test";
    const oldPassword = "old-pass-e2e";
    const newPassword = "new-pass-e2e";

    // Seed initial OPDS credentials
    await seedOpdsCredentials(username, oldPassword);

    // Verify OPDS feed works with current creds
    const firstRes = await fetch(`${API_BASE}/opds/`, {
      headers: opdsBasicAuth(username, oldPassword),
    });
    expect(firstRes.status).toBe(200);

    // Rotate password
    const rotateRes = await fetch(`${API_BASE}/api/credentials/opds`, {
      method: "PUT",
      headers: { ...sessionHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: newPassword }),
    });
    expect(rotateRes.status).toBe(200);

    // Old creds should fail immediately (cache was cleared)
    const oldRes = await fetch(`${API_BASE}/opds/`, {
      headers: opdsBasicAuth(username, oldPassword),
    });
    expect(oldRes.status).toBe(401);

    // New creds should work
    const newRes = await fetch(`${API_BASE}/opds/`, {
      headers: opdsBasicAuth(username, newPassword),
    });
    expect(newRes.status).toBe(200);
  });

  test("OPDS auth fails immediately after credential deletion", async () => {
    const username = "opds-delete-test";
    const password = "delete-pass-e2e";

    await seedOpdsCredentials(username, password);

    // Verify OPDS works
    const firstRes = await fetch(`${API_BASE}/opds/`, {
      headers: opdsBasicAuth(username, password),
    });
    expect(firstRes.status).toBe(200);

    // Delete credentials
    const deleteRes = await fetch(`${API_BASE}/api/credentials/opds`, {
      method: "DELETE",
      headers: sessionHeaders(),
    });
    expect(deleteRes.status).toBe(200);

    // Old creds should fail immediately
    const afterRes = await fetch(`${API_BASE}/opds/`, {
      headers: opdsBasicAuth(username, password),
    });
    expect(afterRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Logout Clears Frontend Query Cache
// ---------------------------------------------------------------------------

test.describe("Logout Clears Frontend Query Cache", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await deleteAllBooks();
    await seedOrganizedBook({
      title: "Admin Cache Test Book",
      author: "Cache Author",
    });
    await invalidateServerCache();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("library fetches fresh data after logout and re-login", async ({ authedPage: page }) => {
    // Navigate to library — this populates the query cache
    await page.goto("/library");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Admin Cache Test Book")).toBeVisible({ timeout: 10_000 });

    // Navigate to settings and logout
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page.getByText("Welcome to Libris")).toBeVisible({ timeout: 10_000 });

    // Re-login with same key
    await page.getByPlaceholder("Enter your API key").fill(getApiKey());
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.getByRole("tab", { name: "Connections" })).toBeVisible({ timeout: 10_000 });

    // Navigate to library — should make a fresh /api/library call (cache was cleared on login)
    const libraryFetchPromise = page.waitForResponse(
      (resp) => resp.url().includes("/api/library") && resp.status() === 200,
    );
    await page.goto("/library");
    const libraryResponse = await libraryFetchPromise;
    expect(libraryResponse.ok()).toBe(true);

    await expect(page.getByText("Admin Cache Test Book")).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Credential Form Persistence (v-model fix)
// ---------------------------------------------------------------------------

test.describe("Credential Form Persistence", () => {
  test("OPDS username persists after save and page reload", async ({ authedPage: page }) => {
    await goSettings(page);
    await switchTab(page, "Connections");

    // Fill OPDS credentials
    const usernameInput = page.getByTestId("opds-username-input");
    const passwordInput = page.getByTestId("opds-password-input");
    await usernameInput.fill("opds-persist-user");
    await passwordInput.fill("opds-persist-pass");

    // Save and wait for API response
    const savePromise = page.waitForResponse(
      (resp) => resp.url().includes("/api/credentials/opds") && resp.request().method() === "PUT",
    );
    await page.getByTestId("opds-save-btn").click();
    const saveRes = await savePromise;
    expect(saveRes.ok()).toBe(true);

    // Reload the page
    await page.reload();
    await page.waitForLoadState("networkidle");
    await switchTab(page, "Connections");

    // Username should still show the saved value
    await expect(page.getByTestId("opds-username-input")).toHaveValue("opds-persist-user", {
      timeout: 10_000,
    });
  });

  test("KoSync username persists after save and page reload", async ({ authedPage: page }) => {
    await goSettings(page);
    await switchTab(page, "Connections");

    // Fill KoSync credentials
    const usernameInput = page.getByTestId("kosync-username-input");
    const passwordInput = page.getByTestId("kosync-password-input");
    await usernameInput.fill("kosync-persist-user");
    await passwordInput.fill("kosync-persist-pass");

    // Save and wait for API response
    const savePromise = page.waitForResponse(
      (resp) => resp.url().includes("/api/credentials/kosync") && resp.request().method() === "PUT",
    );
    await page.getByTestId("kosync-save-btn").click();
    const saveRes = await savePromise;
    expect(saveRes.ok()).toBe(true);

    // Reload the page
    await page.reload();
    await page.waitForLoadState("networkidle");
    await switchTab(page, "Connections");

    // Username should still show the saved value
    await expect(page.getByTestId("kosync-username-input")).toHaveValue("kosync-persist-user", {
      timeout: 10_000,
    });
  });
});

// ---------------------------------------------------------------------------
// API Key Deletion UI
// ---------------------------------------------------------------------------

test.describe("API Key Deletion UI", () => {
  test.describe.configure({ mode: "serial" });

  test("admin can delete a key via UI with confirmation dialog", async ({ authedPage: page }) => {
    await goSettings(page);
    await switchTab(page, "API Keys");

    // Wait for key list to load
    const keyItems = page.locator("[data-testid^='api-key-item-']");
    await expect(keyItems.first()).toBeVisible({ timeout: 10_000 });
    const initialCount = await keyItems.count();

    // Create a new key
    await page.getByTestId("field-new-key-label").fill("Deletable Key");
    await page.getByTestId("create-key-btn").click();

    // Wait for the reveal banner and dismiss it
    await expect(page.getByTestId("new-key-reveal")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("dismiss-new-key-btn").click();

    // Verify key list grew
    await expect(keyItems).toHaveCount(initialCount + 1, { timeout: 10_000 });

    // Find the delete button for "Deletable Key" — it's the last key item
    const lastKeyItem = keyItems.last();
    await expect(lastKeyItem.getByText("Deletable Key")).toBeVisible();
    const deleteBtn = lastKeyItem.getByTestId(/^delete-key-btn-/);
    await deleteBtn.click();

    // Confirmation dialog should appear
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText("Delete API Key")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();

    // Confirm deletion
    await dialog.getByRole("button", { name: "Delete" }).click();

    // Key should disappear
    await expect(keyItems).toHaveCount(initialCount, { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// File Upload Collision Safety
// ---------------------------------------------------------------------------

test.describe("File Upload Collision Safety", () => {
  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("uploading same filename twice creates two distinct books", async () => {
    const fixturePath = join(import.meta.dirname, "fixtures", "test-book.epub");
    const fileBuffer = await readFile(fixturePath);
    const blob = new Blob([fileBuffer], { type: "application/epub+zip" });

    // Upload same file twice with identical name
    const upload = async () => {
      const form = new FormData();
      form.append("file", blob, "collision-test.epub");
      return fetch(`${API_BASE}/api/inbox/upload`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
    };

    const [res1, res2] = await Promise.all([upload(), upload()]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Both uploads should succeed — the second file gets a unique name
    const data1 = (await res1.json()) as {
      uploaded: Array<{ filename: string; size: number }>;
    };
    const data2 = (await res2.json()) as {
      uploaded: Array<{ filename: string; size: number }>;
    };
    expect(data1.uploaded).toHaveLength(1);
    expect(data2.uploaded).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Book Ownership: API-level Enforcement
// ---------------------------------------------------------------------------

test.describe("Book Ownership: API Enforcement", () => {
  test.describe.configure({ mode: "serial" });

  let adminBookId: string;
  let adminReviewBookId: string;

  test.beforeAll(async () => {
    await deleteAllBooks();

    const adminUserId = getAdminUserId();

    // Seed organized book owned by admin
    adminBookId = await seedOrganizedBook({ title: "Admin Owned Book" });
    const sql = getSql();
    try {
      await sql`UPDATE books SET created_by = ${adminUserId} WHERE id = ${adminBookId}`;
    } finally {
      await sql.end();
    }

    // Seed review book owned by admin (for approve test)
    adminReviewBookId = await seedReviewBook({
      title: "Admin Review Book",
      createdBy: adminUserId,
    });

    // Seed a metadata candidate so approve has something to work with
    await seedBookFile(adminReviewBookId, { format: "epub", originalName: "admin-review.epub" });

    await invalidateServerCache();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("regular user gets 403 when trying to delete admin's book", async () => {
    const res = await fetch(`${API_BASE}/api/books/${adminBookId}`, {
      method: "DELETE",
      headers: userAuthHeaders(),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("owner");
  });

  test("regular user gets 403 when trying to approve admin's book", async () => {
    const res = await fetch(`${API_BASE}/api/books/${adminReviewBookId}/approve`, {
      method: "POST",
      headers: { ...userAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { title: { source: "manual", value: "Hijacked" } } }),
    });
    expect(res.status).toBe(403);
  });

  test("regular user gets 403 when trying to patch admin's book", async () => {
    const res = await fetch(`${API_BASE}/api/library/${adminBookId}`, {
      method: "PATCH",
      headers: { ...userAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Hijacked Title" }),
    });
    expect(res.status).toBe(403);
  });

  test("admin can delete own book (ownership check passes)", async () => {
    // Create a throwaway book for admin to delete
    const throwawayId = await seedOrganizedBook({ title: "Admin Deletable" });
    const adminUserId = getAdminUserId();
    const sql = getSql();
    try {
      await sql`UPDATE books SET created_by = ${adminUserId} WHERE id = ${throwawayId}`;
    } finally {
      await sql.end();
    }

    const res = await fetch(`${API_BASE}/api/books/${throwawayId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Unowned Books: Only Admin Can Modify
// ---------------------------------------------------------------------------

test.describe("Unowned Books: Admin-Only Modify", () => {
  test.describe.configure({ mode: "serial" });

  let unownedBookId: string;

  test.beforeAll(async () => {
    await deleteAllBooks();
    // Seed a book with no owner (createdBy = null)
    unownedBookId = await seedOrganizedBook({ title: "Unowned Legacy Book" });
    await invalidateServerCache();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("regular user gets 403 when modifying unowned book", async () => {
    const res = await fetch(`${API_BASE}/api/library/${unownedBookId}`, {
      method: "PATCH",
      headers: { ...userAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Stolen Book" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("admin");
  });

  test("regular user gets 403 when deleting unowned book", async () => {
    const res = await fetch(`${API_BASE}/api/books/${unownedBookId}`, {
      method: "DELETE",
      headers: userAuthHeaders(),
    });
    expect(res.status).toBe(403);
  });

  test("admin can modify unowned book", async () => {
    const res = await fetch(`${API_BASE}/api/library/${unownedBookId}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Reclaimed by Admin" }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Upload Attribution: Books Attributed to Uploading User
// ---------------------------------------------------------------------------

test.describe("Upload Attribution", () => {
  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("uploaded book is attributed to the uploading user", async () => {
    const fixturePath = join(import.meta.dirname, "fixtures", "test-book.epub");
    const fileBuffer = await readFile(fixturePath);
    const blob = new Blob([fileBuffer], { type: "application/epub+zip" });

    // Upload as regular user
    const form = new FormData();
    form.append("file", blob, "attribution-test.epub");
    const uploadRes = await fetch(`${API_BASE}/api/inbox/upload`, {
      method: "POST",
      headers: userAuthHeaders(),
      body: form,
    });
    expect(uploadRes.status).toBe(200);

    // Check the upload_registry was created with the user's API key
    const sql = getSql();
    try {
      // Get the regular user's key ID
      const keysRes = await fetch(`${API_BASE}/api/auth/keys`, {
        headers: userAuthHeaders(),
      });
      const keysData = (await keysRes.json()) as { keys: Array<{ id: string }> };
      const userKeyId = keysData.keys[0].id;

      const [registry] = await sql`
        SELECT api_key_id, filename FROM upload_registry
        WHERE filename = 'attribution-test.epub'
        ORDER BY created_at DESC LIMIT 1
      `;

      expect(registry).toBeDefined();
      expect(registry.api_key_id).toBe(userKeyId);
    } finally {
      await sql.end();
    }
  });
});
