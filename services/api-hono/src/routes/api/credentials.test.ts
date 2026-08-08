import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { createMemoryKVStore } from "../../services/kv-store.js";
import { createApp } from "../../app.js";
import { createTestAuth, createTestDb, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";
import { unsealToken } from "../../shared/auth.js";

// GET /api/hardcover/status verifies the stored token against the real API.
// Stub it so the assertion is about WHICH token each user's request resolves
// to, not about the network.
const verifyTokenMock = vi.fn();
vi.mock("../../lib/hardcover/client.js", () => ({
  verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
}));

vi.mock("../../services/redis.js", () => ({
  isRedisHealthy: async () => ({ ok: true, latencyMs: 1 }),
  getSharedRedis: () => null,
}));

vi.mock("../../services/queue.js", () => ({
  getQueues: () => ({ close: async () => {} }),
  getAllQueues: () => new Map(),
  registerQueue: () => {},
}));

vi.mock("../../services/event-bus.js", () => ({
  isEventBusHealthy: () => ({ ok: true }),
  initEventBus: () => {},
  getEventBus: () => ({ publish: () => {} }),
}));

const TEST_ENV: Env = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "pglite://",
  REDIS_URL: "redis://localhost:6379",
  LIBRIS_INBOX_PATH: "/tmp/libris-test-inbox",
  LIBRIS_LIBRARY_PATH: "/tmp/libris-test-library",
  LIBRIS_COVER_FETCH_ALLOWLIST: [],
  API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
  BETTER_AUTH_URL: "",
  LIBRIS_COOKIE_SECURE: "0",
  MIGRATIONS_PATH: "./migrations",
  TRUST_PROXY_HEADERS: "0",
  LIBRIS_TRUSTED_PROXIES: [],
  E2E_TEST: "",
  LOG_LEVEL: "info",
  LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
  LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
  LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 30,
  LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
  LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 10_000,
  LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 30_000,
  LIBRIS_HTTP_IDLE_TIMEOUT_MS: 30_000,
};

const PASSWORD = "correct-horse-battery";

let pglite: PGlite;
let db: TestDb;

function createTestApp() {
  const auth = createTestAuth(db, TEST_ENV);
  const { app } = createApp({
    services: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      queues: {
        bookDetected: { add: async () => ({}) },
        bookParseFile: { add: async () => ({}) },
        bookFetchMetadata: { add: async () => ({}) },
        bookOrganize: { add: async () => ({}) },
        close: async () => {},
      },
      redisStorage: createMemoryKVStore(),
      cacheStorage: createMemoryKVStore(),
      auth,
      shutdown: async () => {},
    },
    env: TEST_ENV,
  });
  return { app, auth };
}

type TestApp = ReturnType<typeof createTestApp>["app"];

/**
 * A signed-in user. /api/credentials is on the app-password deny list
 * (shared/route-policy.ts), so these flows need a real cookie session.
 */
async function createSignedInUser(
  auth: ReturnType<typeof createTestApp>["auth"],
  email: string,
): Promise<{ id: string; cookie: string }> {
  const created = await auth.api.createUser({
    body: { email, password: PASSWORD, name: email.split("@")[0]!, role: "user" },
  });
  const { headers } = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return {
    id: created.user.id,
    cookie: headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
}

/** The exact call SettingsKosync.vue makes. */
function claimKosync(app: TestApp, cookie: string, username: string) {
  return app.request("/api/credentials/kosync", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ username, password: "a-long-enough-kosync-secret" }),
  });
}

/** The exact call SettingsHardcover.vue makes: username is the literal "hardcover". */
function connectHardcover(app: TestApp, cookie: string, token: string) {
  return app.request("/api/credentials/hardcover", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ username: "hardcover", password: token }),
  });
}

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  verifyTokenMock.mockReset();
  await db.delete(schema.serviceCredentials);
  await db.delete(schema.kosyncCredentials);
  await db.delete(schema.apiKeys);
  await db.delete(schema.sessions);
  await db.delete(schema.accounts);
  await db.delete(schema.users);
});

describe("PUT /api/credentials/hardcover", () => {
  it("lets two different users each connect Hardcover", async () => {
    // service_credentials carried a GLOBAL unique index on
    // (service, username), and the frontend sends username "hardcover" for
    // everyone. Before the index was dropped, alice succeeded and bob's insert
    // raised 23505 with nothing catching it — a 500.
    const { app, auth } = createTestApp();
    const alice = await createSignedInUser(auth, "alice@example.test");
    const bob = await createSignedInUser(auth, "bob@example.test");

    const aliceRes = await connectHardcover(app, alice.cookie, "alice-hardcover-token");
    expect(aliceRes.status).toBe(200);

    const bobRes = await connectHardcover(app, bob.cookie, "bob-hardcover-token");
    expect(bobRes.status).toBe(200);

    const rows = await db
      .select({ userId: schema.serviceCredentials.userId })
      .from(schema.serviceCredentials)
      .where(eq(schema.serviceCredentials.service, "hardcover"));
    expect(rows.map((r) => r.userId).sort()).toEqual([alice.id, bob.id].sort());
  });

  it("stores each user's own token, not the first one written", async () => {
    const { app, auth } = createTestApp();
    const alice = await createSignedInUser(auth, "alice@example.test");
    const bob = await createSignedInUser(auth, "bob@example.test");

    await connectHardcover(app, alice.cookie, "alice-hardcover-token");
    await connectHardcover(app, bob.cookie, "bob-hardcover-token");

    for (const [user, expected] of [
      [alice, "alice-hardcover-token"],
      [bob, "bob-hardcover-token"],
    ] as const) {
      const [row] = await db
        .select({ passwordHash: schema.serviceCredentials.passwordHash })
        .from(schema.serviceCredentials)
        .where(
          and(
            eq(schema.serviceCredentials.service, "hardcover"),
            eq(schema.serviceCredentials.userId, user.id),
          ),
        );
      expect(await unsealToken(row!.passwordHash, TEST_ENV.API_SECRET_KEY)).toBe(expected);
    }
  });

  it("reports each user's own connection from GET /api/hardcover/status", async () => {
    const { app, auth } = createTestApp();
    const alice = await createSignedInUser(auth, "alice@example.test");
    const bob = await createSignedInUser(auth, "bob@example.test");

    await connectHardcover(app, alice.cookie, "alice-hardcover-token");
    await connectHardcover(app, bob.cookie, "bob-hardcover-token");

    // Resolve the Hardcover account name from whichever token was presented, so
    // a cross-user leak shows up as the wrong username rather than passing.
    verifyTokenMock.mockImplementation((token: string) =>
      Promise.resolve({ ok: true, data: { username: `hc-${token.split("-")[0]}` } }),
    );

    const aliceStatus = await app.request("/api/hardcover/status", {
      headers: { cookie: alice.cookie },
    });
    expect(aliceStatus.status).toBe(200);
    expect(await aliceStatus.json()).toMatchObject({ connected: true, username: "hc-alice" });

    const bobStatus = await app.request("/api/hardcover/status", {
      headers: { cookie: bob.cookie },
    });
    expect(bobStatus.status).toBe(200);
    expect(await bobStatus.json()).toMatchObject({ connected: true, username: "hc-bob" });
  });

  it("returns 409, not 500, when a unique constraint rejects the write", async () => {
    // Independent of the dropped index: prove the handler cannot leak a raw
    // 23505 again. A temporary index reintroduces exactly the old shape.
    await pglite.exec(
      `CREATE UNIQUE INDEX tmp_service_username_uniq ON service_credentials (service, username)`,
    );
    try {
      const { app, auth } = createTestApp();
      const alice = await createSignedInUser(auth, "alice@example.test");
      const bob = await createSignedInUser(auth, "bob@example.test");

      expect((await connectHardcover(app, alice.cookie, "alice-hardcover-token")).status).toBe(200);

      const bobRes = await connectHardcover(app, bob.cookie, "bob-hardcover-token");
      expect(bobRes.status).toBe(409);
      expect(await bobRes.text()).not.toContain("Internal Server Error");
    } finally {
      await pglite.exec(`DROP INDEX tmp_service_username_uniq`);
    }
  });
});

/**
 * Claiming a KoSync username is check-then-act: a SELECT for the name, then an
 * INSERT whose ON CONFLICT target is the per-USER unique index.
 * The username collision is a different constraint, so a claim that slips past
 * the SELECT lands on Postgres instead — and the loser of that race has to be
 * told the same thing the sequential loser is told.
 */
describe("PUT /api/credentials/kosync — username collisions", () => {
  it("refuses a username someone else already holds", async () => {
    const { app, auth } = createTestApp();
    const alice = await createSignedInUser(auth, "alice@example.test");
    const bob = await createSignedInUser(auth, "bob@example.test");

    expect((await claimKosync(app, alice.cookie, "shared-name")).status).toBe(200);

    const bobRes = await claimKosync(app, bob.cookie, "shared-name");
    expect(bobRes.status).toBe(409);
    expect(await bobRes.json()).toMatchObject({
      error: 'Username "shared-name" is already taken for kosync',
    });

    // And nothing was written for bob.
    const rows = await db
      .select({ userId: schema.kosyncCredentials.userId })
      .from(schema.kosyncCredentials);
    expect(rows.map((r) => r.userId)).toEqual([alice.id]);
  });

  it("gives the loser of a race the same 409, not a 500", async () => {
    // A real interleaving is not reproducible against a single-connection
    // PGlite — every request runs its SELECT and INSERT to completion before
    // the next one starts, so the SELECT always sees the winner's row. What is
    // reproducible is the state the race produces: a unique index on the
    // username that the SELECT above did not consult. A case-insensitive index
    // is exactly that shape, since the SELECT compares case-sensitively.
    //
    // Before the fix this reached storeCredential's catch-all and answered
    // "they conflict with an existing record" — a 409, but a different one, so
    // the message a user saw depended on whether they lost a race.
    await pglite.exec(
      `CREATE UNIQUE INDEX tmp_kosync_username_ci_uniq ON kosync_credentials (lower(username))`,
    );
    try {
      const { app, auth } = createTestApp();
      const alice = await createSignedInUser(auth, "alice@example.test");
      const bob = await createSignedInUser(auth, "bob@example.test");
      const carol = await createSignedInUser(auth, "carol@example.test");

      expect((await claimKosync(app, alice.cookie, "Shared-Name")).status).toBe(200);

      // bob's SELECT finds nothing ("shared-name" != "Shared-Name"), so the
      // refusal can only come from the INSERT.
      const raced = await claimKosync(app, bob.cookie, "shared-name");
      const sequential = await claimKosync(app, carol.cookie, "Shared-Name");

      expect(raced.status).toBe(409);
      expect(raced.status).toBe(sequential.status);
      expect(await raced.json()).toEqual({
        error: 'Username "shared-name" is already taken for kosync',
      });
      expect(await sequential.json()).toEqual({
        error: 'Username "Shared-Name" is already taken for kosync',
      });
    } finally {
      await pglite.exec(`DROP INDEX tmp_kosync_username_ci_uniq`);
    }
  });
});
