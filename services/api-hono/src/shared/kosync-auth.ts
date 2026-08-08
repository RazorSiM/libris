import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { kosyncCredentials, users } from "#db";
import type { Db } from "#db";
import { getLogger } from "../lib/logger.js";
import { isUserBanned } from "./user-ban.js";

const logger = getLogger("kosync-auth");

/**
 * How a KoSync secret is stored, and why it is neither a bare digest nor bcrypt.
 *
 * WHAT THE CREDENTIAL ACTUALLY IS
 *
 * KOReader sends `md5(password)` as `x-auth-key`, so that digest is the bearer
 * secret and the plaintext never reaches the server. It is tempting to conclude
 * that the stored value therefore covers a 128-bit random secret and needs no
 * work factor. It does not. `password` is a string the user typed into the
 * Libris settings form and typed again into KOReader, and md5 is an unkeyed,
 * unsalted, fixed function that adds no entropy: `H(md5(pw))` is exactly as
 * guessable as `H(pw)`. The old docstring's "128 bits to search" confused md5's
 * OUTPUT space with the space an offline attacker actually enumerates, which is
 * a human password space. That claim was the load-bearing part of the argument
 * for a bare unsalted sha256, and it was wrong.
 *
 * WHY NOT JUST USE A PASSWORD HASH
 *
 * The other half of the old rationale is right. This digest is verified on an
 * unauthenticated endpoint that KOReader hits on every progress read and write,
 * so a per-request work factor is a CPU-exhaustion lever anyone can pull for
 * free. bcrypt here taxes the server far more reliably than it
 * taxes an attacker with a GPU.
 *
 * THE SCHEME
 *
 * Both constraints are satisfied by moving the secret OUT of the database
 * instead of making it expensive to guess:
 *
 *     v1$<salt-hex>$<HMAC-SHA256(pepper, "<salt-hex>:<wire-value>")>
 *
 * - The pepper is derived from API_SECRET_KEY, which lives in the environment
 *   and never in the database. A database-only disclosure -- backup leak, SQL
 *   injection, restored snapshot -- yields nothing to compute candidates
 *   against. That is the threat this change exists for.
 * - The per-row salt costs nothing, because the lookup below is by USERNAME,
 *   not by the digest. Two users who picked the same password get different
 *   stored values, so even a full compromise cannot amortise one wordlist pass
 *   across every row.
 * - The cost is two HMAC-SHA256 over short inputs. Strictly cheaper than the
 *   bcrypt this replaced and indistinguishable from the sha256 it replaces, so
 *   the unauthenticated path stays a fixed, negligible cost.
 *
 * WHAT IT DOES NOT PROTECT AGAINST
 *
 * An attacker who obtains BOTH the database and API_SECRET_KEY -- host
 * compromise, a leaked env file, an image with the secret baked in. Then each
 * guess is one fast HMAC and a wordlist password falls, per row. The residual
 * mitigations are the 12-character minimum in shared/validation.ts, the salt
 * (no cross-row amortisation), and the settings form offering to generate the
 * credential so it need not be human-chosen at all. Rotating API_SECRET_KEY
 * invalidates every stored KoSync secret and forces a re-pair; that is the
 * intended blast radius of a pepper.
 */
const V1_PREFIX = "v1$";
const SALT_BYTES = 16;

/**
 * Domain separation for the pepper.
 *
 * API_SECRET_KEY also seals Hardcover tokens (Iron, which derives its own
 * subkeys via PBKDF2). Deriving a KoSync-specific key here means the two uses
 * can never be made to interact, and it costs one HMAC over a 27-byte string.
 */
const PEPPER_INFO = "libris:kosync-credential:v1";

function derivePepper(serverSecret: string): Buffer {
  return createHmac("sha256", serverSecret).update(PEPPER_INFO).digest();
}

function v1Mac(wireValue: string, saltHex: string, serverSecret: string): string {
  return createHmac("sha256", derivePepper(serverSecret))
    .update(`${saltHex}:${wireValue}`)
    .digest("hex");
}

/**
 * The pre-v1 format: a bare, unsalted, unpeppered sha256 of the wire value.
 *
 * Exported so tests can seed a row exactly as an install upgrading from an
 * older build would have one. Never call it to WRITE a credential.
 */
export function legacyKosyncSecretHash(wireValue: string): string {
  return createHash("sha256").update(wireValue).digest("hex");
}

/**
 * Mint the stored record for a wire secret.
 *
 * Self-describing on purpose, in the manner of bcrypt and PHC strings: the
 * version and salt travel inside the existing `secret_hash` text column, so
 * introducing them needed no migration and no column that would have to stay
 * nullable forever to describe legacy rows.
 *
 * Exported so the credential-minting route and its tests hash the same way.
 */
export function hashKosyncSecret(wireValue: string, serverSecret: string): string {
  const saltHex = randomBytes(SALT_BYTES).toString("hex");
  return `${V1_PREFIX}${saltHex}$${v1Mac(wireValue, saltHex, serverSecret)}`;
}

/** Constant-time comparison of two hex digests. Unequal lengths are a mismatch. */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  // timingSafeEqual throws on a length mismatch, and Buffer.from(..., "hex")
  // silently truncates on malformed input, so the length check is doing real
  // work rather than restating an invariant.
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export interface KosyncVerification {
  ok: boolean;
  /** True when the row verified against the pre-v1 format and should be rewritten. */
  needsRehash: boolean;
}

/**
 * Verify a wire secret against a stored record of either format.
 *
 * Rows written before the pepper landed are a bare sha256 hex digest with no
 * version prefix. They still verify, so nobody's KOReader stops syncing across
 * the upgrade; the caller rewrites them on the way past.
 */
export function verifyKosyncSecret(
  wireValue: string,
  stored: string,
  serverSecret: string,
): KosyncVerification {
  if (stored.startsWith(V1_PREFIX)) {
    const [saltHex, mac] = stored.slice(V1_PREFIX.length).split("$");
    if (!saltHex || !mac) return { ok: false, needsRehash: false };
    return { ok: digestsMatch(v1Mac(wireValue, saltHex, serverSecret), mac), needsRehash: false };
  }

  const ok = digestsMatch(legacyKosyncSecretHash(wireValue), stored);
  return { ok, needsRehash: ok };
}

/**
 * Resolve KoSync credentials to a user id.
 *
 * One indexed lookup by username, then a constant-time comparison of a single
 * HMAC. The old implementation ran bcrypt against a dummy hash on the miss path
 * to normalise timing; that is unnecessary now. Timing normalisation guards
 * against an attacker learning which usernames exist, and a fixed-cost MAC
 * leaks nothing worth the complexity -- whereas bcrypt-per-attempt was itself a
 * CPU exhaustion vector on an unauthenticated endpoint.
 *
 * The join onto `users` is the ban check. This is the one
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
  serverSecret: string,
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

  const verification = cred
    ? verifyKosyncSecret(wireSecret, cred.secretHash, serverSecret)
    : { ok: false, needsRehash: false };

  // One indistinguishable refusal for all three causes. Telling a caller that
  // the password was right but the account is banned confirms both the
  // username and the credential.
  if (!cred || !verification.ok || isUserBanned(cred)) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  // Upgrade in place, only after the credential AND the ban check passed, so a
  // banned account's row is not touched. This is what spares existing KoSync
  // users a credential reset: the first sync request their device makes after
  // the deploy rewrites the row in the peppered format, with no user action.
  // A failed rewrite must not lock the device out -- it only means the row
  // stays legacy and the next request tries again.
  if (verification.needsRehash) {
    try {
      await db
        .update(kosyncCredentials)
        .set({ secretHash: hashKosyncSecret(wireSecret, serverSecret) })
        .where(eq(kosyncCredentials.userId, cred.userId));
    } catch (err) {
      logger
        .withMetadata({ error: String(err) })
        .warn("Failed to upgrade a legacy KoSync secret hash");
    }
  }

  return cred.userId;
}

export async function requireKosyncAuth(
  headers: { username: string | undefined; password: string | undefined },
  db: Db,
  serverSecret: string,
): Promise<string> {
  if (!headers.username || !headers.password) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  return validateKosyncCredentials(headers.username, headers.password, db, serverSecret);
}
