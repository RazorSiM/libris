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
  API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
  BETTER_AUTH_URL: "",
  COOKIE_DOMAIN: "",
  MIGRATIONS_PATH: "./migrations",
  TRUST_PROXY_HEADERS: "0",
  E2E_TEST: "",
  LOG_LEVEL: "info",
  LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
  LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
  LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 30,
  LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
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
  return { app, db, services, env: testEnv };
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
    const init: RequestInit = { method: opts?.method || "GET" };

    if (opts?.headers) init.headers = opts.headers;
    if (opts?.body) {
      init.body = JSON.stringify(opts.body);
      init.headers = {
        "content-type": "application/json",
        ...(init.headers as Record<string, string>),
      };
    }

    const res = await app.request(url, init);
    const data = opts?.responseType === "text" ? await res.text() : await res.json();
    return { data, status: res.status, headers: res.headers };
  };
}
