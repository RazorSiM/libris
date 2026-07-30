import { compare } from "bcryptjs";
import { HTTPException } from "hono/http-exception";
import { and, eq } from "drizzle-orm";
import { serviceCredentials } from "#db";
import type { Db } from "#db";
import { DUMMY_HASH, md5, safeCompare } from "./auth.js";

/**
 * Try bcrypt comparison with md5(value) first, then raw value as fallback.
 * KOReader sends md5(password) as x-auth-key, so DB stores bcrypt(md5(password)).
 * Trying md5 first avoids a wasted bcrypt round on the common KOReader path.
 * The raw fallback allows curl/direct API users to send the plaintext password.
 */
async function compareWithMd5Fallback(password: string, hash: string): Promise<boolean> {
  if (await compare(md5(password), hash)) return true;
  return compare(password, hash);
}

/**
 * Validate KoSync credentials against service_credentials in DB.
 * Used by both the auth middleware (header-based) and the auth.post route (body-based).
 *
 * Looks up by (service, username) for efficient per-user matching, then verifies
 * the password. Returns the associated apiKeyId so the caller can set user identity.
 */
export async function validateKosyncCredentials(
  username: string,
  password: string,
  db: Db,
): Promise<string> {
  const [cred] = await db
    .select()
    .from(serviceCredentials)
    .where(and(eq(serviceCredentials.service, "kosync"), eq(serviceCredentials.username, username)))
    .limit(1);

  if (!cred) {
    // Run bcrypt against dummy hash to normalize timing even when no creds exist
    await compareWithMd5Fallback(password, DUMMY_HASH);
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const usernameMatch = safeCompare(username, cred.username);
  // Always run bcrypt to normalize timing regardless of username correctness
  const valid = await compareWithMd5Fallback(
    password,
    usernameMatch ? cred.passwordHash : DUMMY_HASH,
  );
  if (!valid || !usernameMatch) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  if (!cred.apiKeyId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  return cred.apiKeyId;
}

export async function requireKosyncAuth(
  headers: { username: string | undefined; password: string | undefined },
  db: Db,
): Promise<string> {
  if (!headers.username || !headers.password) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  return validateKosyncCredentials(headers.username, headers.password, db);
}
