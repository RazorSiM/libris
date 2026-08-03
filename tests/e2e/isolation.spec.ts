/**
 * E2E: what two people in one household see of each other.
 *
 * Salvaged from multi-user.spec.ts and multi-user-auth.spec.ts when those were
 * retired. Most of what they held died with the old auth model
 * — an admin-only "API Keys" tab, an API-key login box, OPDS username/password
 * forms — and auth.spec.ts covers the replacements. These are the tests that
 * outlived it: they check features that still exist and are covered nowhere
 * else.
 *
 * Why these belong at E2E rather than lower down:
 *
 *   • Ownership controls are a UI fact. auth-access-control.test.ts proves the
 *     API refuses a non-owner; only a browser can prove the button is absent,
 *     and a hidden-but-present control is a real bug.
 *   • Stats isolation CANNOT be checked below this level. /api/stats runs raw
 *     SQL whose result shape differs under PGlite, so the integration suite
 *     deliberately asserts at the data layer instead (see the note in
 *     services/api-hono/tests/multi-user.test.ts). Real Postgres in a real
 *     browser is the only place the endpoint's per-user scoping is exercised.
 *   • Query-cache clearing on sign-out is frontend state, invisible to the API.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NEVER sign out on a shared fixture in this file.
 * ─────────────────────────────────────────────────────────────────────────
 * authedPage/adminPage/userPage carry the suite's storageState. Logging one of
 * them out revokes that session SERVER-side, and every spec that sorts after
 * this one then runs signed out. That is exactly how the old
 * multi-user-auth.spec.ts poisoned everything from `opds` onward — it clicked
 * Logout on authedPage and then failed to log back in. The sign-out test below
 * uses its own anonymous context and signs in for itself.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  API_BASE,
  authHeaders,
  deleteAllBooks,
  getAdminUserId,
  getRegularUserId,
  getSql,
  invalidateServerCache,
  seedBookFile,
  seedOrganizedBook,
} from "./helpers";
import { ADMIN } from "./helpers/accounts.js";
import { signInThroughUi } from "./helpers/sign-in.js";

// ── Helpers ─────────────────────────────────────────────────────────

async function goHome(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

async function goStats(page: Page): Promise<void> {
  await page.goto("/stats");
  await page.waitForLoadState("networkidle");
}

async function goSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
}

/** Point a book's file at a known content hash, which is what progress joins on. */
async function setContentHash(fileId: string, hash: string): Promise<void> {
  const sql = getSql();
  try {
    await sql`UPDATE book_files SET content_hash = ${hash} WHERE id = ${fileId}`;
  } finally {
    await sql.end();
  }
}

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

/** A finished book (98%) owned by one person, with progress and history. */
async function seedFinishedBook(ownerId: string, title: string, genre: string): Promise<void> {
  const bookId = await seedOrganizedBook({ title, genres: [genre], pageCount: 300 });
  const hash = `hash-${title.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}`;
  await setContentHash(await seedBookFile(bookId), hash);
  await seedProgressForUser(bookId, hash, ownerId, 0.98);
  await seedProgressHistory(bookId, hash, ownerId, 0.98);
}

// ── Ownership is visible in the UI, not just enforced by the API ────

test.describe("book ownership controls", () => {
  test.describe.configure({ mode: "serial" });

  let adminBookId: string;

  test.beforeAll(async () => {
    await deleteAllBooks();
    adminBookId = await seedOrganizedBook({
      title: "Admin's Library Book",
      author: "Admin Author",
      createdBy: getAdminUserId(),
    });
    await invalidateServerCache();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("the owner gets the actions menu", async ({ adminPage: page }) => {
    await page.goto(`/library/${adminBookId}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("book-actions-btn")).toBeVisible({ timeout: 10_000 });
  });

  test("someone else can read the book but gets no controls", async ({ userPage: page }) => {
    // The library is shared — a household member should see the book. What they
    // must not get is a way to edit or delete it. The API refuses them either
    // way (auth-access-control.test.ts), but offering a button that 403s is a
    // bug in its own right.
    await page.goto(`/library/${adminBookId}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Admin's Library Book" })).toBeVisible({
      timeout: 10_000,
    });

    await expect(page.getByTestId("book-actions-btn")).not.toBeVisible();
    await expect(page.getByRole("button", { name: /edit/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /delete/i })).not.toBeVisible();
  });
});

// ── Two people, one book, two different places in it ────────────────

test.describe("reading progress is per person", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await deleteAllBooks();

    const sharedBookId = await seedOrganizedBook({
      title: "Shared Progress Book",
      author: "Progress Author",
      pageCount: 400,
    });
    const contentHash = `hash-shared-${Date.now()}`;
    await setContentHash(
      await seedBookFile(sharedBookId, { format: "epub", originalName: "shared.epub" }),
      contentHash,
    );

    // The same book, the same document hash, two owners. Before the cutover
    // this pair could not exist: the unique constraint was on the credential,
    // so a second person reading the same file overwrote the first.
    await seedProgressForUser(sharedBookId, contentHash, getAdminUserId(), 0.75);
    await seedProgressForUser(sharedBookId, contentHash, getRegularUserId(), 0.25);

    await invalidateServerCache();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("the admin's dashboard shows the admin's place", async ({ adminPage: page }) => {
    await goHome(page);

    const readingSection = page.getByTestId("currently-reading-section");
    await expect(readingSection).toBeVisible({ timeout: 10_000 });
    await expect(readingSection.getByText("75%")).toBeVisible();
  });

  test("and the other member's dashboard shows theirs", async ({ userPage: page }) => {
    await goHome(page);

    const readingSection = page.getByTestId("currently-reading-section");
    await expect(readingSection).toBeVisible({ timeout: 10_000 });
    await expect(readingSection.getByText("25%")).toBeVisible();
  });
});

// ── Stats: the only place per-user scoping is checked for real ──────

test.describe("stats are per person", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await deleteAllBooks();

    for (let i = 0; i < 3; i++) {
      await seedFinishedBook(getAdminUserId(), `Admin Finished ${i + 1}`, "Fantasy");
    }
    await seedFinishedBook(getRegularUserId(), "User Finished 1", "Sci-Fi");

    await invalidateServerCache();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("the admin sees only their own three", async ({ adminPage: page }) => {
    await goStats(page);
    await expect(page.getByTestId("stat-value-finished-all-time")).toHaveText("3", {
      timeout: 10_000,
    });
  });

  test("the other member sees only their own one", async ({ userPage: page }) => {
    await goStats(page);
    await expect(page.getByTestId("stat-value-finished-all-time")).toHaveText("1", {
      timeout: 10_000,
    });
  });
});

// ── Connections form ────────────────────────────────────────────────

test.describe("credential form", () => {
  test("rejects a weak KoSync password before sending it", async ({ authedPage: page }) => {
    await goSettings(page);
    await page.getByRole("tab", { name: "Connections", exact: true }).click();
    await page.getByTestId("kosync-username-input").fill("kosync-weak-password");
    await page.getByTestId("kosync-password-input").fill("short");

    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/credentials/kosync") && request.method() === "PUT") {
        requests.push(request.url());
      }
    });

    await page.getByTestId("kosync-save-btn").click();

    await expect(page.getByText("At least 12 characters", { exact: true })).toBeVisible();
    expect(requests).toEqual([]);
  });

  test("a saved KoSync username survives a reload", async ({ authedPage: page }) => {
    // Regression guard for a v-model bug where the field rendered the saved
    // value once and then lost it on the next fetch. Its OPDS twin retired with
    // the OPDS credential form — readers hold an app password now — but KoSync
    // still has its own username and password.
    await goSettings(page);
    await page.getByRole("tab", { name: "Connections", exact: true }).click();

    await page.getByTestId("kosync-username-input").fill("kosync-persist-user");
    await page.getByTestId("kosync-password-input").fill("kosync-persist-pass");

    const savePromise = page.waitForResponse(
      (resp) => resp.url().includes("/api/credentials/kosync") && resp.request().method() === "PUT",
    );
    await page.getByTestId("kosync-save-btn").click();
    expect((await savePromise).ok()).toBe(true);

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "Connections", exact: true }).click();

    // Checked first, so a failure says which side is wrong: if the API has the
    // username and the input is empty, the form is not repopulating; if the API
    // has nothing, the save did not persist.
    const stored = await page.request.get(`${API_BASE}/api/credentials/kosync`);
    expect(await stored.json()).toMatchObject({
      configured: true,
      username: "kosync-persist-user",
    });

    await expect(page.getByTestId("kosync-username-input")).toHaveValue("kosync-persist-user", {
      timeout: 10_000,
    });
  });
});

// ── Signing out must not leave one person's data in another's cache ─

test.describe("sign-out clears the query cache", () => {
  // Anonymous, and signs in for itself. See the warning at the top of this
  // file: logging out a shared fixture revokes the suite's session.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    await deleteAllBooks();
    await seedOrganizedBook({ title: "Cache Test Book", author: "Cache Author" });
    await invalidateServerCache();
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("the next sign-in refetches instead of serving the previous session's data", async ({
    page,
  }) => {
    // The cache is keyed by query, not by user, so a stale entry surviving
    // sign-out means the next person to use the browser sees the last person's
    // library. Cheap to get wrong and invisible from the API.
    await signInThroughUi(page, ADMIN.email, ADMIN.password);

    await page.goto("/library");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Cache Test Book")).toBeVisible({ timeout: 10_000 });

    await goSettings(page);
    await page.getByTestId("logout-btn").click();
    await expect(page).toHaveURL(/\/login/);

    await signInThroughUi(page, ADMIN.email, ADMIN.password);

    // A real request, not a cache replay.
    const libraryFetch = page.waitForResponse(
      (resp) => resp.url().includes("/api/library") && resp.status() === 200,
    );
    await page.goto("/library");
    expect((await libraryFetch).ok()).toBe(true);
    await expect(page.getByText("Cache Test Book")).toBeVisible({ timeout: 10_000 });
  });
});

// ── Upload collisions ───────────────────────────────────────────────

test.describe("upload collision safety", () => {
  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("the same filename twice does not clobber the first upload", async () => {
    // Nothing to do with auth — it was parked in an auth spec. Two people (or
    // one impatient one) sending "book.epub" at the same moment must not have
    // the second overwrite the first on disk. inbox.test.ts covers the rename
    // itself; this covers the concurrent case end to end.
    const fixturePath = join(import.meta.dirname, "fixtures", "test-book.epub");
    const fileBuffer = await readFile(fixturePath);
    const blob = new Blob([fileBuffer], { type: "application/epub+zip" });

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

    const data1 = (await res1.json()) as { uploaded: Array<{ filename: string }> };
    const data2 = (await res2.json()) as { uploaded: Array<{ filename: string }> };
    expect(data1.uploaded).toHaveLength(1);
    expect(data2.uploaded).toHaveLength(1);
  });
});
