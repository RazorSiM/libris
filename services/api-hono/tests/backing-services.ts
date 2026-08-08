/**
 * A throwaway PostgreSQL database for the handful of tests PGlite cannot host.
 *
 * PGlite is one embedded backend on one connection. Transactions against it are
 * queued, so a row lock can never contend and a "concurrent" test always runs
 * its two halves in sequence — which is how the last-admin `FOR UPDATE` shipped
 * with a test that stayed green when the lock was deleted.
 *
 * Anything whose subject IS the concurrency has to run against a real server on
 * real, separate connections. This module creates a uniquely named database,
 * applies the migration chain into it, and drops it afterwards, so several
 * suites (and several checkouts) can share one server without colliding.
 *
 * Everything here goes through `createDb` rather than importing `postgres`
 * directly: postgres-js is drizzle-orm's own dependency, not a declared one of
 * this package, so it is not resolvable from here.
 */
import { sql } from "drizzle-orm";
import type Redis from "ioredis";
import { createDb, type Db } from "../src/db/client.js";
import { readMigrationDirs } from "../src/db/test-utils.js";

/**
 * Where the throwaway databases are created.
 *
 * Defaults to docker-compose.test.yml's published mapping (see docs/testing.md).
 * CI's unit-test job runs its own `postgres:17` service on the default port and
 * sets this explicitly.
 */
export const TEST_POSTGRES_URL =
  process.env.LIBRIS_TEST_POSTGRES_URL ??
  "postgres://libris_test:libris_test@localhost:5433/libris_test";

/**
 * Where a Redis-backed test should connect.
 *
 * Same arrangement: docker-compose.test.yml publishes redis on 6380 locally,
 * CI's service uses the default port.
 */
export const TEST_REDIS_URL = process.env.LIBRIS_TEST_REDIS_URL ?? "redis://localhost:6380";

/**
 * Whether a suite that needs a real backing service may skip when it is absent.
 *
 * On a developer's machine skipping is right — not everyone has
 * docker-compose.test.yml up. In CI it is exactly wrong: a silently skipped
 * concurrency test is the failure mode this bead exists to remove, so there a
 * missing service is a hard failure.
 */
export const SERVICES_ARE_REQUIRED = Boolean(process.env.CI);

/**
 * Say — visibly — that a suite checked nothing.
 *
 * `console.warn` at module scope does NOT reach the terminal: Vitest's reporter
 * only surfaces console output it can attach to a running test, so a file that
 * skips every test prints nothing but "8 skipped" among hundreds of passes.
 * That is indistinguishable from coverage, which is the whole failure mode
 * this announcement exists to remove. `process.stderr.write` bypasses the
 * capture.
 */
export function announceSkip(file: string, why: string): void {
  process.stderr.write(`\n[SKIPPED - NOT COVERED] ${file}\n${why}\n\n`);
}

/** Close a Drizzle handle's underlying postgres-js pool. */
async function closeDb(db: Db): Promise<void> {
  const client = (db as unknown as { $client?: { end?: (o?: object) => Promise<void> } }).$client;
  await client?.end?.({ timeout: 5 });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function isPostgresReachable(): Promise<boolean> {
  const db = createDb(TEST_POSTGRES_URL);
  try {
    await withTimeout(db.execute(sql`select 1`), 5_000, "postgres probe");
    return true;
  } catch {
    return false;
  } finally {
    await closeDb(db).catch(() => {});
  }
}

/** A connected ioredis client against the test server, keyed to one suite. */
export async function connectTestRedis(): Promise<Redis> {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(TEST_REDIS_URL, {
    connectTimeout: 3_000,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  // ioredis logs "Unhandled error event" when nothing is listening, which turns
  // the reachability probe's expected failure into alarming output. Commands
  // still reject, so a real mid-run failure is not hidden by this.
  redis.on("error", () => {});
  await withTimeout(redis.connect(), 5_000, "redis connect");
  return redis;
}

export async function isRedisReachable(): Promise<boolean> {
  let redis: Redis | undefined;
  try {
    redis = await connectTestRedis();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    redis?.disconnect();
  }
}

export interface ScratchDatabase {
  db: Db;
  url: string;
  drop: () => Promise<void>;
}

/**
 * Create a fresh, fully migrated database and hand back a pooled Drizzle handle.
 *
 * The handle comes from `createDb`, the same factory production uses, so the
 * pool (`max: 20`) is the real one — which is the whole point: two overlapping
 * transactions land on two different connections.
 */
export async function createScratchDatabase(label: string): Promise<ScratchDatabase> {
  const name = `libris_test_${label}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

  const admin = createDb(TEST_POSTGRES_URL);
  try {
    await admin.execute(sql.raw(`CREATE DATABASE "${name}"`));
  } finally {
    await closeDb(admin);
  }

  const url = new URL(TEST_POSTGRES_URL);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());

  for (const migration of readMigrationDirs()) {
    for (const statement of migration.sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await db.execute(sql.raw(trimmed));
    }
  }

  return {
    db,
    url: url.toString(),
    drop: async () => {
      await closeDb(db);
      const dropper = createDb(TEST_POSTGRES_URL);
      try {
        await dropper.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
      } finally {
        await closeDb(dropper);
      }
    },
  };
}
