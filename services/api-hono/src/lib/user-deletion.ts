import { count, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { books } from "#db";
import type { AppVariables } from "../context.js";
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
 * the credential. libris-59m.21.
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
 * Ordering with `lastAdminMiddleware`: both wrap the same path. This one only
 * needs to run before Better Auth's handler; it does not participate in the
 * last-admin invariant.
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
  const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
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
