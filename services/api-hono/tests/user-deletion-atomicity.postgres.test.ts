/**
 * Why `reassignBooksOnRemoveUser` commits outside `lastAdminMiddleware`'s
 * transaction, and why that is the only arrangement that works (libris-cyg).
 *
 * The shape looks wrong at a glance. Both middlewares are mounted in sequence
 * on POST /api/auth/admin/remove-user (pinned by app.wiring.test.ts);
 * `lastAdminMiddleware` opens a transaction, takes `SELECT ... FOR UPDATE` on
 * the lock row and holds it across `next()`; and the reassignment inside that
 * `next()` uses `c.get("db")`, the pooled handle — so the books move and commit
 * on a different connection while the guard's transaction is still open. The
 * obvious repair is to thread the guard's `tx` into the reassignment so both
 * commit or neither does.
 *
 * It does not work, and this file is the demonstration rather than the
 * argument. Better Auth's drizzle adapter captured the pooled `Db` when
 * `createAuth` ran, so the DELETE inside `next()` is on a THIRD connection and
 * cannot see an uncommitted reassignment. `books.created_by` is NOT NULL ON
 * DELETE RESTRICT, so that DELETE checks `books` against its own snapshot,
 * still finds the target owning them, and fails — while the guard's transaction
 * sits open waiting for a `next()` that can now only return an error.
 *
 * The reassignment therefore has to be COMMITTED before Better Auth's delete
 * runs. That is a constraint imposed by where the write happens, not a
 * shortcut. The compensating update in lib/user-deletion.ts is what makes a
 * refused removal leave the install as it found it; the tests below pin both
 * halves of that reasoning so a future refactor towards "one transaction" runs
 * into them rather than into production.
 *
 * Real PostgreSQL, for the reason libris-8mx established: PGlite is a single
 * embedded backend behind an exclusive mutex, so a second connection is exactly
 * what it cannot provide, and the failure it produces is a deadlock rather than
 * the FK rejection the shipped topology actually sees.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { books, users } from "../src/db/schema.js";
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
    `PostgreSQL at ${TEST_POSTGRES_URL} is unreachable. These tests are about what happens ` +
    `when THREE connections are in play at once — the guard's transaction, Better Auth's ` +
    `pooled handle and the reassignment — which PGlite cannot represent at all. They check ` +
    `nothing unless a real server is there. Start one with ` +
    `\`docker compose -f docker-compose.test.yml up -d --wait postgres\`, or point ` +
    `LIBRIS_TEST_POSTGRES_URL at your own.`;
  if (SERVICES_ARE_REQUIRED) {
    throw new Error(`${why} CI is set, so this is a failure rather than a skip.`);
  }
  announceSkip("user-deletion-atomicity.postgres.test.ts", why);
}

describe.skipIf(!reachable)("the remove-user write topology, against real PostgreSQL", () => {
  let scratch: ScratchDatabase;
  let db: Db;

  beforeAll(async () => {
    scratch = await createScratchDatabase("removetx");
    db = scratch.db;

    // postgres-js connects lazily. Without pre-opening the pool the "other
    // connection" below would be a fresh TCP + auth handshake rather than a
    // genuinely concurrent session, which is not the thing under test.
    await Promise.all(Array.from({ length: 4 }, () => db.execute(sql`select pg_sleep(0.05)`)));
    // Materialise the lock row so `withLastAdminLock`'s ON CONFLICT insert is
    // not itself the serialiser on the first call.
    await withLastAdminLock(db, "nobody", async () => {});
  }, 60_000);

  afterEach(async () => {
    await db.delete(books);
    await db.delete(users);
  });

  async function seed(): Promise<{ adminId: string; targetId: string; bookId: string }> {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const adminId = `admin_${suffix}`;
    const targetId = `target_${suffix}`;
    await db.insert(users).values([
      {
        id: adminId,
        name: "Admin",
        email: `${adminId}@example.test`,
        emailVerified: true,
        role: "admin",
      },
      {
        id: targetId,
        name: "Target",
        email: `${targetId}@example.test`,
        emailVerified: true,
        role: "admin",
      },
    ]);
    const [book] = await db
      .insert(books)
      .values({ createdBy: targetId, title: "Dune" })
      .returning();
    return { adminId, targetId, bookId: book!.id };
  }

  /**
   * What Better Auth's deletion is, from this app's point of view: a statement
   * on a connection nobody here controls.
   *
   * `createAuth` hands `drizzleAdapter` the pooled `Db`, and the adapter keeps
   * it — so no transaction opened by a Hono middleware is ever in scope for it.
   * The `lock_timeout` turns "waits forever on a row lock" into a failure a test
   * can assert on instead of a hang.
   */
  async function deleteUserOnItsOwnConnection(userId: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.delete(users).where(eq(users.id, userId));
    });
  }

  /** postgres-js's error, which drizzle wraps in a DrizzleQueryError. */
  function sqlStateOf(error: unknown): string | undefined {
    for (let current = error; current instanceof Error; current = current.cause) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    return undefined;
  }

  it("refuses the reassignment threaded onto the guard's own transaction", async () => {
    const { adminId, targetId, bookId } = await seed();

    // THE NAIVE FIX, written out: move the books on the guard's `tx` so the
    // reassignment and the guard commit together.
    const outcome = await withLastAdminLock(db, targetId, async (tx) => {
      await tx.update(books).set({ createdBy: adminId }).where(eq(books.createdBy, targetId));
      await deleteUserOnItsOwnConnection(targetId);
    })
      .then(() => null)
      .catch((error: unknown) => error);

    // The delete cannot see the uncommitted reassignment, so RESTRICT fires.
    // This is the whole answer to "why not one transaction": there is no
    // transaction that contains both writes to begin with.
    expect(outcome).toBeInstanceOf(Error);
    // 23503 = foreign_key_violation. Named rather than message-matched: the
    // point is WHICH rule rejected it, and drizzle wraps the message.
    expect(sqlStateOf(outcome)).toBe("23503");

    // And nothing happened at all — the guard's transaction rolled back with it.
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    expect(book!.createdBy).toBe(targetId);
    expect(await db.select().from(users).where(eq(users.id, targetId))).toHaveLength(1);
  });

  it("accepts the deletion once the reassignment has committed, which is what ships", async () => {
    const { adminId, targetId, bookId } = await seed();

    // The shipped arrangement: reassignBooksOnRemoveUser writes through the
    // POOLED handle inside `next()`, so it commits immediately, and only then
    // does Better Auth's delete run.
    await db.update(books).set({ createdBy: adminId }).where(eq(books.createdBy, targetId));
    await withLastAdminLock(db, targetId, async () => {
      await deleteUserOnItsOwnConnection(targetId);
    });

    expect(await db.select().from(users).where(eq(users.id, targetId))).toHaveLength(0);
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    expect(book!.createdBy).toBe(adminId);
  });

  it("still refuses to remove the last active admin while books are in play", async () => {
    // The guard is not weakened by any of the above: it throws BEFORE running
    // its action, so the reassignment inside `next()` is never reached and
    // there is nothing to compensate for. This is why the compensating update
    // in lib/user-deletion.ts is a backstop for OTHER refusals — a 409 from
    // here never moves a book in the first place.
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const soleAdmin = `sole_${suffix}`;
    await db.insert(users).values({
      id: soleAdmin,
      name: "Sole",
      email: `${soleAdmin}@example.test`,
      emailVerified: true,
      role: "admin",
    });
    const [book] = await db
      .insert(books)
      .values({ createdBy: soleAdmin, title: "Never moves" })
      .returning();

    let actionRan = false;
    await expect(
      withLastAdminLock(db, soleAdmin, async () => {
        actionRan = true;
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(actionRan).toBe(false);
    const [stored] = await db.select().from(books).where(eq(books.id, book!.id));
    expect(stored!.createdBy).toBe(soleAdmin);
  });
});
