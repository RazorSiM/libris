/**
 * Playwright global setup — runs once before all tests.
 *
 * 1. Waits for the API health endpoint to respond
 * 2. Resets the database to a clean state, accounts included
 * 3. Bootstraps the first admin through POST /api/setup
 * 4. Creates a non-admin user through the Better Auth admin endpoint
 * 5. Mints an app password for each, for the specs that authenticate by header
 *
 * Everything here goes through real HTTP. The previous version reached into
 * the database with bcrypt to forge api_keys rows when the API said no, which
 * meant a broken auth endpoint could still produce a green run.
 */

import postgres from "postgres";
import { resetBullMqState } from "../../services/api-hono/src/services/queue-diagnostics.js";
import {
  ADMIN,
  ADMIN_COOKIE_ENV,
  ADMIN_ID_ENV,
  ADMIN_KEY_ENV,
  REGULAR_USER,
  USER_COOKIE_ENV,
  USER_ID_ENV,
  USER_KEY_ENV,
} from "./helpers/accounts.js";
import { requireDatabaseUrl, requireRedisUrl } from "./helpers/resolve-urls.js";

const API_BASE = "http://localhost:3000";

async function waitForHealth(retries = 30, intervalMs = 1000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${API_BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`API health check failed after ${retries} retries`);
}

async function resetDatabase(): Promise<void> {
  const sql = postgres(requireDatabaseUrl());
  try {
    // Delete in dependency order to avoid FK violations. books before users:
    // books.created_by is ON DELETE RESTRICT.
    await sql`DELETE FROM hardcover_sync_log`;
    await sql`DELETE FROM book_metadata_candidates`;
    await sql`DELETE FROM book_files`;
    await sql`DELETE FROM reading_progress_history`;
    await sql`DELETE FROM reading_progress`;
    await sql`DELETE FROM reading_aggregate`;
    await sql`DELETE FROM upload_registry`;
    await sql`DELETE FROM books`;
    await sql`DELETE FROM service_credentials`;
    await sql`DELETE FROM kosync_credentials`;
    await sql`DELETE FROM api_keys`;
    await sql`DELETE FROM sessions`;
    await sql`DELETE FROM accounts`;
    await sql`DELETE FROM verifications`;
    await sql`DELETE FROM users`;
    // The bootstrap lease lives here; leaving it behind makes POST /api/setup
    // 409 for the next minute and the whole run fails at step 3.
    await sql`DELETE FROM app_settings`;
  } finally {
    await sql.end();
  }
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Better Auth rejects a state-changing request with no Origin header
      // (MISSING_OR_NULL_ORIGIN) — that is its CSRF defence, and it is why a
      // browser can sign in here but a bare Node fetch cannot. Setting it
      // explicitly is what a real client does implicitly; the value has to be
      // in trustedOrigins (see lib/auth.ts).
      Origin: API_BASE,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Create the first admin. Only possible while the users table is empty. */
async function bootstrapAdmin(): Promise<string> {
  const res = await post("/api/setup", {
    email: ADMIN.email,
    password: ADMIN.password,
    name: ADMIN.name,
  });
  if (res.status !== 201) {
    throw new Error(`Bootstrap failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { id: string }).id;
}

/** Sign in over HTTP and return the cookie header to replay. */
async function signIn(email: string, password: string): Promise<string> {
  const res = await post("/api/auth/sign-in/email", { email, password });
  if (!res.ok) {
    throw new Error(`Sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const cookies = res.headers.getSetCookie();
  if (cookies.length === 0) {
    throw new Error(`Sign-in for ${email} returned no Set-Cookie`);
  }
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

/**
 * Create the non-admin user.
 *
 * Through the admin plugin, not sign-up: self-registration is disabled
 * (emailAndPassword.disableSignUp), which is the whole point of the household
 * account model.
 */
async function createRegularUser(adminCookie: string): Promise<string> {
  const res = await post(
    "/api/auth/admin/create-user",
    {
      email: REGULAR_USER.email,
      password: REGULAR_USER.password,
      name: REGULAR_USER.name,
      role: "user",
    },
    adminCookie,
  );
  if (!res.ok) {
    throw new Error(`Creating the regular user failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { user: { id: string } }).user.id;
}

/** Mint an app password for the signed-in user. */
async function createAppPassword(cookie: string, name: string): Promise<string> {
  const res = await post("/api/app-passwords", { name }, cookie);
  if (res.status !== 201) {
    throw new Error(`Creating app password "${name}" failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { key: string }).key;
}

export default async function globalSetup(): Promise<void> {
  await waitForHealth();
  await resetBullMqState(requireRedisUrl());
  await resetDatabase();

  const adminId = await bootstrapAdmin();
  const adminCookie = await signIn(ADMIN.email, ADMIN.password);
  const userId = await createRegularUser(adminCookie);
  const userCookie = await signIn(REGULAR_USER.email, REGULAR_USER.password);

  process.env[ADMIN_ID_ENV] = adminId;
  process.env[USER_ID_ENV] = userId;
  process.env[ADMIN_KEY_ENV] = await createAppPassword(adminCookie, "e2e-admin-key");
  process.env[USER_KEY_ENV] = await createAppPassword(userCookie, "e2e-user-key");
  // Kept, not discarded: app passwords are scoped out of the admin, account and
  // credential routes (libris-5ng.28), so specs touching those need a session.
  process.env[ADMIN_COOKIE_ENV] = adminCookie;
  process.env[USER_COOKIE_ENV] = userCookie;
}
