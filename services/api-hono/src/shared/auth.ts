import { createHash, randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import * as Iron from "iron-webcrypto";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { books } from "#db";
import type { Db } from "#db";
import type { AppVariables } from "../context.js";

/** Cost factor for bcrypt hashing — used for both key creation and verification */
export const BCRYPT_ROUNDS = 12;

/** MD5 hex digest — used by KOReader's KoSync client for password hashing */
export function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/** Length of the plaintext prefix stored alongside each key hash */
export const KEY_PREFIX_LENGTH = 8;

/** Prefix to distinguish sealed tokens from bcrypt hashes in passwordHash column */
export const SEALED_PREFIX = "sealed:";

/**
 * Generate a random API key and its bcrypt hash.
 * Returns the raw hex key, the key prefix (for fast lookup), and the hash.
 */
export async function generateApiKey(): Promise<{
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
}> {
  const rawKey = randomBytes(32).toString("hex");
  const keyPrefix = rawKey.substring(0, KEY_PREFIX_LENGTH);
  const keyHash = await hash(rawKey, BCRYPT_ROUNDS);
  return { rawKey, keyPrefix, keyHash };
}

// ── Authorization helpers ──────────────────────────────────────────────

/**
 * Whether the current user is an admin.
 *
 * Derived from the role the middleware read off the Better Auth session, never
 * stored alongside it — being an admin is a property of the person, and the
 * role field is the only place that fact lives.
 */
export function isAdmin(c: Context<{ Variables: AppVariables }>): boolean {
  return c.get("role") === "admin";
}

/** Throw 403 if the current user is not an admin. */
export function requireAdmin(c: Context<{ Variables: AppVariables }>): void {
  if (!isAdmin(c)) {
    throw new HTTPException(403, { message: "Admin access required" });
  }
}

/** Get the current user's id. Throws 401 if not authenticated. */
export function getUserId(c: Context<{ Variables: AppVariables }>): string {
  const id = c.get("userId");
  if (!id) throw new HTTPException(401, { message: "Authentication required" });
  return id;
}

/**
 * Verify the current user owns the book or is an admin.
 * Throws 404 if the book doesn't exist, 403 if not authorized.
 */
export async function requireBookOwnership(
  c: Context<{ Variables: AppVariables }>,
  db: Db,
  bookId: string,
): Promise<void> {
  const [book] = await db
    .select({ createdBy: books.createdBy })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!book) throw new HTTPException(404, { message: "Book not found" });
  if (isAdmin(c)) return;
  // No unowned-book branch: created_by is NOT NULL since the cutover migration,
  // so "only admin can modify unowned books" was unreachable.
  if (book.createdBy !== getUserId(c)) {
    throw new HTTPException(403, { message: "Only the book owner or admin can modify this book" });
  }
}

// ── Reversible token sealing (iron-webcrypto) ───────────────────────────
// Uses the Iron protocol (same as hapi) for authenticated encryption.
// Handles key derivation, IV, auth tags, and versioning internally.

/**
 * Seal a token for storage. Returns a prefixed string ("sealed:...")
 * that can be stored in the passwordHash column and distinguished from bcrypt hashes.
 */
export async function sealToken(token: string, secret: string): Promise<string> {
  const sealed = await Iron.seal(token, secret, Iron.defaults);
  return SEALED_PREFIX + sealed;
}

/**
 * Unseal a token previously sealed with sealToken().
 * Returns null if unsealing fails (wrong key, tampered, etc.).
 */
export async function unsealToken(stored: string, secret: string): Promise<string | null> {
  if (!stored.startsWith(SEALED_PREFIX)) return null;
  try {
    const sealed = stored.slice(SEALED_PREFIX.length);
    return (await Iron.unseal(sealed, secret, Iron.defaults)) as string;
  } catch {
    return null;
  }
}
