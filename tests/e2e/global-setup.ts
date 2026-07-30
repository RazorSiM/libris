/**
 * Playwright global setup — runs once before all tests.
 *
 * 1. Waits for the API health endpoint to respond
 * 2. Resets the database to a clean state (deletes all test data)
 * 3. Seeds an API key via /api/auth/setup
 * 4. Stores the key so fixtures can inject it into browser context
 */

import postgres from "postgres";
import { resetBullMqState } from "../../services/api-hono/src/services/queue-diagnostics.js";
import { requireDatabaseUrl, requireRedisUrl } from "./helpers/resolve-urls.js";

const API_BASE = "http://localhost:3000";
const API_KEY_ENV = "E2E_API_KEY";
const USER_KEY_ENV = "E2E_USER_API_KEY";

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
  const databaseUrl = requireDatabaseUrl();

  const sql = postgres(databaseUrl);
  try {
    // Delete in dependency order to avoid FK violations
    await sql`DELETE FROM hardcover_sync_log`;
    await sql`DELETE FROM book_metadata_candidates`;
    await sql`DELETE FROM book_files`;
    await sql`DELETE FROM reading_progress_history`;
    await sql`DELETE FROM reading_progress`;
    await sql`DELETE FROM books`;
    await sql`DELETE FROM api_keys`;
    await sql`DELETE FROM service_credentials`;
  } finally {
    await sql.end();
  }
}

async function resetBullMq(): Promise<void> {
  await resetBullMqState(requireRedisUrl());
}

async function seedApiKey(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "e2e-test-key" }),
  });

  if (res.status === 201) {
    const data = (await res.json()) as { key: string };
    return data.key;
  }

  throw new Error(`Failed to seed API key: ${res.status} ${res.statusText}`);
}

/**
 * Fallback: generate an API key directly in the database when the setup
 * endpoint is rate-limited (429). Uses bcryptjs + postgres from the workspace.
 */
async function seedApiKeyDirect(): Promise<string> {
  const databaseUrl = requireDatabaseUrl();

  const { randomBytes } = await import("node:crypto");
  const { hash } = await import("bcryptjs");

  const rawKey = randomBytes(32).toString("hex");
  const keyPrefix = rawKey.substring(0, 8);
  const keyHash = await hash(rawKey, 10);

  const sql = postgres(databaseUrl);
  try {
    await sql`INSERT INTO api_keys (key_prefix, key_hash, label, is_admin) VALUES (${keyPrefix}, ${keyHash}, 'e2e-test-key', true)`;
  } finally {
    await sql.end();
  }
  return rawKey;
}

/**
 * Create a non-admin API key via the authenticated key management endpoint.
 * Falls back to direct DB insertion if the API call fails.
 */
async function createRegularUserKey(adminKey: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
    },
    body: JSON.stringify({ label: "e2e-regular-user" }),
  });

  if (res.ok) {
    const data = (await res.json()) as { key: string };
    return data.key;
  }

  // Fallback: insert directly via DB
  return seedRegularUserKeyDirect();
}

/**
 * Fallback: generate a non-admin API key directly in the database.
 */
async function seedRegularUserKeyDirect(): Promise<string> {
  const databaseUrl = requireDatabaseUrl();

  const { randomBytes } = await import("node:crypto");
  const { hash } = await import("bcryptjs");

  const rawKey = randomBytes(32).toString("hex");
  const keyPrefix = rawKey.substring(0, 8);
  const keyHash = await hash(rawKey, 10);

  const sql = postgres(databaseUrl);
  try {
    await sql`INSERT INTO api_keys (key_prefix, key_hash, label, is_admin) VALUES (${keyPrefix}, ${keyHash}, 'e2e-regular-user', false)`;
  } finally {
    await sql.end();
  }
  return rawKey;
}

export default async function globalSetup(): Promise<void> {
  await waitForHealth();
  await resetBullMq();
  await resetDatabase();

  let apiKey: string;
  try {
    apiKey = await seedApiKey();
  } catch (err) {
    // If rate-limited, seed directly via database
    if (String(err).includes("429")) {
      apiKey = await seedApiKeyDirect();
    } else {
      throw err;
    }
  }

  // Create a non-admin key for regular user tests
  const userKey = await createRegularUserKey(apiKey);

  // Share with test processes via environment variables
  process.env[API_KEY_ENV] = apiKey;
  process.env[USER_KEY_ENV] = userKey;
}
