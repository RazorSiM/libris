import { copyFile, mkdir, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { getAdminCookie, getAdminUserId, getUserCookie } from "./accounts.js";
import { requireDatabaseUrl } from "./resolve-urls.js";

export const API_BASE = "http://localhost:3000";

/** The admin's app password, for requests that authenticate by header. */
export function getApiKey(): string {
  const key = process.env.E2E_API_KEY;
  if (!key) throw new Error("E2E_API_KEY not set — did global-setup.ts run?");
  return key;
}

/**
 * Returns the non-admin user's API key from E2E_USER_API_KEY.
 */
export function getUserApiKey(): string {
  const key = process.env.E2E_USER_API_KEY;
  if (!key) throw new Error("E2E_USER_API_KEY not set — did global-setup.ts run?");
  return key;
}

/**
 * Returns Bearer auth headers for API requests (admin).
 */
export function authHeaders(): { Authorization: string } {
  return { Authorization: `Bearer ${getApiKey()}` };
}

/** Authenticate requests to the conditionally mounted test-support router. */
export function testRouteHeaders(): { "X-Test-Token": string } {
  const token = process.env.TEST_ROUTE_TOKEN;
  if (!token) throw new Error("TEST_ROUTE_TOKEN not set for the E2E server");
  return { "X-Test-Token": token };
}

/**
 * Returns Bearer auth headers for API requests (regular user).
 */
export function userAuthHeaders(): { Authorization: string } {
  return { Authorization: `Bearer ${getUserApiKey()}` };
}

/**
 * Session headers for the routes an app password is refused on:
 * anything under /api/auth/, /api/app-passwords, /api/credentials, and every
 * admin route including /api/jobs.
 *
 * Reach for authHeaders() everywhere else — most of the suite is exercising the
 * ordinary library surface, which is exactly what app passwords are for.
 */
export function sessionHeaders(): { cookie: string } {
  return { cookie: getAdminCookie() };
}

/** Session headers for the non-admin. */
export function userSessionHeaders(): { cookie: string } {
  return { cookie: getUserCookie() };
}

/**
 * The admin's USER id — what owned rows point at.
 *
 * Was getAdminUserId(), which fetched the admin's api key id from the removed
 * /api/auth/keys. Ownership hangs off the person now, and a credential id is
 * not an identity, so seeding reading progress against one would produce rows
 * no query can find.
 */
export { getAdminUserId, getRegularUserId, getAdminCookie, getUserCookie } from "./accounts.js";

/**
 * Every disposable account this worker created and has not removed yet.
 *
 * "Disposable" was only ever true of the credentials, never of the row: the
 * account outlived the test that made it and stayed in the install for the rest
 * of the run. That is invisible for a `user`, and load-bearing for an `admin` —
 * a leaked one is a second admin, which is exactly the state
 * "the last admin cannot be demoted out of existence" (auth.spec.ts) exists to
 * rule out. It failed because account.spec.ts had left `self-setpw` behind.
 *
 * Files run one at a time (`workers: 1`, `fullyParallel: false`), so a
 * `test.afterAll(disposeAccounts)` in the spec that creates them is enough to
 * keep the leak inside the file that owns it.
 */
const disposableAccountIds = new Set<string>();

/**
 * Create a throwaway account and return the credentials to sign in with.
 *
 * Any spec that changes a password needs one of these. Doing it to ADMIN or
 * REGULAR_USER rewrites the password the rest of the suite signs in with, and
 * "sign out everywhere else" goes further still — it deletes every session that
 * account owns, including the storageState the whole run shares.
 *
 * The `origin` header is not optional: Better Auth rejects a state-changing
 * request without one, and the failure reads as a permissions problem.
 *
 * Call `disposeAccounts()` from a `test.afterAll` in the spec that uses this.
 */
export async function createDisposableAccount(
  label: string,
  role: "user" | "admin" = "user",
): Promise<{ email: string; password: string; name: string; id: string }> {
  const email = `${label}-${Date.now()}@example.test`;
  const account = { email, password: `${label}-correct-horse-battery`, name: `Throwaway ${label}` };

  const res = await fetch(`${API_BASE}/api/auth/admin/create-user`, {
    method: "POST",
    headers: { ...sessionHeaders(), "Content-Type": "application/json", origin: API_BASE },
    body: JSON.stringify({ ...account, role }),
  });
  if (!res.ok) {
    throw new Error(`Could not create ${email}: ${res.status} ${await res.text()}`);
  }
  const { user } = (await res.json()) as { user: { id: string } };
  disposableAccountIds.add(user.id);
  return { ...account, id: user.id };
}

/**
 * Remove every account `createDisposableAccount` made in this worker.
 *
 * Best-effort per account: a spec may already have deleted one, or removed the
 * session this call authenticates with, and neither should turn a passing file
 * into a failing teardown. Goes through the admin plugin so sessions and app
 * passwords go with the row.
 */
export async function disposeAccounts(): Promise<void> {
  const ids = [...disposableAccountIds];
  disposableAccountIds.clear();
  for (const userId of ids) {
    await fetch(`${API_BASE}/api/auth/admin/remove-user`, {
      method: "POST",
      headers: { ...sessionHeaders(), "Content-Type": "application/json", origin: API_BASE },
      body: JSON.stringify({ userId }),
    }).catch(() => undefined);
  }
}

/**
 * Delete an account by address, if one exists. Returns whether it did.
 *
 * For specs that use a FIXED account rather than a disposable one. Playwright
 * restarts a serial group from its first test on retry and CI runs with
 * `retries: 2`, so a leftover account from the previous attempt is the normal
 * case, not the exceptional one — and a silent one, because a `create-user`
 * that 409s still leaves behind the list row such a spec tends to assert on.
 *
 * Goes through the admin plugin rather than SQL: `remove-user` also drops the
 * account's sessions and app passwords, which a bare `DELETE FROM users` would
 * leave pointing at nothing.
 */
export async function deleteUserByEmail(email: string): Promise<boolean> {
  const listed = await fetch(`${API_BASE}/api/auth/admin/list-users?limit=200`, {
    headers: sessionHeaders(),
  });
  if (!listed.ok) {
    throw new Error(`Could not list users: ${listed.status} ${await listed.text()}`);
  }
  const { users } = (await listed.json()) as { users: Array<{ id: string; email: string }> };
  const match = users.find((user) => user.email === email);
  if (!match) return false;

  const removed = await fetch(`${API_BASE}/api/auth/admin/remove-user`, {
    method: "POST",
    headers: { ...sessionHeaders(), "Content-Type": "application/json", origin: API_BASE },
    body: JSON.stringify({ userId: match.id }),
  });
  if (!removed.ok) {
    throw new Error(`Could not remove ${email}: ${removed.status} ${await removed.text()}`);
  }
  return true;
}

/**
 * Reset DB between tests by calling POST /__test/cleanup.
 * Deletes all books, files, metadata candidates, reading progress, and API keys.
 * Also clears Redis storage.
 *
 * NOTE: Requires the API server to be running in test mode (import.meta.test).
 */
export async function cleanup(options: { includeAuth?: boolean } = {}): Promise<void> {
  // Content only by default. Wiping accounts would sign the whole run out —
  // every spec shares one storageState captured in the setup project.
  const res = await fetch(`${API_BASE}/__test/cleanup`, {
    method: "POST",
    headers: { ...testRouteHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ includeAuth: options.includeAuth ?? false }),
  });
  if (!res.ok) {
    throw new Error(`Cleanup failed: ${res.status} ${res.statusText}`);
  }
}

/**
 * Seed a book directly via the test API in the desired status.
 *
 * NOTE: Requires the API server to be running in test mode (import.meta.test).
 */
export async function seedBook(
  status: "inbox" | "review" | "organized" = "organized",
  overrides: {
    title?: string;
    author?: string;
    description?: string;
    genres?: string[];
  } = {},
): Promise<{ id: string; title: string }> {
  const res = await fetch(`${API_BASE}/__test/seed-books`, {
    method: "POST",
    headers: { ...testRouteHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      books: [
        {
          title: overrides.title ?? `Test Book (${status})`,
          author: overrides.author ?? "Test Author",
          description: overrides.description,
          genres: overrides.genres ?? [],
          status,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Seed book failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    inserted: Array<{ id: string; title: string }>;
  };
  return data.inserted[0];
}

/**
 * Poll /api/jobs/status until the given queue has no active or waiting jobs.
 */
export async function waitForJob(
  queueName: string,
  { timeoutMs = 30_000, intervalMs = 500 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Session, not Bearer: /api/jobs is admin-policy and app passwords are
    // refused there.
    const res = await fetch(`${API_BASE}/api/jobs/status`, { headers: sessionHeaders() });
    if (res.ok) {
      const data = (await res.json()) as {
        queues: Record<
          string,
          { waiting: number; active: number; completed: number; failed: number }
        >;
      };
      const queue = data.queues[queueName];
      if (queue && queue.waiting === 0 && queue.active === 0) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for queue "${queueName}" to complete after ${timeoutMs}ms`);
}

/**
 * Copy a test fixture file to the inbox directory.
 * Returns the destination path.
 */
export async function copyToInbox(fixturePath: string): Promise<string> {
  const inboxPath = process.env.LIBRIS_INBOX_PATH;
  if (!inboxPath) {
    throw new Error("LIBRIS_INBOX_PATH not set — cannot copy to inbox");
  }
  await mkdir(inboxPath, { recursive: true });
  const dest = join(inboxPath, basename(fixturePath));
  await copyFile(fixturePath, dest);
  return dest;
}

/**
 * Remove all files from the inbox directory (prevents stale chokidar events).
 */
export async function cleanInboxDir(): Promise<void> {
  const inboxPath = process.env.LIBRIS_INBOX_PATH;
  if (!inboxPath) return;
  try {
    const entries = await readdir(inboxPath);
    await Promise.all(entries.map((f) => unlink(join(inboxPath, f)).catch(() => {})));
  } catch {
    // Directory may not exist yet
  }
}

/**
 * Get a postgres client for direct DB access in tests.
 */
export function getSql() {
  return postgres(requireDatabaseUrl());
}

/**
 * Insert one `book_metadata_candidates` row.
 *
 * Centralised because the obvious way to write the jsonb column is wrong, and
 * was wrong here for a long time without anything noticing.
 * `${JSON.stringify(obj)}::jsonb` binds a JS *string*, and postgres-js
 * serialises a jsonb parameter with `JSON.stringify` — so the value lands as a
 * jsonb STRING (`jsonb_typeof` = 'string') holding the encoded object, not as a
 * jsonb object. `sql.json(obj)` (or a bare object) is the correct form.
 *
 * drizzle-orm 1.0.0-beta hid the difference: `PgJsonb.mapFromDriverValue`
 * JSON.parse'd anything that came back as a string, which un-did the double
 * encoding on read. 1.0.0-rc moved jsonb onto the codec system with no
 * read-side normalisation, so the string now reaches the API response as a
 * string, `MetadataFieldPicker` finds no field on it, and every review page
 * renders "No metadata found — enter manually" with `Approve (0)`.
 *
 * The `jsonb_typeof` assertion is the tripwire: it fails at seed time, in the
 * spec that seeded it, instead of as an unexplained empty picker later.
 */
export async function seedMetadataCandidate(
  bookId: string,
  source: string,
  confidence: number,
  normalized: Record<string, unknown>,
): Promise<string> {
  const sql = getSql();
  try {
    // postgres-js types `sql.json` as its own `JSONValue`, which an open
    // `Record<string, unknown>` does not structurally satisfy. The value is
    // JSON — it is about to be serialised as such.
    const asJson = normalized as Parameters<typeof sql.json>[0];
    const [row] = await sql`
      INSERT INTO book_metadata_candidates (book_id, source, confidence, normalized)
      VALUES (${bookId}, ${source}, ${confidence}, ${sql.json(asJson)})
      RETURNING id, jsonb_typeof(normalized) AS normalized_type
    `;
    if (row.normalized_type !== "object") {
      throw new Error(
        `Seeded candidate ${source} for ${bookId} stored normalized as jsonb ` +
          `'${row.normalized_type}', not 'object' — the API will emit a string ` +
          `and the metadata picker will show no sources.`,
      );
    }
    return row.id as string;
  } finally {
    await sql.end();
  }
}

/**
 * Navigate to a path using page.goto() — auth cookies are in context via storageState.
 * Waits for networkidle to ensure Nuxt SSR hydration completes before the caller
 * interacts with buttons/forms on the target page.
 */
export async function goPath(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

/**
 * Clear the server route cache so /api/library, /api/inbox etc. serve fresh data.
 * Calls the test-only POST /__test/invalidate-cache endpoint.
 */
export async function invalidateServerCache(): Promise<void> {
  await fetch(`${API_BASE}/__test/invalidate-cache`, {
    method: "POST",
    headers: testRouteHeaders(),
  });
}

/**
 * Delete all books and related data via direct DB.
 * Covers all dependent tables to avoid FK constraint violations.
 */
export async function deleteAllBooks(): Promise<void> {
  const sql = getSql();
  try {
    await sql`DELETE FROM reading_progress_history`;
    await sql`DELETE FROM reading_progress`;
    await sql`DELETE FROM hardcover_sync_log`;
    await sql`DELETE FROM book_metadata_candidates`;
    await sql`DELETE FROM book_files`;
    await sql`DELETE FROM books`;
  } finally {
    await sql.end();
  }
  // Clear server cache so /api/library and /api/inbox serve fresh data
  await invalidateServerCache();
}

/**
 * Wait for all BullMQ queues to drain (no active or waiting jobs).
 * Call this after tests that trigger the real ingestion pipeline.
 */
export async function waitForAllQueuesIdle(timeoutMs = 60_000): Promise<void> {
  const queues = ["book-detected", "book-parse-file", "book-fetch-metadata", "book-organize"];
  for (const q of queues) {
    await waitForJob(q, { timeoutMs });
  }
}

/**
 * Insert a book directly into the database in organized status.
 * Unified superset of all seedOrganizedBook variants across spec files.
 * Returns the book id.
 */
export async function seedOrganizedBook(
  overrides: {
    title?: string;
    author?: string;
    description?: string;
    genres?: string[];
    publisher?: string;
    publishedYear?: number;
    language?: string;
    pageCount?: number;
    isbn10?: string;
    isbn13?: string;
    coverPath?: string;
    /** Whose book this is. Defaults to the admin — see the INSERT below. */
    createdBy?: string;
  } = {},
): Promise<string> {
  const sql = getSql();
  try {
    const genres = overrides.genres ?? [];
    const genresLiteral = `{${genres.map((g) => `"${g}"`).join(",")}}`;
    // created_by is NOT NULL since the cutover migration, so a seeded book must
    // name an owner. Defaulting to the admin mirrors what the server does with
    // an unattributed file, and keeps every caller that does not care about
    // ownership working unchanged.
    const [row] = await sql`
      INSERT INTO books (
        status, title, author, description, genres,
        publisher, published_year, language, page_count,
        isbn_10, isbn_13, cover_path, created_by, approved_at
      )
      VALUES (
        'organized',
        ${overrides.title ?? "Test Book"},
        ${overrides.author ?? "Test Author"},
        ${overrides.description ?? null},
        ${genresLiteral}::text[],
        ${overrides.publisher ?? null},
        ${overrides.publishedYear ?? null},
        ${overrides.language ?? null},
        ${overrides.pageCount ?? null},
        ${overrides.isbn10 ?? null},
        ${overrides.isbn13 ?? null},
        ${overrides.coverPath ?? null},
        ${overrides.createdBy ?? getAdminUserId()},
        NOW()
      )
      RETURNING id
    `;
    return row.id;
  } finally {
    await sql.end();
  }
}

/**
 * Seed a book_file for a given book. Returns the file id.
 */
export async function seedBookFile(
  bookId: string,
  overrides: {
    format?: string;
    originalName?: string;
    fileSize?: number;
    storagePath?: string;
  } = {},
): Promise<string> {
  const sql = getSql();
  try {
    const contentHash = `hash-${bookId}-${Date.now()}`;
    const [row] = await sql`
      INSERT INTO book_files (book_id, format, original_name, file_size, storage_path, content_hash)
      VALUES (
        ${bookId},
        ${overrides.format ?? "epub"},
        ${overrides.originalName ?? "book.epub"},
        ${overrides.fileSize ?? 1048576},
        ${overrides.storagePath ?? null},
        ${contentHash}
      )
      RETURNING id
    `;
    return row.id;
  } finally {
    await sql.end();
  }
}

/**
 * Poll the inbox API until a book matching `titleFragment` appears.
 */
export async function waitForBookInInbox(
  titleFragment: string,
  timeoutMs = 45_000,
): Promise<{ id: string; status: string; title: string }> {
  const headers = authHeaders();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/api/inbox?limit=50&_t=${Date.now()}`, { headers });
    if (res.ok) {
      const { data } = (await res.json()) as {
        data: Array<{ id: string; status: string; title: string | null }>;
      };
      const match = data.find((b) => b.title?.includes(titleFragment));
      if (match) return { id: match.id, status: match.status, title: match.title! };
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Timed out waiting for "${titleFragment}" in inbox (${timeoutMs}ms)`);
}
