/**
 * The last-admin lock, on a database where the lock can actually contend.
 *
 * `withLastAdminLock` serialises admin-shrinking operations with
 * `INSERT ... ON CONFLICT DO NOTHING` followed by `SELECT ... FOR UPDATE`. The
 * test that was supposed to prove that ran two calls through
 * `Promise.allSettled` against PGlite — one embedded backend on one connection,
 * where transactions are queued and a row lock can only ever block a *different*
 * session. Deleting the `for update` line left it green (libris-59m.31).
 *
 * These run against a real PostgreSQL server through `createDb`, the same
 * pooled postgres-js factory production uses, so the two transactions land on
 * two connections and the lock is load-bearing. Removing `for update` from
 * middleware/last-admin.ts turns "refuses the second of two concurrent
 * demotions" red: both transactions read two active admins and both commit,
 * leaving the install with none.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { eq, sql } from "drizzle-orm";
import { users } from "../src/db/schema.js";
import type { Db } from "../src/db/client.js";
import { withLastAdminLock } from "../src/middleware/last-admin.js";
import {
  announceSkip,
  createScratchDatabase,
  isPostgresReachable,
  SERVICES_ARE_REQUIRED,
  TEST_POSTGRES_URL,
  type ScratchDatabase,
} from "./backing-services.js";

const reachable = await isPostgresReachable();

if (!reachable) {
  const why =
    `PostgreSQL at ${TEST_POSTGRES_URL} is unreachable. The last-admin row lock CANNOT be ` +
    `verified on PGlite (one connection, so the lock never contends) — these 6 tests check ` +
    `nothing unless a real server is there. Start one with ` +
    `\`docker compose -f docker-compose.test.yml up -d --wait postgres\`, or point ` +
    `LIBRIS_TEST_POSTGRES_URL at your own.`;
  if (SERVICES_ARE_REQUIRED) {
    // In CI a missing service must not read as "nothing to check here" — that
    // is the exact shape of the coverage this suite exists to replace.
    throw new Error(`${why} CI is set, so this is a failure rather than a skip.`);
  }
  // Loud on purpose: a quiet skip in a terminal full of green is how the
  // previous version of this test went unnoticed for a release.
  announceSkip("last-admin-lock.postgres.test.ts", why);
}

describe.skipIf(!reachable)("withLastAdminLock against real PostgreSQL", () => {
  let scratch: ScratchDatabase;
  let db: Db;

  beforeAll(async () => {
    scratch = await createScratchDatabase("lastadmin");
    db = scratch.db;

    // Open the pool's connections up front. postgres-js connects lazily, so
    // without this the first transaction runs on the already-open connection
    // while the second is still doing a TCP + auth handshake — they never
    // overlap, and a test of what happens when they do proves nothing. Six
    // concurrent sleeps force six sockets to exist before any test starts.
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.05)`)));

    // Materialise the lock row. `withLastAdminLock` creates it with
    // `INSERT ... ON CONFLICT DO NOTHING`, and on the very FIRST call — when the
    // row does not exist yet — that insert is itself a serialiser: the second
    // transaction blocks on the unique index until the first commits. So the
    // first concurrent pair in any fresh database is serialised by the insert
    // rather than by the `FOR UPDATE`, and would pass with the lock deleted.
    // There is no admin here yet, so this call is a no-op that leaves the row.
    await withLastAdminLock(db, "nobody", async () => {});
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  afterEach(async () => {
    await db.delete(users);
  });

  async function seedAdmins(count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, (_, i) => `admin_${i}_${Date.now()}`);
    await db.insert(users).values(
      ids.map((id, i) => ({
        id,
        name: `Admin ${i}`,
        email: `${id}@example.test`,
        emailVerified: true,
        role: "admin",
      })),
    );
    return ids;
  }

  function demote(targetId: string) {
    return withLastAdminLock(db, targetId, async (tx) => {
      await tx.update(users).set({ role: "user" }).where(eq(users.id, targetId));
    });
  }

  async function activeAdminIds(): Promise<string[]> {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
    return rows.map(({ id }) => id).sort();
  }

  it("holds the second transaction outside the guard until the first commits", async () => {
    // The load-bearing observation, asserted directly rather than inferred from
    // a 409: the second caller must not READ the admin set until the first has
    // committed its write, because the whole bug class is two callers both
    // seeing two admins. Three admins here, so neither is refused and the only
    // thing under test is the ordering.
    const [first, second] = await seedAdmins(3);
    const order: string[] = [];

    const held = withLastAdminLock(db, first!, async (tx) => {
      order.push("first:inside");
      await tx.execute(sql`select pg_sleep(0.4)`);
      await tx.update(users).set({ role: "user" }).where(eq(users.id, first!));
      order.push("first:leaving");
    });

    // Give the first transaction a head start so it is unambiguously the lock
    // holder; without it the winner is a coin toss and the assertion below
    // would be about which one raced faster rather than about blocking.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const startedWaiting = Date.now();
    const waited = withLastAdminLock(db, second!, async (tx) => {
      order.push("second:inside");
      await tx.update(users).set({ role: "user" }).where(eq(users.id, second!));
    });

    await Promise.all([held, waited]);
    const blockedFor = Date.now() - startedWaiting;

    // Without `FOR UPDATE` this comes back as first:inside, second:inside,
    // first:leaving — the second caller walks straight in.
    expect(order).toEqual(["first:inside", "first:leaving", "second:inside"]);
    // And it did so by WAITING, not by being scheduled late.
    expect(blockedFor).toBeGreaterThan(200);
  });

  it("refuses the second of two concurrent demotions aimed at the last two admins", async () => {
    const [first, second] = await seedAdmins(2);

    const attempts = await Promise.allSettled([demote(first!), demote(second!)]);

    // Whichever transaction takes the row lock first commits; the other blocks
    // on it, then re-reads and sees a single active admin left.
    expect(attempts.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejection = attempts.find((a) => a.status === "rejected");
    expect(rejection).toMatchObject({ reason: { status: 409 } });
    expect(await activeAdminIds()).toHaveLength(1);
  });

  it("never lets a burst of concurrent demotions empty the admin set", async () => {
    // Six admins, six simultaneous self-demotions. Exactly five may succeed;
    // whoever is last must be refused, no matter how the transactions interleave.
    const ids = await seedAdmins(6);

    const attempts = await Promise.allSettled(ids.map((id) => demote(id)));

    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await activeAdminIds()).toHaveLength(1);
  });

  it("lets concurrent demotions through while a spare admin remains", async () => {
    // The guard must not have become "only one demotion may ever be in flight".
    const [a, b, , spare] = await seedAdmins(4);

    const attempts = await Promise.allSettled([demote(a!), demote(b!)]);

    expect(attempts.every(({ status }) => status === "fulfilled")).toBe(true);
    expect(await activeAdminIds()).toHaveLength(2);
    expect(await activeAdminIds()).toContain(spare!);
  });

  it("does not count a banned admin towards the surviving set", async () => {
    const [active, banned] = await seedAdmins(2);
    await db.update(users).set({ banned: true }).where(eq(users.id, banned!));

    // `active` is the only admin who can still sign in, so demoting them is the
    // last-admin case even though two rows carry role=admin.
    await expect(demote(active!)).rejects.toMatchObject({ status: 409 });
    expect(await activeAdminIds()).toEqual([active, banned].sort());
  });

  it("treats an admin whose ban has expired as active again", async () => {
    const [active, expired] = await seedAdmins(2);
    await db
      .update(users)
      .set({ banned: true, banExpires: new Date(Date.now() - 60_000) })
      .where(eq(users.id, expired!));

    // Two people can sign in as admin, so this demotion is ordinary.
    await expect(demote(active!)).resolves.toBeUndefined();
    expect(await activeAdminIds()).toEqual([expired]);
  });
});
