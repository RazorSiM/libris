import { createTestAuth, createTestDb } from "#db/test-utils";
import type { Db } from "#db/client";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import type { AppServices } from "../src/bootstrap.js";
import { createMemoryKVStore } from "../src/services/kv-store.js";

const testEnv: Env = {
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
  COOKIE_DOMAIN: "",
  LIBRIS_COOKIE_SECURE: "0",
  MIGRATIONS_PATH: "./migrations",
  TRUST_PROXY_HEADERS: "0",
  LIBRIS_TRUSTED_PROXIES: [],
  E2E_TEST: "",
  TEST_ROUTE_TOKEN: "integration-test-route-token-32-characters!!",
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

export async function createTestApp() {
  const testDb = await createTestDb();
  // PGlite and postgres-js Drizzle types differ structurally but are
  // compatible at runtime — cast so the rest of the app accepts it.
  const db = testDb.db as unknown as Db;

  const zeroCounts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 };
  const mockQueue = () => ({
    add: async () => ({}),
    name: "mock",
    getJobCounts: async () => zeroCounts,
    getJobs: async () => [],
  });
  const mockQueues = {
    bookDetected: mockQueue(),
    bookParseFile: mockQueue(),
    bookFetchMetadata: mockQueue(),
    bookOrganize: mockQueue(),
    close: async () => {},
  };

  const services: AppServices = {
    db,
    queues: mockQueues,
    redisStorage: createMemoryKVStore(),
    cacheStorage: createMemoryKVStore(),
    auth: createTestAuth(testDb.db, testEnv),
    shutdown: async () => {},
  };

  // Inject into singletons so code using getDb()/getQueues() works in tests
  const { __setTestDb } = await import("../src/services/db.js");
  const { __setTestQueues } = await import("../src/services/queue.js");
  __setTestDb(db);
  __setTestQueues(mockQueues as never);

  const { app } = createApp({ services, env: testEnv });
  // `db` is the cast the app wants; `testDb.db` is the real Drizzle/PGlite
  // handle, which is what the seedUser/seedAppPassword fixtures are typed
  // against. Both are the same object — returning each under its own type
  // saves every caller a cast.
  return { app, db, testDb: testDb.db, services, env: testEnv };
}

/**
 * Helper matching nitro-test-utils $fetchRaw interface for easy porting.
 */
export function createFetchHelper(app: ReturnType<typeof createApp>["app"]) {
  return async function $fetchRaw(
    path: string,
    opts?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      responseType?: "text";
    },
  ) {
    const url = `http://localhost${path}`;
    const init: RequestInit = {
      method: opts?.method || "GET",
      headers: path.startsWith("/__test/")
        ? { "x-test-token": testEnv.TEST_ROUTE_TOKEN! }
        : undefined,
    };

    if (opts?.headers) {
      init.headers = { ...(init.headers as Record<string, string>), ...opts.headers };
    }
    if (opts?.body) {
      init.body = JSON.stringify(opts.body);
      init.headers = {
        "content-type": "application/json",
        ...(init.headers as Record<string, string>),
      };
    }

    const res = await app.request(url, init);
    // 204 carries no body, and res.json() on an empty one throws "Unexpected
    // end of JSON input" — which surfaces as a parse error pointing at this
    // line rather than at the assertion that wanted the status code. Routes
    // that answer 204 are ordinary now (revoking an app password is one), so
    // the helper has to expect it.
    const data =
      opts?.responseType === "text"
        ? await res.text()
        : res.status === 204 || res.headers.get("content-length") === "0"
          ? null
          : await res.json();
    return { data, status: res.status, headers: res.headers };
  };
}

/**
 * Bootstrap the first admin and mint an app password for it.
 *
 * Replaces `POST /api/auth/setup`, which returned a raw key and doubled as
 * both account creation and credential minting. Those are two separate things
 * now: `/api/setup` creates the admin (and only while no user exists), and app
 * passwords come from Better Auth.
 *
 * The returned key works as `Authorization: Bearer`, as Basic's password and as
 * `x-api-key`.
 */
export const TEST_PASSWORD = "correct-horse-battery-staple";

/**
 * A replayable cookie header for an existing account.
 *
 * App passwords are scoped out of the admin, account and credential routes, so
 * a suite driving /api/jobs, /api/app-passwords or /api/credentials has to
 * authenticate the way a browser does. It is also the only way to keep a ROLE
 * test honest — with a Bearer key those routes 403 whoever owns them, so the
 * assertion would pass with no role check in place at all.
 */
export async function signInAs(
  services: AppServices,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const { headers } = await services.auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  return headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/**
 * An additional account: the person, a credential, and a session.
 *
 * Accounts come from the admin plugin — self-registration is disabled outright
 * — and a credential is something a person holds rather than something they
 * are, so all three are separate steps.
 *
 * Signs in rather than failing if the account already exists, so suites whose
 * /__test/cleanup preserves accounts can call this from a beforeEach.
 */
export async function createAccount(
  services: AppServices,
  options: { email: string; name?: string; role?: "user" | "admin" } = {
    email: "member@example.test",
  },
): Promise<{ userId: string; rawKey: string; cookie: string }> {
  const { email, name = email.split("@")[0], role = "user" } = options;

  let userId: string;
  try {
    const created = await services.auth.api.createUser({
      body: { email, password: TEST_PASSWORD, name, role },
    });
    userId = created.user.id;
  } catch {
    const signedIn = await services.auth.api.signInEmail({
      body: { email, password: TEST_PASSWORD },
    });
    userId = signedIn.user.id;
  }

  const created = await services.auth.api.createApiKey({ body: { userId, name: `${name}-key` } });
  return { userId, rawKey: created.key, cookie: await signInAs(services, email) };
}

export async function bootstrapAdmin(
  services: AppServices,
  $fetchRaw: ReturnType<typeof createFetchHelper>,
  options: { email?: string; name?: string } = {},
): Promise<{ userId: string; rawKey: string; cookie: string }> {
  const email = options.email ?? "integration-test@example.test";
  const password = TEST_PASSWORD;
  const { data, status } = await $fetchRaw("/api/setup", {
    method: "POST",
    body: { email, password, name: options.name ?? "Integration Admin" },
  });

  // 409 means the admin already exists. /__test/cleanup preserves accounts by
  // default — wiping them would sign an E2E run out mid-suite — so a per-test
  // beforeEach hits this on every run after the first. Sign in rather than
  // treating it as a failure.
  let userId: string;
  if (status === 201) {
    userId = (data as { id: string }).id;
  } else if (status === 409) {
    const signedIn = await services.auth.api.signInEmail({ body: { email, password } });
    userId = signedIn.user.id;
  } else {
    throw new Error(`Bootstrap failed with ${status}: ${JSON.stringify(data)}`);
  }
  const created = await services.auth.api.createApiKey({
    body: { userId, name: "integration-test-key" },
  });
  return { userId, rawKey: created.key, cookie: await signInAs(services, email, password) };
}
