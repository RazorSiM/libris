import { count, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { books } from "#db";
import type { AppVariables } from "../context.js";
import { sessionHeaders } from "../shared/request-ip.js";
import { getLogger } from "./logger.js";

const logger = getLogger("user-deletion");

interface RemoveUserBody {
  userId?: unknown;
}

function hasAdminRole(role: unknown): boolean {
  return typeof role === "string" && role.split(",").includes("admin");
}

/**
 * Reassign a departing user's books to the acting admin, before Better Auth
 * deletes them.
 *
 * `books.created_by` is NOT NULL with `ON DELETE RESTRICT` (db/schema.ts): a
 * book always has an owner, and deleting a person must neither delete the
 * household's books nor orphan them. Better Auth's `internalAdapter.deleteUser`
 * issues three separate UN-TRANSACTED statements — delete sessions, delete
 * accounts, delete user — so without this the third statement hits the
 * constraint and throws AFTER the first two have already committed. The result
 * was a 500, a surviving user row with no credential, and an admin with no way
 * to tell from the response that anything half-happened. Every retry 500'd the
 * same way, and recovery meant an admin running set-user-password to rebuild
 * the credential.
 *
 * The fix is a PRECONDITION, not error mapping: once no book points at the
 * target, the RESTRICT constraint cannot fire, so the un-transacted deletion
 * has nothing left to fail on. `books` is the only RESTRICT reference to
 * `users` in the schema; everything else cascades or sets null.
 *
 * Reassignment rather than refusal, because refusing would make delete-user
 * unusable: a Libris library is shared, there is no UI for handing a book to
 * someone else, and the books must not leave with the person. The acting admin
 * is the recipient — Better Auth refuses self-removal
 * (`YOU_CANNOT_REMOVE_YOURSELF`), so they are always someone other than the
 * target.
 *
 * ── Why this commits OUTSIDE lastAdminMiddleware's transaction ───────────────
 *
 * Both middlewares wrap this path, `lastAdminMiddleware` first (pinned by
 * app.wiring.test.ts). It opens a transaction, takes `SELECT ... FOR UPDATE` on
 * the lock row and holds it across `next()` — and this middleware, inside that
 * `next()`, writes through `c.get("db")`, the pooled handle. So the books move
 * and commit on a different connection while the guard's transaction is still
 * open, which reads like a hole in the guard's atomicity. It is deliberate, and
 * threading the guard's `tx` in here is not a stricter version of it but a
 * broken one:
 *
 *   Better Auth's write is on a THIRD connection. `createAuth` hands
 *   `drizzleAdapter` the pooled `Db` and the adapter keeps it, so its DELETE
 *   cannot see an uncommitted reassignment. `books.created_by` is ON DELETE
 *   RESTRICT, so that DELETE checks `books` against its own snapshot, still
 *   finds the target owning them, and fails with SQLSTATE 23503 — while the
 *   guard's transaction sits open waiting for a `next()` that can now only
 *   return an error. tests/user-deletion-atomicity.postgres.test.ts runs
 *   exactly that and asserts the rejection, so a future "let's make this one
 *   transaction" refactor meets a red test rather than production.
 *
 * The reassignment therefore HAS to be committed before Better Auth's delete
 * runs. What covers a refusal is split in two, and only the second half is the
 * compensation below:
 *
 *  - The guard's own 409 never reaches here at all. `withLastAdminLock` throws
 *    before running its action, so `next()` is never called and no book moves
 *    (user-deletion.test.ts, "never reaches the reassignment when the guard
 *    refuses").
 *  - Anything Better Auth itself refuses lands after the reassignment has
 *    committed, and the compensating update below is what returns the books.
 *
 * Residual risk, stated rather than hidden: a process that dies between the
 * reassignment and the compensation leaves the books with the acting admin.
 * That is the weakness of compensation-after-commit, and it is not removable in
 * this topology. Its consequence is bounded to the point of being benign — the
 * books stay in the shared library owned by an existing admin, which is exactly
 * the state a SUCCESSFUL removal produces. Nothing is lost, orphaned or hidden;
 * at worst one row's `created_by` names the wrong housemate after a crash
 * during a removal that had already failed.
 */
export const reassignBooksOnRemoveUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  c,
  next,
) => {
  if (c.req.method !== "POST") {
    await next();
    return;
  }

  let body: RemoveUserBody;
  try {
    body = (await c.req.raw.clone().json()) as RemoveUserBody;
  } catch {
    await next();
    return;
  }

  const targetUserId = body.userId;
  if (typeof targetUserId !== "string") {
    await next();
    return;
  }

  // Let Better Auth produce its own unauthorized/forbidden response rather than
  // moving books on behalf of a caller it is about to refuse.
  //
  // sessionHeaders, not c.req.raw.headers: this was a fourth copy of the
  // spoofable-client-address defect, still live. This middleware runs BEFORE
  // the /api/auth/* catch-all — the only place app.ts overwrote the private
  // client-IP header — so an attacker's own `x-libris-client-ip` reached Better
  // Auth here and became the address its records and its limiter saw.
  const session = await c.get("auth").api.getSession({ headers: sessionHeaders(c) });
  const actingUserId = session?.user.id;
  if (!actingUserId || !hasAdminRole(session?.user.role)) {
    await next();
    return;
  }

  // Better Auth answers 400 YOU_CANNOT_REMOVE_YOURSELF for this, and moving the
  // books first would be a pointless self-assignment that leaves the constraint
  // armed. Stand aside and let it refuse.
  if (actingUserId === targetUserId) {
    await next();
    return;
  }

  const db = c.get("db");
  const [owned] = await db
    .select({ n: count() })
    .from(books)
    .where(eq(books.createdBy, targetUserId));

  if ((owned?.n ?? 0) === 0) {
    await next();
    return;
  }

  const reassigned = await db
    .update(books)
    .set({ createdBy: actingUserId })
    .where(eq(books.createdBy, targetUserId))
    .returning({ id: books.id });

  logger.info(
    `Reassigned ${reassigned.length} book(s) from removed user ${targetUserId} to admin ${actingUserId}`,
  );

  await next();

  // Compensate if the removal did not happen after all. The reassignment
  // cannot be inside Better Auth's deletion — it writes through its own
  // adapter, outside any transaction we control — so undoing it is the only
  // way a refused removal leaves the install exactly as it found it. Better
  // Auth still owns the response, so the admin sees its refusal and not ours.
  if (c.res.status >= 400) {
    // By id, not by owner: the acting admin's own books must not be swept up.
    await db
      .update(books)
      .set({ createdBy: targetUserId })
      .where(
        inArray(
          books.id,
          reassigned.map((b) => b.id),
        ),
      );
    logger.warn(
      `Removal of user ${targetUserId} failed with ${c.res.status}; returned ${reassigned.length} book(s)`,
    );
  }
};
