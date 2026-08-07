import { createHash, timingSafeEqual } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { kosyncCredentials, users } from "#db";
import type { Db } from "#db";
import { isUserBanned } from "./user-ban.js";

/**
 * Hash the value KOReader puts on the wire.
 *
 * sha256, not bcrypt. KOReader sends md5(password) as `x-auth-key`, so that
 * digest IS the bearer secret — the plaintext never reaches the server. A
 * password hash exists to make guessing a low-entropy human choice expensive,
 * and there is no human choice here to protect: an attacker holding the digest
 * is already authenticated, and one who does not hold it has 128 bits to
 * search. The work factor would only tax every sync request.
 *
 * Exported so the credential-minting route and its tests hash the same way.
 */
export function hashKosyncSecret(wireValue: string): string {
  return createHash("sha256").update(wireValue).digest("hex");
}

/** Constant-time comparison of two hex digests of equal length. */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  // timingSafeEqual throws on a length mismatch, which for two sha256 hex
  // digests can only mean malformed stored data.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Resolve KoSync credentials to a user id.
 *
 * One indexed lookup by username, then a constant-time digest comparison. The
 * old implementation ran bcrypt against a dummy hash on the miss path to
 * normalise timing; that is unnecessary now. Timing normalisation guards
 * against an attacker learning which usernames exist, and a fixed-cost sha256
 * over a high-entropy secret leaks nothing worth the complexity — whereas
 * bcrypt-per-attempt was itself a CPU exhaustion vector on an unauthenticated
 * endpoint.
 *
 * The join onto `users` is the ban check (libris-59m.6). This is the one
 * credential path that never touches Better Auth, so nothing else here would
 * ever consult the account's state: before the join, a banned user's KOReader
 * kept reading and writing progress under their id, and `POST
 * /kosync/users/auth` kept handing out a userkey they could pair a NEW device
 * with. Account deletion was already covered by the FK cascade; a ban was not.
 */
export async function validateKosyncCredentials(
  username: string,
  wireSecret: string,
  db: Db,
): Promise<string> {
  const [cred] = await db
    .select({
      userId: kosyncCredentials.userId,
      secretHash: kosyncCredentials.secretHash,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(kosyncCredentials)
    .innerJoin(users, eq(users.id, kosyncCredentials.userId))
    .where(eq(kosyncCredentials.username, username))
    .limit(1);

  // One indistinguishable refusal for all three causes. Telling a caller that
  // the password was right but the account is banned confirms both the
  // username and the credential.
  if (!cred || !digestsMatch(hashKosyncSecret(wireSecret), cred.secretHash) || isUserBanned(cred)) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  return cred.userId;
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
