/**
 * Opaque uploader references.
 *
 * The organized library is shared: every user sees every organized book and the
 * uploader's display label, and can narrow the list by uploader. What they must
 * NOT get is the uploader's raw `users.id` — that value is an attack input
 * (admin endpoints, session/force-logout targeting) and handing it to every
 * caller of `GET /api/library` turns the shared catalog into a user-id
 * enumeration primitive.
 *
 * So `uploader.id` in API responses is an HMAC of the user id keyed by
 * `API_SECRET_KEY`, not the user id. It is:
 *
 * - stable for the life of the install, so a saved filter keeps working;
 * - per-install, so refs from one server say nothing about another;
 * - one-way, so it cannot be replayed against any endpoint that takes a user id.
 *
 * Rotating `API_SECRET_KEY` invalidates saved uploader filters (they resolve to
 * "no such uploader" and return an empty page). Nothing else depends on them.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { books, type Db } from "#db";

/**
 * Scope the raw `books.created_by` a shared-library payload carries.
 *
 * The library list/sync/detail payloads spread every book column, so the owner's
 * user id rode along next to `uploader` — the same leak by another name. The UI
 * only ever compares this field against the caller's own id (to decide whether
 * to offer the owner actions), so a non-owner gets null and loses nothing.
 * Admins keep the real value; they can read user ids from the admin API anyway.
 */
export function scopeCreatedBy(
  createdBy: string,
  callerId: string,
  callerIsAdmin: boolean,
): string | null {
  return callerIsAdmin || createdBy === callerId ? createdBy : null;
}

/** Length in base64url characters (~132 bits) — collision risk is negligible. */
const REF_LENGTH = 22;

/** Derive the opaque reference an API response should carry for `userId`. */
export function uploaderRef(userId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`uploader:${userId}`)
    .digest("base64url")
    .slice(0, REF_LENGTH);
}

function refsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Map an opaque reference back to the user id it was derived from.
 *
 * Only users who own at least one organized book are candidates, which is
 * exactly the set the uploader facet advertises. Returns null when the
 * reference matches nobody — callers should then match no books rather than
 * fall back to treating the input as a raw user id.
 */
export async function resolveUploaderRef(
  db: Db,
  ref: string,
  secret: string,
): Promise<string | null> {
  if (!ref) return null;

  const owners = await db
    .selectDistinct({ id: books.createdBy })
    .from(books)
    .where(eq(books.status, "organized"));

  for (const owner of owners) {
    if (refsEqual(uploaderRef(owner.id, secret), ref)) return owner.id;
  }
  return null;
}
